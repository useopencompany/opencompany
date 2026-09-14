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
    expect(effectiveToolMode(setGroupMode(empty, organize, "on"), organize, trashThread)).toBe(
      "on",
    );
  });

  it("lets a pinned tool stay stricter than an On group", () => {
    const state = setToolMode(setGroupMode(empty, organize, "on"), trashThread, "ask");
    expect(effectiveToolMode(state, organize, trashThread)).toBe("ask");
    expect(effectiveToolMode(state, organize, labelThread)).toBe("on");
  });

  it("lets a pinned tool stay looser than an Off group", () => {
    const state = setToolMode(setGroupMode(empty, organize, "off"), labelThread, "on");
    expect(effectiveToolMode(state, organize, labelThread)).toBe("on");
    expect(effectiveToolMode(state, organize, trashThread)).toBe("off");
  });

  it("keeps a pin that currently matches its group, so widening the group cannot undo it", () => {
    const pinned = setToolMode(empty, trashThread, "ask");
    expect(overriddenToolIds(pinned, organize)).toEqual([trashThread]);
    const widened = setGroupMode(pinned, organize, "on");
    expect(effectiveToolMode(widened, organize, trashThread)).toBe("ask");
    expect(effectiveToolMode(widened, organize, labelThread)).toBe("on");
  });

  it("clears a tool back to its group only through Use group", () => {
    const pinned = setToolMode(setGroupMode(empty, organize, "on"), trashThread, "off");
    const released = setToolMode(pinned, trashThread, "inherit");
    expect(overriddenToolIds(released, organize)).toEqual([]);
    expect(effectiveToolMode(released, organize, trashThread)).toBe("on");
  });

  it("resets every exception in one group without touching the group mode", () => {
    const state = setToolMode(
      setToolMode(setGroupMode(empty, organize, "on"), trashThread, "off"),
      labelThread,
      "ask",
    );
    expect(overriddenToolIds(state, organize)).toEqual([labelThread, trashThread]);
    const reset = clearGroupOverrides(state, organize);
    expect(overriddenToolIds(reset, organize)).toEqual([]);
    expect(groupMode(reset, organize)).toBe("on");
  });
});

describe("persisted payload", () => {
  it("writes nothing for an untouched connection", () => {
    expect(persistedPayload(empty)).toEqual({});
  });

  it("records a group the user touched, the way applyIntegrationCapabilityMode does", () => {
    const state = setGroupMode(setGroupMode(empty, organize, "on"), organize, organize.defaultMode);
    expect(persistedPayload(state)).toEqual({ write: "ask" });
    expect(groupMode(state, organize)).toBe("ask");
  });

  it("stores groups and tool exceptions side by side", () => {
    const state = setToolMode(setGroupMode(empty, organize, "on"), trashThread, "off");
    expect(persistedPayload(state)).toEqual({ write: "on", tools: { [trashThread]: "off" } });
  });

  it("drops the tools key once the last exception is released", () => {
    const state = setToolMode(setToolMode(empty, trashThread, "off"), trashThread, "inherit");
    expect(persistedPayload(state)).toEqual({});
  });
});
