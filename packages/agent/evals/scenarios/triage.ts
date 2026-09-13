import { DEFAULT_BUDGETS, type Scenario } from "../types";
import { ln, ph } from "./discovery";

// Cross-tool case (benchmark-reference Track A): read a metric from one integration,
// decide whether action is warranted, and carry the exact figures into a write in another.
// The figures exist only in the PostHog read fixtures, so their presence in the Linear
// write proves cross-tool data flow rather than paraphrase.
export const triageScenarios: Scenario[] = [
  {
    id: "posthog-linear-triage",
    tags: ["posthog", "linear", "write", "cross-tool", "regression"],
    // Prompt names the insight's short id like real production prompts name record ids;
    // without it, two-source discovery plus diligent re-reads exceeds the production
    // eight-step ceiling and the case only measures step frugality.
    prompt:
      "Since Tuesday's release our Weekly activation insight in PostHog (short id AbCd1234) looks off. Check the actual numbers. If activation really dropped, file a Linear issue in the Product team so the team can investigate, and include the exact current and previous activation figures in it. If the numbers look fine, don't create or change anything.",
    budgets: DEFAULT_BUDGETS,
    allowedActions: [
      `${ph}insights-list`,
      `${ph}insight-get`,
      `${ph}insight-query`,
      `${ln}list_issues`,
      `${ln}save_issue`,
    ],
    approvalAction: `${ln}save_issue`,
    fixture: (action, params) => {
      if (action === `${ph}insights-list`)
        return { results: [{ id: 42, short_id: "AbCd1234", name: "Weekly activation" }] };
      // Like the real API, reading a saved insight includes its cached results, so
      // either read path fits the production step ceiling alongside two discovery rounds.
      if (action === `${ph}insight-get`)
        return {
          id: 42,
          short_id: "AbCd1234",
          name: "Weekly activation",
          query: { kind: "TrendsQuery" },
          result: [{ label: "Activated users", count: 84, previous: 132 }],
        };
      if (action === `${ph}insight-query`)
        return { results: [{ label: "Activated users", count: 84, previous: 132 }] };
      // Checking for an existing duplicate before filing is valid diligence, not a detour.
      if (action === `${ln}list_issues`) return { issues: [], hasNextPage: false };
      if (action === `${ln}save_issue`)
        return {
          id: "DEMO-7",
          title: params.title,
          team: "Product",
          status: "Todo",
          url: "https://linear.app/example/issue/DEMO-7",
        };
      throw new Error("Unexpected fixture action");
    },
    assert: ({ executions, final }) => {
      const writes = executions.filter((e) => e.action === `${ln}save_issue`);
      const p = writes[0]?.params;
      const written = `${p?.title ?? ""}\n${p?.description ?? ""}`;
      return {
        "read activation figures": executions.some(
          (e) =>
            e.success &&
            ((e.action === `${ph}insight-query` &&
              [42, "42", "AbCd1234"].includes(e.params.insightId as string)) ||
              (e.action === `${ph}insight-get` &&
                [42, "42", "AbCd1234"].includes(e.params.id as string))),
        ),
        "one issue carrying both figures":
          writes.length === 1 &&
          writes[0]!.success &&
          p?.id === undefined &&
          p?.team === "Product" &&
          typeof p?.title === "string" &&
          /activation/i.test(p.title) &&
          /\b84\b/.test(written) &&
          /\b132\b/.test(written),
        "reported issue and current figure": final.includes("DEMO-7") && /\b84\b/.test(final),
      };
    },
  },
];
