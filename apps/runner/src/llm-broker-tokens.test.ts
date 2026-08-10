import { describe, expect, it, vi } from "vitest";
import {
  type BrokerSpendInput,
  type BrokerTokenStore,
  type BrokerTokenTotals,
  DEFAULT_BROKER_TOKEN_BUDGET_USD_MICROS,
  hashBrokerToken,
  mintBrokerToken,
  settleBrokerToken,
  settleBrokerTokensForSession,
  settleExpiredBrokerTokens,
  validateBrokerToken,
  withBrokerDelegation,
} from "./llm-broker-tokens";

type StoredToken = {
  row: Parameters<BrokerTokenStore["insertToken"]>[0];
  totals: BrokerTokenTotals;
  revoked: boolean;
  settled: boolean;
  settledToolUsageId: number | null;
};

function createFakeStore() {
  const tokens = new Map<string, StoredToken>();
  const spends: BrokerSpendInput[] = [];
  const toolUsageRows: Array<Record<string, unknown>> = [];
  let nextToolUsageId = 1;

  const store: BrokerTokenStore = {
    async insertToken(row) {
      tokens.set(row.id, {
        row,
        totals: {
          id: row.id,
          sessionId: row.sessionId,
          workspaceId: row.workspaceId,
          messageId: row.messageId,
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          provider: row.provider,
          spentUsdMicros: 0,
          requestCount: 0,
          inputTokens: 0,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 0,
          unparsedRequestCount: 0,
          settledToolUsageId: null,
        },
        revoked: false,
        settled: false,
        settledToolUsageId: null,
      });
    },
    async findActiveByHash(tokenHash) {
      for (const token of tokens.values()) {
        if (token.row.tokenHash !== tokenHash) continue;
        if (token.revoked || token.settled || token.row.expiresAt.getTime() <= Date.now()) {
          return null;
        }
        return {
          id: token.row.id,
          sessionId: token.row.sessionId,
          workspaceId: token.row.workspaceId,
          toolName: token.row.toolName,
          provider: token.row.provider,
          budgetUsdMicros: token.row.budgetUsdMicros,
          spentUsdMicros: token.totals.spentUsdMicros,
        };
      }
      return null;
    },
    async recordSpend(input) {
      spends.push(input);
      const token = tokens.get(input.tokenId);
      if (!token) throw new Error("unknown token");
      token.totals.spentUsdMicros += input.costUsdMicros;
      token.totals.requestCount += 1;
      token.totals.inputTokens += input.inputTokens;
      token.totals.inputCacheReadTokens += input.inputCacheReadTokens;
      token.totals.inputCacheWriteTokens += input.inputCacheWriteTokens;
      token.totals.outputTokens += input.outputTokens;
      if (!input.usageParsed) token.totals.unparsedRequestCount += 1;
    },
    async revokeToken(tokenId) {
      const token = tokens.get(tokenId);
      if (token) token.revoked = true;
    },
    async revokeTokensForSession(sessionId) {
      const ids: string[] = [];
      for (const token of tokens.values()) {
        if (token.row.sessionId === sessionId && !token.revoked) {
          token.revoked = true;
          ids.push(token.row.id);
        }
      }
      return ids;
    },
    async claimSettlement(tokenId) {
      const token = tokens.get(tokenId);
      if (!token || token.settled) return null;
      token.settled = true;
      return { ...token.totals };
    },
    async releaseSettlementClaim(tokenId) {
      const token = tokens.get(tokenId);
      if (token) token.settled = false;
    },
    async findSettleableTokenIds() {
      return [...tokens.values()]
        .filter((token) => !token.settled && token.revoked)
        .map((token) => token.row.id);
    },
    async insertSettledToolUsage(input) {
      const existing = toolUsageRows.find(
        (row) => row.providerRequestId === input.providerRequestId,
      );
      if (existing && typeof existing.id === "number") {
        return { id: existing.id };
      }
      const id = nextToolUsageId;
      nextToolUsageId += 1;
      toolUsageRows.push({ id, ...input });
      return { id };
    },
    async linkSettledToolUsage(tokenId, toolUsageId) {
      const token = tokens.get(tokenId);
      if (token) {
        token.settledToolUsageId = toolUsageId;
        token.totals.settledToolUsageId = toolUsageId;
      }
    },
  };

  return { store, tokens, spends, toolUsageRows };
}

const MINT_INPUT = {
  sessionId: "session-1",
  workspaceId: "workspace-1",
  messageId: "message-1",
  toolCallId: "tool-call-1",
  toolName: "opencode_coder",
  provider: "gateway" as const,
  ttlMs: 60_000,
};

function settlementDeps(store: BrokerTokenStore) {
  const recordDebit = vi.fn(async () => ({ ok: true as const }));
  const getDbImpl = vi.fn(() => ({ fake: true }));
  return {
    deps: {
      store,
      recordDebit: recordDebit as never,
      getDbImpl: getDbImpl as never,
    },
    recordDebit,
  };
}

describe("mintBrokerToken / validateBrokerToken", () => {
  it("mints an opaque ocbt_ token and stores only its hash", async () => {
    const { store, tokens } = createFakeStore();
    const minted = await mintBrokerToken(MINT_INPUT, store);

    expect(minted.token).toMatch(/^ocbt_[0-9a-f]{48}$/);
    const stored = tokens.get(minted.tokenId);
    expect(stored?.row.tokenHash).toBe(hashBrokerToken(minted.token));
    expect(stored?.row.tokenHash).not.toContain(minted.token);
    expect(stored?.row.budgetUsdMicros).toBe(DEFAULT_BROKER_TOKEN_BUDGET_USD_MICROS);
    expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(await validateBrokerToken(minted.token, store)).toMatchObject({
      id: minted.tokenId,
      sessionId: "session-1",
      toolName: "opencode_coder",
      provider: "gateway",
    });
  });

  it("allows a caller to set a lower explicit budget", async () => {
    const { store, tokens } = createFakeStore();
    const minted = await mintBrokerToken({ ...MINT_INPUT, budgetUsdMicros: 50_000 }, store);

    expect(tokens.get(minted.tokenId)?.row.budgetUsdMicros).toBe(50_000);
    expect(await validateBrokerToken(minted.token, store)).toMatchObject({
      budgetUsdMicros: 50_000,
    });
  });

  it("caps explicit budgets at the hard-coded default", async () => {
    const { store, tokens } = createFakeStore();
    const minted = await mintBrokerToken({ ...MINT_INPUT, budgetUsdMicros: 10_000_000 }, store);

    expect(tokens.get(minted.tokenId)?.row.budgetUsdMicros).toBe(
      DEFAULT_BROKER_TOKEN_BUDGET_USD_MICROS,
    );
  });

  it("rejects tokens without the prefix and revoked tokens", async () => {
    const { store } = createFakeStore();
    const minted = await mintBrokerToken(MINT_INPUT, store);

    expect(await validateBrokerToken("sk-not-a-broker-token", store)).toBeNull();
    await store.revokeToken(minted.tokenId);
    expect(await validateBrokerToken(minted.token, store)).toBeNull();
  });
});

describe("settleBrokerToken", () => {
  it("bills the metered spend once: tool usage row + debit", async () => {
    const { store, tokens, toolUsageRows } = createFakeStore();
    const minted = await mintBrokerToken(MINT_INPUT, store);
    await store.recordSpend({
      tokenId: minted.tokenId,
      sessionId: "session-1",
      endpoint: "chat.completions",
      model: "anthropic/claude-sonnet-4.6",
      streamed: true,
      upstreamStatus: 200,
      inputTokens: 1_000,
      inputCacheReadTokens: 200,
      inputCacheWriteTokens: 0,
      outputTokens: 300,
      costUsdMicros: 1_000_000,
      usageParsed: true,
      latencyMs: 1200,
      rawUsage: {},
    });

    const { deps, recordDebit } = settlementDeps(store);
    const result = await settleBrokerToken(minted.tokenId, deps);

    expect(result).toMatchObject({ settled: true, billed: true, toolUsageId: 1 });
    expect(toolUsageRows[0]).toMatchObject({
      sessionId: "session-1",
      messageId: "message-1",
      toolCallId: "tool-call-1",
      toolName: "opencode_coder",
      provider: "opencode",
      operation: "brokered",
      costUsdMicros: 1_000_000,
    });
    // Billing v6 passes through metered provider cost without a platform fee.
    expect(recordDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tool_usage",
        toolUsageId: 1,
        providerCostUsdMicros: 1_000_000,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 1_000_000,
        metadata: expect.objectContaining({ brokerTokenId: minted.tokenId }),
      }),
    );
    expect(tokens.get(minted.tokenId)?.settledToolUsageId).toBe(1);
  });

  it("is idempotent: the settlement CAS has exactly one winner", async () => {
    const { store } = createFakeStore();
    const minted = await mintBrokerToken(MINT_INPUT, store);
    await store.recordSpend({
      tokenId: minted.tokenId,
      sessionId: "session-1",
      endpoint: "embeddings",
      model: "openai/text-embedding-3-small",
      streamed: false,
      upstreamStatus: 200,
      inputTokens: 10,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
      costUsdMicros: 50,
      usageParsed: true,
      latencyMs: 80,
      rawUsage: {},
    });

    const { deps, recordDebit } = settlementDeps(store);
    const first = await settleBrokerToken(minted.tokenId, deps);
    const second = await settleBrokerToken(minted.tokenId, deps);

    expect(first.settled).toBe(true);
    expect(second).toEqual({ settled: false, reason: "already_settled" });
    expect(recordDebit).toHaveBeenCalledTimes(1);
  });

  it("releases a failed settlement claim so the sweeper can retry without duplicate usage rows", async () => {
    const { store, tokens, toolUsageRows } = createFakeStore();
    const minted = await mintBrokerToken(MINT_INPUT, store);
    await store.recordSpend({
      tokenId: minted.tokenId,
      sessionId: "session-1",
      endpoint: "chat.completions",
      model: "anthropic/claude-sonnet-4.6",
      streamed: true,
      upstreamStatus: 200,
      inputTokens: 100,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 20,
      costUsdMicros: 100_000,
      usageParsed: true,
      latencyMs: 100,
      rawUsage: {},
    });

    const { deps, recordDebit } = settlementDeps(store);
    recordDebit.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(settleBrokerToken(minted.tokenId, deps)).rejects.toThrow("ledger unavailable");
    expect(tokens.get(minted.tokenId)?.settled).toBe(false);
    expect(tokens.get(minted.tokenId)?.settledToolUsageId).toBe(1);

    await expect(settleBrokerToken(minted.tokenId, deps)).resolves.toMatchObject({
      settled: true,
      billed: true,
      toolUsageId: 1,
    });
    expect(toolUsageRows).toHaveLength(1);
    expect(recordDebit).toHaveBeenCalledTimes(2);
  });

  it("settles unused tokens as a billing no-op", async () => {
    const { store, toolUsageRows } = createFakeStore();
    const minted = await mintBrokerToken(MINT_INPUT, store);

    const { deps, recordDebit } = settlementDeps(store);
    const result = await settleBrokerToken(minted.tokenId, deps);

    expect(result).toEqual({ settled: true, billed: false });
    expect(toolUsageRows).toHaveLength(0);
    expect(recordDebit).not.toHaveBeenCalled();
  });
});

describe("withBrokerDelegation", () => {
  it("revokes and settles on success and on error", async () => {
    const { store, tokens } = createFakeStore();
    const { deps } = settlementDeps(store);

    const value = await withBrokerDelegation(MINT_INPUT, async () => "done", deps);
    expect(value).toBe("done");
    const [first] = [...tokens.values()];
    expect(first?.revoked).toBe(true);
    expect(first?.settled).toBe(true);

    await expect(
      withBrokerDelegation(
        MINT_INPUT,
        async () => {
          throw new Error("tool failed");
        },
        deps,
      ),
    ).rejects.toThrow("tool failed");
    const all = [...tokens.values()];
    expect(all).toHaveLength(2);
    expect(all[1]?.revoked).toBe(true);
    expect(all[1]?.settled).toBe(true);
  });
});

describe("session + sweeper settlement", () => {
  it("settleBrokerTokensForSession revokes and settles every session token", async () => {
    const { store, tokens } = createFakeStore();
    await mintBrokerToken(MINT_INPUT, store);
    await mintBrokerToken({ ...MINT_INPUT, toolCallId: "tool-call-2" }, store);
    await mintBrokerToken({ ...MINT_INPUT, sessionId: "other-session" }, store);

    const { deps } = settlementDeps(store);
    await settleBrokerTokensForSession("session-1", deps);

    const states = [...tokens.values()].map((token) => ({
      sessionId: token.row.sessionId,
      settled: token.settled,
    }));
    expect(states).toEqual([
      { sessionId: "session-1", settled: true },
      { sessionId: "session-1", settled: true },
      { sessionId: "other-session", settled: false },
    ]);
  });

  it("settleExpiredBrokerTokens settles crash leftovers", async () => {
    const { store, tokens } = createFakeStore();
    const minted = await mintBrokerToken(MINT_INPUT, store);
    // Simulate a runner death after revoke but before settle.
    await store.revokeToken(minted.tokenId);

    const { deps } = settlementDeps(store);
    const settled = await settleExpiredBrokerTokens(deps);
    expect(settled).toBe(1);
    expect(tokens.get(minted.tokenId)?.settled).toBe(true);
  });
});
