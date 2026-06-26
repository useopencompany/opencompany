import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentConnectorUser,
  loadConnectorOrganizationForUser,
  newConnectorOrganizationId,
} from "@/lib/auth";
import { saveConnectorOrganizationAction } from "./actions";

const dbState = vi.hoisted(() => ({
  slugOwner: null as { id: string } | null,
  insertedValues: [] as Record<string, unknown>[],
  updatedSets: [] as Record<string, unknown>[],
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentConnectorUser: vi.fn(),
  currentConnectorOrganization: vi.fn(),
  loadConnectorOrganizationForUser: vi.fn(),
  newConnectorOrganizationId: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  dbState.slugOwner = null;
  dbState.insertedValues = [];
  dbState.updatedSets = [];
  vi.mocked(currentConnectorUser).mockResolvedValue(connectorUser());
  vi.mocked(newConnectorOrganizationId).mockReturnValue("corg_new");
  vi.mocked(getDb).mockReturnValue(createSetupDb());
});

describe("connector setup organization actions", () => {
  it("creates a connector organization and owner membership", async () => {
    vi.mocked(loadConnectorOrganizationForUser).mockResolvedValue(null);

    const result = await saveConnectorOrganizationAction(
      { error: null, organization: null },
      formData({ name: "Acme", slug: "acme" }),
    );

    expect(result).toEqual({
      error: null,
      organization: {
        id: "corg_new",
        name: "Acme",
        slug: "acme",
        setupCompletedAt: null,
      },
    });
    expect(dbState.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "corg_new",
          name: "Acme",
          slug: "acme",
          createdByUserId: "cusr_123",
        }),
        expect.objectContaining({
          organizationId: "corg_new",
          userId: "cusr_123",
          role: "owner",
        }),
      ]),
    );
  });

  it("updates the current connector organization", async () => {
    vi.mocked(loadConnectorOrganizationForUser).mockResolvedValue({
      organization: connectorOrganization({ id: "corg_existing", name: "Old", slug: "old" }),
      membership: connectorMembership({ organizationId: "corg_existing" }),
    });

    const result = await saveConnectorOrganizationAction(
      { error: null, organization: null },
      formData({ name: "Acme Updated", slug: "acme-updated" }),
    );

    expect(result).toEqual({
      error: null,
      organization: {
        id: "corg_existing",
        name: "Acme Updated",
        slug: "acme-updated",
        setupCompletedAt: null,
      },
    });
    expect(dbState.updatedSets).toEqual([
      expect.objectContaining({ name: "Acme Updated", slug: "acme-updated" }),
    ]);
  });

  it("rejects a slug owned by another connector organization", async () => {
    vi.mocked(loadConnectorOrganizationForUser).mockResolvedValue(null);
    dbState.slugOwner = { id: "corg_other" };

    const result = await saveConnectorOrganizationAction(
      { error: null, organization: null },
      formData({ name: "Acme", slug: "acme" }),
    );

    expect(result).toEqual({ error: "That slug is already taken.", organization: null });
    expect(dbState.insertedValues).toEqual([]);
    expect(dbState.updatedSets).toEqual([]);
  });
});

function createSetupDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (dbState.slugOwner ? [dbState.slugOwner] : [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        dbState.insertedValues.push(values);
        if ("name" in values) {
          return {
            returning: vi.fn(async () => [
              connectorOrganization({
                id: String(values.id),
                name: String(values.name),
                slug: String(values.slug),
              }),
            ]),
          };
        }

        return {
          onConflictDoUpdate: vi.fn(async () => undefined),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: Record<string, unknown>) => {
        dbState.updatedSets.push(set);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [
              connectorOrganization({
                id: "corg_existing",
                name: String(set.name),
                slug: String(set.slug),
              }),
            ]),
          })),
        };
      }),
    })),
  } as never;
}

function formData(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function connectorUser() {
  return {
    id: "cusr_123",
    workosUserId: "workos_123",
    email: "founder@example.com",
    firstName: "Founder",
    lastName: "Person",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function connectorOrganization(overrides: Partial<ReturnType<typeof baseConnectorOrganization>>) {
  return { ...baseConnectorOrganization(), ...overrides };
}

function baseConnectorOrganization() {
  return {
    id: "corg_123",
    name: "Acme",
    slug: "acme",
    createdByUserId: "cusr_123",
    setupCompletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function connectorMembership(overrides: Partial<ReturnType<typeof baseConnectorMembership>>) {
  return { ...baseConnectorMembership(), ...overrides };
}

function baseConnectorMembership() {
  return {
    organizationId: "corg_123",
    userId: "cusr_123",
    role: "owner" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}
