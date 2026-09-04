import { beforeEach, describe, expect, it, vi } from "vitest";
import PluginDetailPage from "./page";

const currentUserMock = vi.hoisted(() => vi.fn());
const getHeadlessPluginMock = vi.hoisted(() => vi.fn());
const officialSkillPluginDetailMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/components/OfficialMcpPluginSettings", () => ({
  BetterStackPluginDetail: vi.fn(() => null),
  GitHubPluginDetail: vi.fn(() => null),
  LinearPluginDetail: vi.fn(() => null),
  NeonPluginDetail: vi.fn(() => null),
  SigNozPluginDetail: vi.fn(() => null),
  SlackPluginDetail: vi.fn(() => null),
  XPluginDetail: vi.fn(() => null),
}));

vi.mock("@/components/PluginSettings", () => ({
  OfficialSkillPluginDetail: officialSkillPluginDetailMock,
  PluginDetail: vi.fn(() => null),
}));

vi.mock("@/components/SettingsChrome", () => ({
  SettingsContent: vi.fn(() => null),
}));

vi.mock("@/lib/auth", () => ({
  currentUser: currentUserMock,
}));

vi.mock("@/lib/headless-knowledge-server", () => ({
  getHeadlessPlugin: getHeadlessPluginMock,
}));

describe("plugin detail route", () => {
  beforeEach(() => {
    currentUserMock.mockReset();
    getHeadlessPluginMock.mockReset();
    currentUserMock.mockResolvedValue({ role: "admin" });
  });

  it("keeps the uninstalled official skill plugin props serializable across the RSC boundary", async () => {
    getHeadlessPluginMock.mockResolvedValue(null);

    const page = await PluginDetailPage({
      params: Promise.resolve({ name: "yc-advise" }),
    });

    expect(getHeadlessPluginMock).toHaveBeenCalledWith("yc-advise");
    expect(page.props).toEqual({ name: "yc-advise", canEdit: true });
    expect(() => structuredClone(page.props)).not.toThrow();
  });
});
