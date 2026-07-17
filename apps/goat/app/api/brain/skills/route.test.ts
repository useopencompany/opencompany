import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { listGoatBrainSkillCatalog } from "@/lib/brain-skills";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({ currentGoatUser: vi.fn() }));
vi.mock("@/lib/brain-skills", () => ({ listGoatBrainSkillCatalog: vi.fn() }));

describe("GET /api/brain/skills", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires authentication", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue(null as never);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns the active Brain's safe catalog", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue({
      activeBrain: { id: "brain_1" },
    } as never);
    vi.mocked(listGoatBrainSkillCatalog).mockResolvedValue([
      {
        brainRef: "brain_1",
        id: "coding-work",
        name: "Coding work",
        description: "How coding work should happen.",
      },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      skills: [
        {
          brainRef: "brain_1",
          id: "coding-work",
          name: "Coding work",
          description: "How coding work should happen.",
        },
      ],
    });
    expect(listGoatBrainSkillCatalog).toHaveBeenCalledWith("brain_1");
  });
});
