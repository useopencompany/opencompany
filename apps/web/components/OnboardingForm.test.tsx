import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingForm from "./OnboardingForm";

vi.mock("@opencompany/analytics/client", () => ({
  captureEvent: vi.fn(),
}));

vi.mock("@/lib/booking", () => ({
  INTRO_CALL_CAL_LINK: "opencompany/onboarding",
  INTRO_CALL_URL: "https://cal.com/opencompany/onboarding",
}));

vi.mock("@/components/ToolPolicyEditor", () => ({
  ToolPolicyEditor: () => <div data-testid="tool-policy-editor" />,
}));

vi.mock("@/lib/onboarding/actions", () => ({
  completeOnboarding: vi.fn(async () => ({
    errors: {},
    values: {
      heardFrom: "",
      heardFromDetail: "",
      role: "",
      teamSize: "",
      companyUrl: "",
      agentExperience: "",
      goal: "",
      personalBrainFolders: [],
      personalIntegrations: [],
    },
  })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

const companyUrlHint =
  "Your website helps make opencompany better for your product and customers. We recommend adding it, but you can continue without it.";

describe("OnboardingForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.Cal;
  });

  it("recommends adding a company URL before allowing the user to continue without one", async () => {
    const user = userEvent.setup();
    renderOnboardingForm();

    await user.click(screen.getByRole("button", { name: "LinkedIn" }));
    await screen.findByRole("heading", { name: "How familiar are you with agents?" });

    await user.click(screen.getByRole("button", { name: "I am new to agents" }));
    await screen.findByRole("heading", { name: "Tell us about your team" });

    await user.type(screen.getByRole("textbox", { name: "Role" }), "Founder");
    await user.click(screen.getByRole("button", { name: "2-10" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText(companyUrlHint)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tell us about your team" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue without URL" }));

    expect(
      screen.getByRole("heading", { name: "What do you want to accomplish with opencompany?" }),
    ).toBeInTheDocument();
  });

  it("clears the company URL recommendation once a URL is entered", async () => {
    const user = userEvent.setup();
    renderOnboardingForm();

    await user.click(screen.getByRole("button", { name: "LinkedIn" }));
    await screen.findByRole("heading", { name: "How familiar are you with agents?" });

    await user.click(screen.getByRole("button", { name: "I am new to agents" }));
    await screen.findByRole("heading", { name: "Tell us about your team" });

    await user.type(screen.getByRole("textbox", { name: "Role" }), "Founder");
    await user.click(screen.getByRole("button", { name: "2-10" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: /company url/i }), "opencompany.ai");

    expect(screen.queryByText(companyUrlHint)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("lets the user choose Personal Brain starter folders", async () => {
    const user = userEvent.setup();
    renderOnboardingForm();

    await user.click(screen.getByRole("button", { name: "LinkedIn" }));
    await user.click(await screen.findByRole("button", { name: "I am new to agents" }));

    await user.type(screen.getByRole("textbox", { name: "Role" }), "Founder");
    await user.click(screen.getByRole("button", { name: "2-10" }));
    await user.type(screen.getByRole("textbox", { name: /company url/i }), "opencompany.ai");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByRole("heading", {
      name: "What do you want to accomplish with opencompany?",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Meet Leo" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Personal Brain" });

    expect(
      screen.getByText("This is where your work and your agents' work live."),
    ).toBeInTheDocument();

    const meetings = screen.getByRole("button", { name: "Meetings" });
    expect(meetings).toHaveAttribute("aria-pressed", "true");

    await user.click(meetings);

    expect(meetings).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the first integrations in capabilities with a connect action and no use toggle", async () => {
    const user = userEvent.setup();
    renderOnboardingForm();

    await completeProfileSteps(user);
    await screen.findByRole("heading", {
      name: "What do you want to accomplish with opencompany?",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Meet Leo" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Personal Brain" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Memory" });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();

    // The agent gets only the integrations the user actually connects, so the speculative "Use"
    // toggle is gone — each not-yet-connected integration just offers a Connect action.
    expect(screen.queryByRole("button", { name: /use/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect" }).length).toBeGreaterThan(0);
  });
});

async function completeProfileSteps(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "LinkedIn" }));
  await user.click(await screen.findByRole("button", { name: "I am new to agents" }));
  await user.type(screen.getByRole("textbox", { name: "Role" }), "Founder");
  await user.click(screen.getByRole("button", { name: "2-10" }));
  await user.type(screen.getByRole("textbox", { name: /company url/i }), "opencompany.ai");
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

function renderOnboardingForm() {
  return render(
    <OnboardingForm userEmail="ada@example.com" userId="usr_test" workspaceId="wks_test" />,
  );
}
