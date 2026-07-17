import { MOCK_TOOL_CATALOG } from "../code-tool-interface/catalog";
import { CatalogService } from "../code-tool-interface/catalog-service";
import { contractFor, renderTypeScriptDefinitions, toolEffect } from "./contracts";
import type { DiscoveryResult } from "./types";

const MAX_QUERIES = 10;
const MAX_LOADED_TOOLS = 12;
const SEARCH_CANDIDATE_POOL = 20;
const READ_ACTIONS = new Set([
  "compare",
  "fetch",
  "find",
  "get",
  "inspect",
  "list",
  "read",
  "search",
]);
const WRITE_ACTIONS = new Set([
  "add",
  "approve",
  "archive",
  "assign",
  "append",
  "broadcast",
  "cancel",
  "close",
  "copy",
  "create",
  "delete",
  "duplicate",
  "invite",
  "make",
  "merge",
  "move",
  "notify",
  "pin",
  "post",
  "publish",
  "react",
  "remove",
  "rename",
  "reply",
  "rerun",
  "schedule",
  "send",
  "set",
  "star",
  "submit",
  "trash",
  "unpin",
  "update",
  "upload",
]);
const ACTIONS = new Set([...READ_ACTIONS, ...WRITE_ACTIONS, "open", "review"]);

const SEARCH_DOCUMENTS = MOCK_TOOL_CATALOG.map((tool) => ({
  tool,
  pathTerms: new Set(searchTerms(tool.path)),
  summaryTerms: new Set(searchTerms(tool.summary)),
  schemaTerms: new Set(searchTerms(JSON.stringify(tool.inputSchema))),
}));

const DOCUMENT_FREQUENCY = new Map<string, number>();
for (const document of SEARCH_DOCUMENTS) {
  for (const term of new Set([
    ...document.pathTerms,
    ...document.summaryTerms,
    ...document.schemaTerms,
  ])) {
    DOCUMENT_FREQUENCY.set(term, (DOCUMENT_FREQUENCY.get(term) ?? 0) + 1);
  }
}

export function discoverToolContracts(
  catalog: CatalogService,
  input: { queries: string[]; readCandidatesPerQuery?: number },
): DiscoveryResult {
  const queries = normalizeQueries(input.queries);
  const paths: string[] = [];
  const intents: DiscoveryResult["intents"] = [];
  for (const query of queries) {
    const effect = requestedEffect(query);
    const limitPerQuery = effect === "write" ? 1 : clamp(input.readCandidatesPerQuery ?? 2, 1, 4);
    const candidates = rerankCandidates(
      query,
      catalog.search(query, SEARCH_CANDIDATE_POOL),
      effect,
    ).slice(0, limitPerQuery);
    if (candidates.length === 0) {
      throw new Error(`Tool discovery returned no matches for: ${query}`);
    }
    const candidatePaths: string[] = [];
    for (const match of candidates) {
      candidatePaths.push(match.path);
      if (!paths.includes(match.path)) paths.push(match.path);
      if (paths.length >= MAX_LOADED_TOOLS) break;
    }
    intents.push({ query, effect, candidatePaths });
    if (paths.length >= MAX_LOADED_TOOLS) break;
  }
  if (paths.length === 0) throw new Error("Tool discovery returned no matches.");

  const contracts = paths.map((path) => {
    catalog.describe(path);
    return contractFor(path);
  });
  return {
    queries,
    intents,
    loadedPaths: paths,
    contracts,
    typeScriptDefinitions: renderTypeScriptDefinitions(contracts),
  };
}

function rerankCandidates(
  query: string,
  candidates: Array<{ path: string; summary: string; score: number }>,
  effect: DiscoveryResult["intents"][number]["effect"],
) {
  const queryTermList = searchTerms(query);
  const queryTerms = new Set(queryTermList);
  const queryActions = new Set(
    [...queryTerms].filter((term) => ACTIONS.has(term)).map(canonicalAction),
  );
  const lexicalScore = new Map(candidates.map((candidate) => [candidate.path, candidate.score]));
  return SEARCH_DOCUMENTS.filter(
    ({ tool }) =>
      lexicalScore.has(tool.path) &&
      toolEffect(tool.operation) === effect &&
      (effect === "read" || actionTermsMatch(queryActions, tool.operation, tool.summary)),
  )
    .map(({ tool, pathTerms, summaryTerms, schemaTerms }) => {
      let score = (lexicalScore.get(tool.path) ?? 0) * 0.05;
      for (const term of queryTerms) {
        const frequency = DOCUMENT_FREQUENCY.get(term) ?? 0;
        const rarity = Math.log((SEARCH_DOCUMENTS.length + 1) / (frequency + 1)) + 1;
        const inPath = pathTerms.has(term);
        const inSummary = summaryTerms.has(term);
        const inSchema = schemaTerms.has(term);
        if (inPath || inSummary || inSchema) {
          score += rarity * (inPath ? 2.4 : 1.4);
          if (inPath && inSummary) score += rarity * 0.4;
          if (inSchema) score += rarity * 0.5;
        } else {
          score -= rarity * 1.5;
        }
      }
      score += queryActions.size * 20;
      score += orderedOperationScore(queryTermList, searchTerms(tool.operation));
      return { path: tool.path, summary: tool.summary, score };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function orderedOperationScore(queryTerms: string[], operationTerms: string[]) {
  let cursor = 0;
  const matchedIndexes: number[] = [];
  for (const operationTerm of operationTerms) {
    const index = queryTerms.indexOf(operationTerm, cursor);
    if (index < 0) return 0;
    matchedIndexes.push(index);
    cursor = index + 1;
  }
  const first = matchedIndexes[0];
  const last = matchedIndexes.at(-1);
  if (first === undefined || last === undefined) return 0;
  const span = last - first + 1;
  return (40 * operationTerms.length) / span;
}

function actionTermsMatch(queryActions: ReadonlySet<string>, operation: string, summary: string) {
  if (queryActions.size === 0) return toolEffect(operation) === "read";
  const candidateActions = new Set(
    [...searchTerms(operation), ...searchTerms(summary)]
      .filter((term) => ACTIONS.has(term))
      .map(canonicalAction),
  );
  return [...queryActions].every((action) => candidateActions.has(action));
}

function canonicalAction(action: string) {
  if (["broadcast", "notify", "post"].includes(action)) return "send";
  if (["approve", "submit"].includes(action)) return "review";
  if (["make"].includes(action)) return "create";
  if (["find"].includes(action)) return "search";
  if (["inspect", "read"].includes(action)) return "get";
  return action;
}

function requestedEffect(query: string) {
  if (/\bopen\s+(?:a\s+)?(?:dm|direct message)\b/i.test(query)) {
    return "write" as const;
  }
  const actionTerms = searchTerms(query).filter((term) => ACTIONS.has(term));
  return actionTerms.some((term) => WRITE_ACTIONS.has(term))
    ? ("write" as const)
    : ("read" as const);
}

export function availableIntegrationInventory() {
  return [...new Set(MOCK_TOOL_CATALOG.map((tool) => tool.integration))].sort();
}

function normalizeQueries(rawQueries: unknown) {
  if (!Array.isArray(rawQueries)) throw new Error("queries must be an array of intent strings.");
  const queries = rawQueries
    .map((query) => (typeof query === "string" ? query.trim() : ""))
    .filter(Boolean);
  if (queries.length === 0) throw new Error("At least one discovery query is required.");
  if (queries.length > MAX_QUERIES) {
    throw new Error(`At most ${MAX_QUERIES} discovery queries are allowed.`);
  }
  return [...new Set(queries)];
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function searchTerms(value: string) {
  return value
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
    .filter((term) => !["and", "by", "for", "from", "in", "into", "the", "to"].includes(term))
    .map((term) => (term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term));
}
