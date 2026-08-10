// Content for /benchmarks. Every number here was pulled live from the cited
// source on LAST_UPDATED — this file is what a weekly editorial pass edits.
// Keep claims traceable: if a number can't be re-verified against its `source`
// link, soften it or cut it rather than letting stale data sit under a badge
// that says "verified."

export const LAST_UPDATED = "2026-08-10";

export type Source = { label: string; href: string };

export type VerificationStatus = "verified" | "unverified";

export const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  verified: "Independently run",
  unverified: "Not yet reproduced",
};

export type TldrRow = {
  category: string;
  model: string;
  rationale: string;
  source: Source;
};

export const TLDR_ROWS: TldrRow[] = [
  {
    category: "Best for coding",
    model: "Claude Fable 5 (via Claude Code)",
    rationale:
      "83.8% on Terminal-Bench 2.1 — the highest score from a model you can actually buy today.",
    source: {
      label: "Terminal-Bench 2.1",
      href: "https://www.tbench.ai/leaderboard/terminal-bench/2.1",
    },
  },
  {
    category: "Best for knowledge work",
    model: "Claude Opus 5",
    rationale: "#1 of 185 models on Artificial Analysis's Intelligence Index and on GDPval-AA v2.",
    source: {
      label: "Artificial Analysis Intelligence Index",
      href: "https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index",
    },
  },
  {
    category: "Best for browser & computer use",
    model: "Claude Fable 5",
    rationale:
      "85% on OSWorld-Verified and generally available. Qwen3.8 Max claims 86.1% a week after launch — unreproduced, so we're not moving the pick yet.",
    source: {
      label: "OSWorld-Verified tracker",
      href: "https://llm-stats.com/benchmarks/osworld-verified",
    },
  },
  {
    category: "Best value",
    model: "DeepSeek V4 Flash 0731",
    rationale:
      "$0.06 blended per M tokens — about 1/128th Claude Fable 5's price, for a model that still lands in Artificial Analysis's top tier for open weights.",
    source: {
      label: "Artificial Analysis pricing",
      href: "https://artificialanalysis.ai/models/deepseek-v4-flash",
    },
  },
  {
    category: "Fastest",
    model: "Gemini 3.6 Flash",
    rationale: "238 output tokens/sec — more than 4x Claude Opus 5's throughput.",
    source: {
      label: "Artificial Analysis speed data",
      href: "https://artificialanalysis.ai/models/gemini-3-6-flash",
    },
  },
];

export type TrustEntry = {
  name: string;
  why: string;
  source: Source;
};

export const TRUST_MAP: {
  discriminative: TrustEntry[];
  caution: TrustEntry[];
  ignore: TrustEntry[];
} = {
  discriminative: [
    {
      name: "Terminal-Bench 2.1",
      why: "CLI/agentic coding tasks, execution-graded. Version 2.1 (May 2026) rewrote 26+ tasks specifically to close reward-hacking exploits found in 2.0.",
      source: { label: "tbench.ai", href: "https://www.tbench.ai/news/terminal-bench-2-1" },
    },
    {
      name: "DeepSWE",
      why: "Contamination-resistant coding eval — 1.4% verifier disagreement vs. SWE-bench Pro's 32%. Built by a startup (Datacurve), so treat as promising, not yet independently confirmed.",
      source: { label: "arXiv 2607.07946", href: "https://arxiv.org/abs/2607.07946" },
    },
    {
      name: "OSWorld-Verified",
      why: "369 real desktop/web tasks across Windows, macOS, and Ubuntu, execution-graded rather than multiple choice.",
      source: { label: "llm-stats.com", href: "https://llm-stats.com/benchmarks/osworld-verified" },
    },
    {
      name: "GDPval-AA v2",
      why: 'Runs OpenAI\'s own real-economically-valuable-work dataset through blind pairwise grading instead of answer-matching — closer to "would a professional accept this."',
      source: {
        label: "Artificial Analysis",
        href: "https://artificialanalysis.ai/evaluations/gdpval-aa",
      },
    },
    {
      name: "AA-Omniscience",
      why: "Penalizes confident wrong answers instead of just rewarding correct ones — catches hallucination that raw-accuracy evals miss entirely.",
      source: {
        label: "Artificial Analysis",
        href: "https://artificialanalysis.ai/evaluations/omniscience",
      },
    },
    {
      name: "τ³-bench",
      why: "Tests multi-step tool use against a large, messy knowledge base (700+ policy docs) instead of a clean sandbox — closer to a real support or ops workflow.",
      source: {
        label: "Artificial Analysis τ³-Banking",
        href: "https://artificialanalysis.ai/evaluations/tau3-banking",
      },
    },
  ],
  caution: [
    {
      name: "LMArena (now Arena.ai)",
      why: "Crowdsourced pairwise votes reward confident, well-formatted answers over correct ones. One audit found ~52% of votes favored a fluent-but-wrong response.",
      source: {
        label: "LMArena bias critique",
        href: "https://www.trendingtopics.eu/lmarena-is-a-cancer-how-llm-rankings-distort-the-ai-sector/",
      },
    },
    {
      name: "SWE-bench Pro",
      why: 'OpenAI\'s own July 2026 audit found ~30% of tasks broken — bad tests, underspecified prompts. Some "passes" were models reading the fix straight out of git history.',
      source: {
        label: "OpenAI coding-eval audit (via AlphaSignal)",
        href: "https://alphasignal.ai/news/openai-retracts-swe-bench-pro-after-finding-30-of-tasks-broken",
      },
    },
  ],
  ignore: [
    {
      name: "SWE-bench Verified",
      why: "OpenAI stopped citing it in Feb 2026 after finding most of a hard-subset audit flawed, plus evidence frontier models had trained on its solutions.",
      source: {
        label: "OpenAI (via Blockchain.News)",
        href: "https://blockchain.news/news/openai-abandons-swe-bench-verified-contamination-flawed-tests",
      },
    },
    {
      name: "MMLU",
      why: "Frontier models now cluster within ~2 points of each other. A decontaminated variant drops scores 3–7 points — proof the leakage is real.",
      source: { label: "Benchmark analysis", href: "https://benchmarkingagents.com/mmlu/" },
    },
    {
      name: "Launch-day self-reported numbers",
      why: "No shared methodology, no independent reproduction, graded by the lab selling the model. Wait for a third party to confirm before it moves any row on this page.",
      source: { label: "Why this page exists", href: "#methodology" },
    },
  ],
};

export type CapabilityRow = {
  entry: string;
  lab?: string;
  score: string;
  verification: VerificationStatus;
  note?: string;
};

export type CapabilityTable = {
  id: string;
  title: string;
  metric: string;
  source: Source;
  asOf: string;
  rows: CapabilityRow[];
  footnote?: string;
};

export const CAPABILITY_TABLES: CapabilityTable[] = [
  {
    id: "coding",
    title: "Coding",
    metric: "Terminal-Bench 2.1 score",
    source: { label: "tbench.ai", href: "https://www.tbench.ai/leaderboard/terminal-bench/2.1" },
    asOf: LAST_UPDATED,
    rows: [
      {
        entry: "Claude Code + Fable 5",
        score: "83.8%",
        verification: "verified",
        note: "$552.67 to run",
      },
      {
        entry: "Codex + GPT-5.5",
        score: "83.1%",
        verification: "verified",
        note: "$2,059.19 to run",
      },
      {
        entry: "Terminus 2 + Fable 5",
        score: "80.4%",
        verification: "verified",
        note: "$438.64 to run",
      },
      {
        entry: "Cursor CLI + Grok 4.5",
        score: "79.3%",
        verification: "verified",
        note: "$134.09 to run",
      },
      {
        entry: "Claude Code + Opus 4.8",
        score: "78.9%",
        verification: "verified",
        note: "$286.94 to run",
      },
    ],
    footnote:
      "The cost column is what it took to run the full benchmark, not per task — see the harness-efficiency note below.",
  },
  {
    id: "knowledge-work",
    title: "Knowledge work",
    metric: "Artificial Analysis Intelligence Index",
    source: {
      label: "artificialanalysis.ai",
      href: "https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index",
    },
    asOf: LAST_UPDATED,
    rows: [
      { entry: "Claude Opus 5", score: "63 (#1/185)", verification: "verified" },
      { entry: "Claude Fable 5", score: "62 (#3/185)", verification: "verified" },
      { entry: "GPT-5.6 Sol", score: "61 (#5/185)", verification: "verified" },
      { entry: "Qwen3.8 Max", score: "58 (#9/185)", verification: "verified" },
      { entry: "Gemini 3.6 Flash", score: "52 (#26/185)", verification: "verified" },
      { entry: "DeepSeek V4 Flash 0731", score: "52 (#3/101 open)", verification: "verified" },
    ],
  },
  {
    id: "tool-use",
    title: "Tool-use workflows",
    metric: "τ³-Banking score",
    source: {
      label: "artificialanalysis.ai",
      href: "https://artificialanalysis.ai/evaluations/tau3-banking",
    },
    asOf: LAST_UPDATED,
    rows: [
      { entry: "Qwen3.8 Max", score: "51.3%", verification: "verified" },
      { entry: "Kimi K3", score: "46.0%", verification: "verified" },
      { entry: "Claude Opus 5", score: "44.7%", verification: "verified" },
    ],
    footnote: "97 multi-step banking tasks run against 700+ interconnected policy documents.",
  },
  {
    id: "browser-use",
    title: "Browser & computer use",
    metric: "OSWorld-Verified score",
    source: {
      label: "llm-stats.com tracker",
      href: "https://llm-stats.com/benchmarks/osworld-verified",
    },
    asOf: LAST_UPDATED,
    rows: [
      {
        entry: "Qwen3.8 Max",
        score: "86.1%",
        verification: "unverified",
        note: "Launched Aug 3 — one week old",
      },
      { entry: "Claude Fable 5", score: "85%", verification: "unverified" },
    ],
    footnote:
      'We track this via a third-party leaderboard, not a direct run — treat both rows as "not yet reproduced" until we can confirm firsthand. Excludes Claude Mythos 5 (also ~85%): a gated research preview, not something you can buy.',
  },
];

export type SpeedRow = {
  model: string;
  blendedPrice: string;
  outputSpeed: string;
  ttft: string;
};

export const SPEED_TABLE: SpeedRow[] = [
  { model: "Claude Opus 5", blendedPrice: "$3.85/M", outputSpeed: "57.1 tok/s", ttft: "33.5s" },
  { model: "Claude Fable 5", blendedPrice: "$7.70/M", outputSpeed: "68.9 tok/s", ttft: "137.1s" },
  { model: "GPT-5.6 Sol", blendedPrice: "$4.35/M", outputSpeed: "69.2 tok/s", ttft: "133.6s" },
  { model: "Qwen3.8 Max", blendedPrice: "$1.18/M", outputSpeed: "81.6 tok/s", ttft: "2.8s" },
  { model: "Gemini 3.6 Flash", blendedPrice: "$1.16/M", outputSpeed: "237.8 tok/s", ttft: "24.1s" },
  {
    model: "DeepSeek V4 Flash 0731",
    blendedPrice: "$0.06/M",
    outputSpeed: "141.3 tok/s",
    ttft: "1.4s",
  },
];

export const COST_SOURCE: Source = {
  label: "Artificial Analysis, blended at a 7:2:1 cache/input/output ratio",
  href: "https://artificialanalysis.ai/",
};

export type ModelCard = {
  id: string;
  name: string;
  lab: string;
  released: string;
  verdict: string;
  source: Source;
};

export const MODEL_CARDS: ModelCard[] = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    lab: "Anthropic",
    released: "Jul 2026",
    verdict:
      "The current #1 on Artificial Analysis's Intelligence Index and on GDPval-AA v2 — the pick for knowledge work and high-stakes reasoning. It's also the slowest model on this page to start responding (33.5s time-to-first-token), so it's the wrong choice when latency matters more than depth.",
    source: {
      label: "artificialanalysis.ai/models/claude-opus-5",
      href: "https://artificialanalysis.ai/models/claude-opus-5",
    },
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    lab: "Anthropic",
    released: "2026",
    verdict:
      "Our coding pick: #1 generally-available model on Terminal-Bench 2.1 (83.8%) and tied for the top spot on OSWorld-Verified among models you can actually buy. Ranks #3 on the Intelligence Index overall, so it's also a fine knowledge-work model if you don't need Opus 5's ceiling.",
    source: {
      label: "artificialanalysis.ai/models/claude-fable-5",
      href: "https://artificialanalysis.ai/models/claude-fable-5",
    },
  },
  {
    id: "gpt-5-6-sol",
    name: "GPT-5.6 Sol",
    lab: "OpenAI",
    released: "Jul 2026",
    verdict:
      "OpenAI's top tier of the 5.6 family (Luna/Terra/Sol). Competitive across the board — #5 on the Intelligence Index, #2 on Terminal-Bench 2.1 — but it's also the most expensive model we track on a blended basis ($4.35/M) with a similarly long 133.6s time-to-first-token.",
    source: {
      label: "artificialanalysis.ai/models/gpt-5-6-sol",
      href: "https://artificialanalysis.ai/models/gpt-5-6-sol",
    },
  },
  {
    id: "qwen3-8-max",
    name: "Qwen3.8 Max",
    lab: "Alibaba",
    released: "Aug 2026",
    verdict:
      "A genuine frontier contender that showed up fast: #1 on τ³-Banking tool-use, and a one-week-old (unreproduced) claim to the top OSWorld-Verified spot. Cheap ($1.18/M blended) and low-latency (2.8s TTFT). Open weights are rolling out this week — worth watching, not yet a settled recommendation.",
    source: {
      label: "artificialanalysis.ai/models/qwen3-8-max",
      href: "https://artificialanalysis.ai/models/qwen3-8-max",
    },
  },
  {
    id: "gemini-3-6-flash",
    name: "Gemini 3.6 Flash",
    lab: "Google",
    released: "Jul 2026",
    verdict:
      "The speed pick: 237.8 output tokens/sec and a 24.1s TTFT, both well ahead of anything else on this page, at $1.16/M blended. Trades away raw intelligence for it (#26 on the Index) — the right call for high-throughput, latency-sensitive agent loops, not for your hardest reasoning tasks.",
    source: {
      label: "artificialanalysis.ai/models/gemini-3-6-flash",
      href: "https://artificialanalysis.ai/models/gemini-3-6-flash",
    },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash 0731",
    lab: "DeepSeek",
    released: "Jul 2026",
    verdict:
      "The value pick, by a wide margin: $0.06/M blended — about 1/128th Claude Fable 5's price — while still landing top-3 among open-weight models on the Intelligence Index. Also the lowest TTFT we measured (1.4s). Open weights, MIT-licensed.",
    source: {
      label: "artificialanalysis.ai/models/deepseek-v4-flash",
      href: "https://artificialanalysis.ai/models/deepseek-v4-flash",
    },
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    lab: "Moonshot AI",
    released: "Jul 2026",
    verdict:
      "An open-weight 2.8T-parameter model that lands #2 on τ³-Banking tool-use, ahead of every model here except Qwen3.8 Max. Moonshot's own comparisons put it ahead of last generation's Opus 4.8 and GPT-5.5 — worth a look if you want near-frontier tool-use on open weights.",
    source: {
      label: "Moonshot AI / Kimi K3 announcement",
      href: "https://simonwillison.net/2026/Jul/16/kimi-k3/",
    },
  },
  {
    id: "muse-glimmer",
    name: "Muse Glimmer",
    lab: "Meta Superintelligence Labs",
    released: "Aug 2026",
    verdict:
      "Not a frontier model, and not trying to be: a 30B Apache-2.0 model distilled to run on a single consumer GPU. The interesting story is what it signals — Meta doubling down on local, on-device agentic models after retiring the open Llama line in April 2026.",
    source: {
      label: "Meta AI Research",
      href: "https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model",
    },
  },
];

export type ChangelogEntry = {
  date: string;
  text: string;
  source: Source;
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-08-10",
    text: "Meta open-sources Muse Glimmer, a 30B on-device agentic model (Apache 2.0), continuing its shift away from the open Llama brand.",
    source: {
      label: "Meta AI Research",
      href: "https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model",
    },
  },
  {
    date: "2026-08-06",
    text: "Artificial Analysis ships Intelligence Index v4.1.1, an update to grading robustness across its nine-eval composite. Rankings held steady.",
    source: {
      label: "artificialanalysis.ai",
      href: "https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-1-1",
    },
  },
  {
    date: "2026-08-03",
    text: "Alibaba ships Qwen3.8 Max, immediately topping τ³-Banking tool-use and an unreproduced OSWorld-Verified snapshot. Open weights follow this week.",
    source: {
      label: "Bloomberg",
      href: "https://www.bloomberg.com/news/articles/2026-08-03/alibaba-drops-another-china-ai-model-with-breakthrough-performance",
    },
  },
  {
    date: "2026-07-31",
    text: "DeepSeek ships V4 Flash 0731 (MIT license), retrained to beat its own larger V4 Pro on published agentic benchmarks at unchanged $0.14/$0.28 pricing.",
    source: {
      label: "Simon Willison",
      href: "https://simonwillison.net/2026/Jul/31/deepseek-v4-flash-0731/",
    },
  },
  {
    date: "2026-07-24",
    text: "Anthropic ships Claude Opus 5, taking the #1 spot on the Artificial Analysis Intelligence Index and GDPval-AA v2.",
    source: { label: "Anthropic", href: "https://www.anthropic.com/news/claude-opus-5" },
  },
  {
    date: "2026-07-08",
    text: "OpenAI publishes a self-audit retracting its own SWE-bench Pro recommendation after finding ~30% of tasks broken — five months after dropping SWE-bench Verified for the same reason. The reason this page exists.",
    source: {
      label: "AlphaSignal",
      href: "https://alphasignal.ai/news/openai-retracts-swe-bench-pro-after-finding-30-of-tasks-broken",
    },
  },
];

export const METHODOLOGY_SOURCES: Source[] = [
  { label: "Artificial Analysis", href: "https://artificialanalysis.ai/" },
  { label: "Terminal-Bench (tbench.ai)", href: "https://www.tbench.ai/" },
  { label: "Vals AI", href: "https://www.vals.ai/benchmarks" },
  { label: "Arena.ai (formerly LMArena)", href: "https://arena.ai/" },
  { label: "OpenRouter rankings", href: "https://openrouter.ai/rankings" },
  { label: "DeepSWE", href: "https://deepswe.datacurve.ai/" },
];
