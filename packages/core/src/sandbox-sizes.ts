// The machine size a cloud coding sandbox runs on.
//
// E2B allocates vCPU and RAM per *template*, not per sandbox: `Sandbox.create`
// accepts no resource override (verified against e2b 2.49.0 `SandboxOpts` and the
// `NewSandbox` API schema), and `Template.build` is the only place CPU and memory
// are set. Each offered size is therefore its own prebuilt template alias, and the
// pairs below are the single source of truth shared by the template build, the
// workspace setting, and the labels the app shows.

export const SANDBOX_SIZES = ["small", "standard", "large"] as const;

export type SandboxSize = (typeof SANDBOX_SIZES)[number];

export const DEFAULT_SANDBOX_SIZE: SandboxSize = "standard";

export type SandboxSizeSpec = {
  size: SandboxSize;
  label: string;
  // What the size is for, in the user's terms. Shown under the label in settings.
  summary: string;
  cpuCount: number;
  memoryMB: number;
};

export const SANDBOX_SIZE_SPECS: Record<SandboxSize, SandboxSizeSpec> = {
  small: {
    size: "small",
    label: "Small",
    summary: "Editing, small repos, and quick scripts.",
    cpuCount: 2,
    memoryMB: 4096,
  },
  standard: {
    size: "standard",
    label: "Standard",
    summary: "Most work: installs, test suites, and a browser.",
    cpuCount: 4,
    memoryMB: 8192,
  },
  large: {
    size: "large",
    label: "Large",
    summary: "Heavy builds, containers, and large test runs.",
    cpuCount: 8,
    memoryMB: 16384,
  },
};

export const SANDBOX_SIZE_SPEC_LIST: readonly SandboxSizeSpec[] = SANDBOX_SIZES.map(
  (size) => SANDBOX_SIZE_SPECS[size],
);

export function isSandboxSize(value: unknown): value is SandboxSize {
  return typeof value === "string" && (SANDBOX_SIZES as readonly string[]).includes(value);
}
