import { describe, expect, it } from "vitest";
import { GMAIL_GROUPS } from "@/components/prototypes/tool-permission-fixture";
import {
  clearGroupOverrides,
  effectiveToolMode,
  groupMode,
  overriddenToolIds,
  type PrototypeState,
  persistedPayload,
  setGroupMode,
  setToolMode,
} from "@/components/prototypes/tool-permission-model";

const organize = GMAIL_GROUPS.find((group) => group.id === "write")!;
const trashThread = "gmail:trash_thread";
const labelThread = "gmail:label_thread";
const empty: PrototypeState = { groups: {}, tools: {} };

describe("tool permission resolution", () => {
  it("inherits the group until a tool is pinned", () => {
    expect(effectiveToolMode(empty, organize, trashThread)).toBe("ask");
    const state = setGroupMode(empty, organize, "on");
    expect(effectiveToolMode(state, organize, trashThread)).toBe("on");
  });

  it("lets a pinned tool stay stricter than an On group", () => {
    const state = setToolMode(setGroupMode(empty, organize, "on"), organize, trashThread, "ask");
    expect(effectiveToolMode(state, organize, trashThread)).toBe("ask");
    expect(effectiveToolMode(state, organize, labelThread)).toBe("on");
  });

  it("lets a pinned tool stay looser than an Off group", () => {
    const state = setToolMode(setGroupMode(empty, organize, "off"), organize, labelThread, "on");
    expect(effectiveToolMode(state, organize, labelThread)).toBe("on");
    expect(effectiveToolMode(state, organize, trashThread)).toBe("off");
  });

  it("keeps overrides when the group changes, so an explicit decision is never dropped", () => {
    const pinned = setToolMode(empty, organize, trashThread, "off");
    const widened = setGroupMode(pinned, organize, "on");
    expect(effectiveToolMode(widened, organize, trashThread)).toBe("off");
    expect(overriddenToolIds(widened, organize)).toEqual([trashThread]);
    expect(overriddenToolIds(clearGroupOverrides(widened, organize), organize)).toEqual([]);
  });
});

describe("persisted payload", () => {
  it("writes nothing for an untouched connection", () => {
    expect(persistedPayload(empty)).toEqual({});
  });

  it("drops a group set back to its registry default", () => {
    const state = setGroupMode(setGroupMode(empty, organize, "on"), organize, organize.defaultMode);
    expect(persistedPayload(state)).toEqual({});
    expect(groupMode(state, organize)).toBe("ask");
  });

  it("does not record a tool set to the value it already inherits", () => {
    const state = setToolMode(empty, organize, trashThread, "ask");
    expect(persistedPayload(state)).toEqual({});
  });

  it("drops an override once the group catches up to it", () => {
    const pinned = setToolMode(empty, organize, labelThread, "on");
    expect(persistedPayload(pinned)).toEqual({ tools: { [labelThread]: "on" } });
    // Re-selecting the same value after the group moved normalizes back to inherit.
    const widened = setToolMode(setGroupMode(pinned, organize, "on"), organize, labelThread, "on");
    expect(persistedPayload(widened)).toEqual({ write: "on" });
  });

  it("stores groups and tool exceptions side by side", () => {
    const state = setToolMode(setGroupMode(empty, organize, "on"), organize, trashThread, "off");
    expect(persistedPayload(state)).toEqual({ write: "on", tools: { [trashThread]: "off" } });
  });
});
