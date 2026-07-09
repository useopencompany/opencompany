import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getGoatBrainFile,
  materializeGoatBrainFilesToRoot,
  syncGoatBrainFilesFromRoot,
  updateGoatBrainAssetExtraction,
} from "@opencompany/db/goat-brain-files";
import { getDefaultGoatBrainForUser } from "@opencompany/db/goat-workspaces";
import {
  GOAT_BRAIN_POINTER_COPY_RULE,
  type NormalizedGoatChatCaptureSourceItem,
  type NormalizedJamieMeetingSourceItem,
  type NormalizedUploadAssetSourceItem,
} from "@opencompany/goat-brain";
import { getGoatBrainCliSource } from "@opencompany/goat-brain/cli-bundle";
import { createLogger } from "@opencompany/observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import * as ai from "ai";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { writeLocalBrainFile } from "./goat-brain";
import {
  buildJamieMeetingEvidenceWrite,
  formatActionItems,
  formatParticipants,
  formatTranscript,
  formatTranscriptExcerpt,
  JAMIE_MEETING_FOLDER,
  truncateByBytes,
} from "./goat-brain-jamie-writes";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-brain-agent-ingest" });

export const GOAT_BRAIN_AGENT_INGEST_MODEL = "anthropic/claude-sonnet-4.6";
export const GOAT_BRAIN_AGENT_INGEST_MAX_STEPS = 32;
export const GOAT_BRAIN_AGENT_INGEST_TIMEOUT_MS = 10 * 60 * 1000;
export const GOAT_BRAIN_AGENT_SKIP_SENTINEL = "SKIP";
const AGENT_CLI_TIMEOUT_MS = 60_000;
const AGENT_CLI_STDOUT_LIMIT = 24_000;
const AGENT_CLI_STDERR_LIMIT = 4_000;
const PROMPT_TRANSCRIPT_BYTES = 100_000;
const PROMPT_SUMMARY_BYTES = 60_000;
const PROMPT_CAPTURE_BYTES = 64_000;
const PROMPT_ASSET_TEXT_BYTES = 100_000;
const RESULT_SUMMARY_LIMIT = 2_000;

// The ingestion agent gets the full working surface of the CLI except the
// planner (`ingest` runs its own LLM) and destructive curation commands.
const AGENT_CLI_COMMANDS = [
  "help",
  "list",
  "get",
  "timeline",
  "query",
  "folder",
  "doctor",
  "create",
  "rewrite",
  "set",
  "timeline-add",
  "append-timeline",
  "append-evidence",
  "alias",
  "link",
  "move",
] as const;
// The capture curator additionally retires duplicate drafts by merging them
// into the page that absorbed their content.
const CAPTURE_AGENT_CLI_COMMANDS = [...AGENT_CLI_COMMANDS, "merge"] as const;
const READ_ONLY_AGENT_CLI_COMMANDS = new Set([
  "help",
  "list",
  "get",
  "timeline",
  "query",
  "folder",
  "doctor",
]);

export type GoatBrainAgentIngestEnv = Pick<RunnerEnv, "vercelAiGatewayApiKey"> & {
  // Needed only by handlers that fetch blob bytes (uploaded assets); optional
  // so text-only profiles and tests need not provide it.
  blobReadWriteToken?: RunnerEnv["blobReadWriteToken"];
};

export type GoatBrainAgentCliResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type GoatBrainAgentCliRunner = (input: {
  cliPath: string;
  root: string;
  argv: string[];
  gatewayApiKey: string;
  stdin?: string;
  signal?: AbortSignal;
}) => Promise<GoatBrainAgentCliResult>;

export type GoatBrainAgentIngestDeps = {
  runCli?: GoatBrainAgentCliRunner;
};

function buildGoatBrainIngestSystemPrompt(input: { mission: string; skipRule: string }) {
  return [
    `You are the Goat Brain ingestion agent: a durable background worker that ${input.mission}`,
    "You operate the brain exclusively through the goat_brain tool, which runs the deterministic goat-brain CLI against this brain. Call the tool and read its real output; never assume or narrate imagined results.",
    "",
    "How the brain works:",
    "- Every document has compiled truth (the current synthesis) and an append-only timeline of dated evidence entries.",
    "- Types (person, company, project, meeting, concept, source, analysis, note) classify what a record represents. External artifacts (articles, videos, email threads, repos) are `source`; synthesized prose is `analysis`. Folders are free-form human navigation; evidence/ is a reserved zone for raw captures.",
    "- Inline links are typed: [[page:brain-id|Label]] for pages, [[evidence:ev-id|Label]] for evidence records, [[source:provider:id|Label]] for external source pointers.",
    "",
    "Working discipline:",
    "- Brain-first lookup: before creating or writing anything, use query/list/get to find the entities this source touches. Update existing pages under their existing ids; create a page only when no existing page is the primary home. Add aliases instead of duplicate pages.",
    "- Compiled truth is a rewrite, not a log: when a page's state of play changes, use rewrite to replace it with the current durable synthesis. Do not append updates to the bottom of compiled truth.",
    "- Timeline entries are concise dated evidence: use timeline-add with what happened and why it matters, always with --source-ref (and --evidence-id when an evidence record exists).",
    "- Backlink iron law: every mention of an entity that has a brain page must be written as a [[page:...]] link — in compiled truth and in timeline entries.",
    `- ${GOAT_BRAIN_POINTER_COPY_RULE.split("\n").join("\n  ")}`,
    "- No fabrication: write only what the source or the brain supports. If the source does not say it, it does not go in.",
    "- Status discipline: status is the curation signal. New pages start as draft; once a page's compiled truth is a durable synthesis that cites evidence with [[evidence:...]], promote it with `set <id> --status active` (the brain rejects active pages whose compiled truth has no citation). Leave a page draft only when it is genuinely uncurated.",
    `- ${input.skipRule}`,
    "",
    "When you are done, reply with a short plain-text summary of the pages you created or updated (one line per page). Do not include markdown headings in that final reply.",
  ].join("\n");
}

export const JAMIE_MEETING_INGEST_SYSTEM_PROMPT = buildGoatBrainIngestSystemPrompt({
  mission: "folds one source item into a single brain of Markdown knowledge documents.",
  skipRule: `If the source content is not brain-worthy (spam, empty, pure noise), make no writes and reply with exactly ${GOAT_BRAIN_AGENT_SKIP_SENTINEL}.`,
});

export const GOAT_CHAT_CAPTURE_INGEST_SYSTEM_PROMPT = buildGoatBrainIngestSystemPrompt({
  mission:
    "curates one chat capture — content the user explicitly asked to save — into a single brain of Markdown knowledge documents. The capture is already stored as a draft page in the inbox; your job is to file it properly.",
  skipRule: `The user explicitly saved this content, so it is almost always brain-worthy. Only if it is literally empty or unusable, make no writes and reply with exactly ${GOAT_BRAIN_AGENT_SKIP_SENTINEL}; the draft then stays in the inbox for the user.`,
});

export const UPLOAD_ASSET_INGEST_SYSTEM_PROMPT = buildGoatBrainIngestSystemPrompt({
  mission:
    "curates one file the user uploaded into a single brain of Markdown knowledge documents. The file already exists as a document page in the brain (its bytes live outside the markdown plane); your job is to turn that page into a durable synthesis and wire it into the graph.",
  skipRule: `The user explicitly uploaded this file, so it is almost always brain-worthy. Only if its content is literally empty or unreadable AND the file name carries no meaning, make no writes and reply with exactly ${GOAT_BRAIN_AGENT_SKIP_SENTINEL}; the page then stays as an unenriched draft.`,
});

export function buildJamieMeetingAgentIngestPrompt(
  item: NormalizedJamieMeetingSourceItem,
  context: {
    meetingBrainId: string;
    evidenceBrainId: string;
    truncatedTranscript: boolean;
  },
) {
  const meeting = item.content.meeting;
  const transcript = boundedTranscriptMarkdown(item);
  return [
    "Ingest this completed meeting from Jamie (an AI meeting notetaker) into the brain.",
    "",
    "A raw evidence snapshot of these notes already exists in this brain:",
    `- Evidence record: [[evidence:${context.evidenceBrainId}|Jamie meeting notes]] (id: ${context.evidenceBrainId})`,
    context.truncatedTranscript
      ? "- The evidence transcript was truncated to fit the file size limit."
      : null,
    "",
    "Required outcome, all scoped to this brain:",
    `1. A meeting page with id "${context.meetingBrainId}" in the "${JAMIE_MEETING_FOLDER}" folder (type: meeting) whose compiled truth synthesizes the meeting: what it was, decisions, action items, and [[page:...]] links to every attendee and company page. Link the evidence record. Do not paste the transcript.`,
    "2. A person page per human attendee (skip notetaker bots), created or updated, with the meeting on their timeline (use --evidence-id and --source-ref). Update their compiled truth only when the meeting changes their state of play (role, company, plans).",
    "3. Company pages for organizations that are clearly central to the meeting, with the meeting on their timelines. Do not create company pages from a bare email domain alone.",
    "4. Backlinks between all of these pages per the iron law.",
    "",
    `Source ref: ${item.sourceRef}`,
    `Occurred at: ${item.occurredAt}`,
    `Captured at: ${item.capturedAt}`,
    "",
    `## Meeting title\n${meeting.title}`,
    `## Meeting metadata\n- Started: ${meeting.startTime}${meeting.endTime ? `\n- Ended: ${meeting.endTime}` : ""}`,
    `## Participants\n${formatParticipants(item)}`,
    `## Action items\n${formatActionItems(item)}`,
    `## Summary (from Jamie)\n${truncateByBytes(meeting.summaryMarkdown, PROMPT_SUMMARY_BYTES)}`,
    `## Transcript\n${transcript}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function boundedTranscriptMarkdown(item: NormalizedJamieMeetingSourceItem) {
  const segments = item.content.meeting.transcript;
  if (segments.length === 0) return "No transcript provided by Jamie.";
  const full = formatTranscript(segments);
  if (Buffer.byteLength(full, "utf8") <= PROMPT_TRANSCRIPT_BYTES) return full;
  return formatTranscriptExcerpt(segments, PROMPT_TRANSCRIPT_BYTES);
}

export function buildGoatChatCaptureAgentIngestPrompt(item: NormalizedGoatChatCaptureSourceItem) {
  const capture = item.content.capture;
  const draftPath = `${capture.draftFolder}/${capture.draftBrainId}.md`;
  return [
    "Curate this chat capture into the brain. The user explicitly asked to save it during a chat conversation.",
    "",
    `The raw capture is already stored as a draft page with id "${capture.draftBrainId}" at ${draftPath} (type: note, status: draft). Start by reading it with get, then decide its proper home.`,
    "",
    "Required outcome, all scoped to this brain:",
    "1. Find the capture's home: query the brain for pages that already cover this content and for the entities it mentions.",
    `2. If an existing page is the natural home, fold the capture into it (rewrite its compiled truth or timeline-add with --source-ref ${item.sourceRef}), then retire the draft with merge --from ${capture.draftBrainId} --into <that-page>. Do not leave the same content living in two places.`,
    "3. Otherwise curate the draft in place, in this order: use append-evidence to snapshot the raw capture text as a sourced evidence record linked to the draft; rewrite the draft's compiled truth into a durable synthesis that cites that evidence record with [[evidence:...]] and links entities with [[page:...]]; use set to give it a clear title and the right type; move it out of the inbox to the folder where it belongs; then set --status active. Leave it in the inbox as a draft only when it genuinely fits nowhere yet.",
    "4. Create or update person, company, or project pages for entities central to the capture, with backlinks per the iron law. Do not create pages for entities that are merely mentioned in passing.",
    "",
    `If the draft page no longer exists (the user may have deleted or edited it), work from the capture text below and apply the same judgment: fold it into an existing page or create the right page directly.`,
    "",
    `Source ref: ${item.sourceRef}`,
    `Captured at: ${item.capturedAt}`,
    ...(capture.intent ? ["", `## User intent\n${capture.intent}`] : []),
    `## Capture title\n${item.title}`,
    `## Capture text\n${truncateByBytes(capture.text, PROMPT_CAPTURE_BYTES)}`,
  ].join("\n");
}

export function buildUploadAssetAgentIngestPrompt(
  item: NormalizedUploadAssetSourceItem,
  context: { extractedText: string; truncatedText: boolean },
) {
  const asset = item.content.asset;
  const extracted = context.extractedText.trim();
  return [
    "Ingest this file the user uploaded into the brain.",
    "",
    `The file already exists as a page in this brain: id "${asset.brainId}" in the "${asset.folderPath}" folder (format: ${asset.format}, original file: ${asset.originalFileName}).`,
    'The page\'s materialized file ends with a generated "Extracted text" block mirroring the text below; it is machine-derived and any edits to it are discarded, so never write into it.',
    "",
    "Required outcome, all scoped to this brain:",
    `1. Rewrite that page's compiled truth into a durable synthesis of the document: what it is, who it involves, the key facts, claims, and figures, and why it matters — with [[page:...]] links to every entity page. Do not paste the extracted text; synthesize it.`,
    "2. Give the page the right type for what the document represents (an external artifact is `source`) and a clear human title. Keep its id and folder unchanged unless another folder is clearly the better home.",
    `3. Create or update person, company, or project pages for entities central to the document, with the document on their timelines (timeline-add with --source-ref ${item.sourceRef}). Do not create pages for entities merely mentioned in passing.`,
    "4. Backlinks between all of these pages per the iron law.",
    "",
    extracted
      ? null
      : "No text could be extracted from this file (it may be scanned or image-only). Write a minimal compiled truth stating what the file is, judged from its name and metadata, and leave the page as draft.",
    context.truncatedText
      ? "The extracted text below was truncated to fit the prompt size limit."
      : null,
    "",
    `Source ref: ${item.sourceRef}`,
    `Uploaded at: ${item.capturedAt}`,
    "",
    `## File\n- Name: ${asset.originalFileName}\n- Type: ${asset.mimeType}\n- Size: ${asset.sizeBytes} bytes`,
    `## Extracted text\n${extracted || "(none)"}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

type BrainAgentIngestSessionResult = {
  brainRef: string;
  skipped: boolean;
  steps: number;
  toolCalls: number;
  mutations: number;
  upserted: number;
  deleted: number;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  summary: string;
};

// Shared scaffolding for every agent ingest profile: resolve the target brain,
// materialize it to a temp root, run the tool loop, and sync changes back with
// conflict detection. Profiles differ in system prompt, prompt, command
// surface, and optional deterministic pre-writes.
async function runBrainAgentIngestSession(input: {
  userWorkosId: string;
  brainRef: string | null;
  sourceRef: string;
  env: GoatBrainAgentIngestEnv;
  system: string;
  buildPrompt: () => string;
  commands?: readonly string[];
  prepareRoot?: (root: string) => Promise<void>;
  signal?: AbortSignal;
  deps?: GoatBrainAgentIngestDeps;
}): Promise<BrainAgentIngestSessionResult> {
  const db = getDb();
  const brainRef =
    input.brainRef ?? (await getDefaultGoatBrainForUser(input.userWorkosId, { db }))?.id;
  if (!brainRef) {
    throw new Error(`No accessible Goat brain found for user ${input.userWorkosId}.`);
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "goat-agent-ingest-"));
  try {
    const materialized = await materializeGoatBrainFilesToRoot({
      brainRef,
      root,
      cliSource: getGoatBrainCliSource(),
      db,
    });
    await input.prepareRoot?.(root);

    const loop = await runIngestAgentLoop({
      root,
      cliPath: path.join(root, "goat-brain.mjs"),
      gatewayApiKey: input.env.vercelAiGatewayApiKey,
      system: input.system,
      prompt: input.buildPrompt(),
      ...(input.commands ? { commands: input.commands } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.deps?.runCli ? { runCli: input.deps.runCli } : {}),
    });

    const skipped =
      loop.mutations === 0 && loop.finalText.startsWith(GOAT_BRAIN_AGENT_SKIP_SENTINEL);
    if (!skipped && loop.mutations === 0) {
      throw new Error(
        "Goat Brain ingestion agent finished without writing to the brain and did not skip.",
      );
    }
    logger.info("Goat Brain ingestion agent finished", {
      event: "opencompany.goat_brain_agent_ingest_finished",
      brain_ref: brainRef,
      source_ref: input.sourceRef,
      skipped,
      steps: loop.steps,
      tool_calls: loop.toolCalls,
      mutations: loop.mutations,
    });

    const synced = await syncGoatBrainFilesFromRoot({
      brainRef,
      userWorkosId: input.userWorkosId,
      root,
      baseSnapshot: materialized,
      db,
    });
    if (synced.conflicts.length > 0) {
      throw new Error(
        `Brain changed while the ingestion agent was running. Retry before writing ${synced.conflicts
          .map((conflict) => conflict.path)
          .join(", ")}.`,
      );
    }

    return {
      brainRef,
      skipped,
      steps: loop.steps,
      toolCalls: loop.toolCalls,
      mutations: loop.mutations,
      upserted: synced.upserted,
      deleted: synced.deleted,
      usage: loop.usage,
      summary: loop.finalText.slice(0, RESULT_SUMMARY_LIMIT),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runJamieMeetingAgentIngest(
  input: {
    userWorkosId: string;
    brainRef: string | null;
    item: NormalizedJamieMeetingSourceItem;
    env: GoatBrainAgentIngestEnv;
    signal?: AbortSignal;
  },
  deps: GoatBrainAgentIngestDeps = {},
): Promise<Record<string, unknown>> {
  // The transcript snapshot is written deterministically before the agent
  // runs: evidence is the dump, and a 400KB transcript should not round-trip
  // through model tool calls.
  const evidence = buildJamieMeetingEvidenceWrite(input.item);
  const session = await runBrainAgentIngestSession({
    userWorkosId: input.userWorkosId,
    brainRef: input.brainRef,
    sourceRef: input.item.sourceRef,
    env: input.env,
    system: JAMIE_MEETING_INGEST_SYSTEM_PROMPT,
    buildPrompt: () => buildJamieMeetingAgentIngestPrompt(input.item, evidence),
    prepareRoot: (root) =>
      writeLocalBrainFile(root, evidence.evidencePath, evidence.evidenceContent),
    ...(input.signal ? { signal: input.signal } : {}),
    deps,
  });

  return {
    ...session,
    model: GOAT_BRAIN_AGENT_INGEST_MODEL,
    evidenceBrainId: evidence.evidenceBrainId,
    meetingBrainId: evidence.meetingBrainId,
    truncatedTranscript: evidence.truncatedTranscript,
  };
}

export async function runGoatChatCaptureAgentIngest(
  input: {
    userWorkosId: string;
    brainRef: string | null;
    item: NormalizedGoatChatCaptureSourceItem;
    env: GoatBrainAgentIngestEnv;
    signal?: AbortSignal;
  },
  deps: GoatBrainAgentIngestDeps = {},
): Promise<Record<string, unknown>> {
  const session = await runBrainAgentIngestSession({
    userWorkosId: input.userWorkosId,
    brainRef: input.brainRef,
    sourceRef: input.item.sourceRef,
    env: input.env,
    system: GOAT_CHAT_CAPTURE_INGEST_SYSTEM_PROMPT,
    buildPrompt: () => buildGoatChatCaptureAgentIngestPrompt(input.item),
    commands: CAPTURE_AGENT_CLI_COMMANDS,
    ...(input.signal ? { signal: input.signal } : {}),
    deps,
  });

  return {
    ...session,
    model: GOAT_BRAIN_AGENT_INGEST_MODEL,
    draftBrainId: input.item.content.capture.draftBrainId,
  };
}

export async function runUploadAssetAgentIngest(
  input: {
    userWorkosId: string;
    brainRef: string | null;
    item: NormalizedUploadAssetSourceItem;
    env: GoatBrainAgentIngestEnv;
    signal?: AbortSignal;
  },
  deps: GoatBrainAgentIngestDeps = {},
): Promise<Record<string, unknown>> {
  const db = getDb();
  const brainRef =
    input.brainRef ?? (await getDefaultGoatBrainForUser(input.userWorkosId, { db }))?.id;
  if (!brainRef) {
    throw new Error(`No accessible Goat brain found for user ${input.userWorkosId}.`);
  }
  const asset = input.item.content.asset;
  const row = await getGoatBrainFile({ brainRef, fileId: asset.documentId }, { db });
  // The user may delete the document between upload and ingestion; that is a
  // clean no-op, not a retryable failure.
  if (!row) {
    return { brainRef, skipped: true, reason: "document_missing", documentId: asset.documentId };
  }
  if (row.format === "markdown" || !row.assetStorageKey) {
    throw new Error(`Brain document ${asset.documentId} is not a binary asset.`);
  }

  // Stage 1 (deterministic): fetch the bytes, extract text, record it on the
  // row so materialization inside the agent session includes the generated
  // extracted-text block and retrieval can index it.
  const bytes = await downloadGoatBrainAssetBytes(row.assetStorageKey, input.env);
  const extractedText = row.format === "pdf" ? await extractPdfText(bytes) : "";
  await updateGoatBrainAssetExtraction(
    {
      brainRef,
      userWorkosId: input.userWorkosId,
      fileId: row.id,
      extractedText,
      assetContentHash: createHash("sha256").update(bytes).digest("hex"),
      assetSizeBytes: bytes.byteLength,
    },
    { db },
  );

  const truncatedText = Buffer.byteLength(extractedText, "utf8") > PROMPT_ASSET_TEXT_BYTES;
  const session = await runBrainAgentIngestSession({
    userWorkosId: input.userWorkosId,
    brainRef,
    sourceRef: input.item.sourceRef,
    env: input.env,
    system: UPLOAD_ASSET_INGEST_SYSTEM_PROMPT,
    buildPrompt: () =>
      buildUploadAssetAgentIngestPrompt(input.item, {
        extractedText: truncateByBytes(extractedText, PROMPT_ASSET_TEXT_BYTES),
        truncatedText,
      }),
    ...(input.signal ? { signal: input.signal } : {}),
    deps,
  });

  return {
    ...session,
    model: GOAT_BRAIN_AGENT_INGEST_MODEL,
    documentId: row.id,
    assetBrainId: row.brainId,
    extractedTextBytes: Buffer.byteLength(extractedText, "utf8"),
  };
}

async function downloadGoatBrainAssetBytes(
  storageKey: string,
  env: GoatBrainAgentIngestEnv,
): Promise<Buffer> {
  // Same pattern as attachment-hydration.ts: the blob lives in the PRIVATE
  // store; the token defaults to BLOB_READ_WRITE_TOKEN, overridden when the
  // runner env provides one explicitly.
  const { get } = await import("@vercel/blob");
  const result = await get(storageKey, {
    access: "private",
    useCache: false,
    ...(env.blobReadWriteToken ? { token: env.blobReadWriteToken } : {}),
  });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(`Could not download Goat brain asset blob (status ${result?.statusCode}).`);
  }
  const chunks: Uint8Array[] = [];
  const reader = result.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return typeof text === "string" ? text.trim() : "";
  } catch (error) {
    logger.warn("Goat Brain asset text extraction failed", {
      event: "opencompany.goat_brain_asset_extraction_failed",
      error,
    });
    return "";
  }
}

async function runIngestAgentLoop(input: {
  root: string;
  cliPath: string;
  gatewayApiKey: string;
  system: string;
  prompt: string;
  commands?: readonly string[];
  signal?: AbortSignal;
  runCli?: GoatBrainAgentCliRunner;
}) {
  const { generateText } = getBraintrustAISDK(ai);
  const gateway = ai.createGateway({ apiKey: input.gatewayApiKey });
  const abort = new AbortController();
  const onParentAbort = () => abort.abort(input.signal?.reason);
  if (input.signal?.aborted) onParentAbort();
  input.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(
    () => abort.abort(new Error("Goat Brain ingestion agent timed out.")),
    GOAT_BRAIN_AGENT_INGEST_TIMEOUT_MS,
  );
  timeout.unref?.();

  let toolCalls = 0;
  let mutations = 0;
  const runCli = input.runCli ?? runGoatBrainAgentCli;
  const commands = input.commands ?? AGENT_CLI_COMMANDS;
  const tools = {
    goat_brain: ai.tool({
      description: [
        "Run one goat-brain CLI command against this brain.",
        `Commands: ${commands.join(", ")}.`,
        'Pass everything after the command name as args tokens, e.g. {"command":"query","args":["hiring plan","--limit","5"]} or {"command":"timeline-add","args":["ada","--body","Met at roadmap review.","--source-ref","jamie:meeting:123"]}.',
        'For long bodies use stdin with the matching flag, e.g. {"command":"create","args":["--type","person","--id","ada","--title","Ada","--truth-stdin"],"stdin":"..."}.',
        'Call {"command":"help","args":["<command>"]} for command-specific usage.',
      ].join(" "),
      inputSchema: ai.jsonSchema<{ command: string; args?: string[]; stdin?: string }>({
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: [...commands],
            description: "goat-brain CLI command to run.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "CLI tokens after the command: positionals and --flag values.",
          },
          stdin: {
            type: "string",
            description: "Text piped to stdin for --truth-stdin / --body-stdin / --detail-stdin.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      }),
      execute: async (args) => {
        toolCalls += 1;
        const invalid = validateGoatBrainAgentInvocation(args, commands);
        if (invalid) return { ok: false, error: invalid };
        const result = await runCli({
          cliPath: input.cliPath,
          root: input.root,
          argv: [args.command, ...(args.args ?? [])],
          gatewayApiKey: input.gatewayApiKey,
          ...(args.stdin ? { stdin: args.stdin } : {}),
          signal: abort.signal,
        });
        if (result.ok && !READ_ONLY_AGENT_CLI_COMMANDS.has(args.command)) {
          mutations += 1;
        }
        return {
          ok: result.ok,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout, AGENT_CLI_STDOUT_LIMIT),
          stderr: truncate(result.stderr, AGENT_CLI_STDERR_LIMIT),
          ...(result.error ? { error: result.error } : {}),
        };
      },
    }),
  };

  try {
    const result = await generateText({
      model: gateway(GOAT_BRAIN_AGENT_INGEST_MODEL),
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
      tools,
      stopWhen: [ai.stepCountIs(GOAT_BRAIN_AGENT_INGEST_MAX_STEPS)],
      abortSignal: abort.signal,
    });
    const usage = result.totalUsage;
    return {
      finalText: result.text.trim(),
      steps: result.steps.length,
      toolCalls,
      mutations,
      usage: {
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
      },
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onParentAbort);
  }
}

export function validateGoatBrainAgentInvocation(
  args: {
    command: string;
    args?: string[];
    stdin?: string;
  },
  commands: readonly string[] = AGENT_CLI_COMMANDS,
): string | null {
  if (!commands.includes(args.command)) {
    return `Command "${args.command}" is not available to the ingestion agent. Available commands: ${commands.join(", ")}.`;
  }
  const tokens = args.args ?? [];
  if (tokens.some((token) => typeof token !== "string")) {
    return "args must be an array of strings.";
  }
  const rootFlag = tokens.find((token) => token === "--root" || token.startsWith("--root="));
  if (rootFlag) {
    return "The --root flag is not allowed; the brain root is fixed for this job.";
  }
  return null;
}

const runGoatBrainAgentCli: GoatBrainAgentCliRunner = async (input) => {
  const child = spawn(process.execPath, [input.cliPath, ...input.argv], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      GOAT_BRAIN_ROOT: input.root,
      VERCEL_AI_GATEWAY_API_KEY: input.gatewayApiKey,
      ...(process.env.GOAT_BRAIN_GATEWAY_BASE_URL
        ? { GOAT_BRAIN_GATEWAY_BASE_URL: process.env.GOAT_BRAIN_GATEWAY_BASE_URL }
        : {}),
      ...(process.env.GOAT_BRAIN_EMBEDDING_MODEL
        ? { GOAT_BRAIN_EMBEDDING_MODEL: process.env.GOAT_BRAIN_EMBEDDING_MODEL }
        : {}),
    },
    stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (input.stdin && child.stdin) {
    child.stdin.on("error", () => {
      // The child may exit before consuming stdin; the close handler below
      // still reports the command result.
    });
    child.stdin.end(input.stdin);
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return new Promise<GoatBrainAgentCliResult>((resolve) => {
    let settled = false;
    const settle = (result: GoatBrainAgentCliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle({ ok: false, exitCode: null, stdout, stderr, error: "goat-brain CLI timed out." });
    }, AGENT_CLI_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGTERM");
      settle({ ok: false, exitCode: null, stdout, stderr, error: "goat-brain CLI was aborted." });
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      settle({ ok: false, exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      settle({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        ...(code === 0 ? {} : { error: "goat-brain CLI failed." }),
      });
    });
  });
};

function truncate(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}
