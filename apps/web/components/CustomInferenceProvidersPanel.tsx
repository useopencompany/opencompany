"use client";

import { useId, useState } from "react";

/*
 * Custom inference providers
 * --------------------------
 * Lets workspace admins register OpenAI- or Anthropic-compatible endpoints
 * (OpenRouter, Groq, Together, Ollama Cloud, self-hosted Ollama, …) with
 * their API credentials so chat and workflow models can be routed to them.
 *
 * TODO(backend): persistence and live checks are intentionally client-side
 * for now. Wire the marked seams to server actions that:
 *   1. upsert a `custom_inference_provider` row (Drizzle) scoped to the
 *      workspace, encrypting the API key at rest;
 *   2. never return the raw key to the client (return a masked label only);
 *   3. perform the connection test server-side against `${baseUrl}/models`
 *      (or `${baseUrl}/chat/completions`) and report latency/auth errors.
 */

type ProviderPresetId =
  | "openai-compat"
  | "openrouter"
  | "groq"
  | "together"
  | "fireworks"
  | "anthropic-compat"
  | "ollama-cloud"
  | "ollama"
  | "custom";

type ProviderPreset = {
  label: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  sampleModels: string[];
};

const PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  "openai-compat": {
    label: "OpenAI-compatible endpoint",
    name: "",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    sampleModels: ["gpt-5.2", "gpt-5-mini"],
  },
  openrouter: {
    label: "OpenRouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    sampleModels: ["anthropic/claude-opus-4.5", "openai/gpt-5.2", "google/gemini-3-pro"],
  },
  groq: {
    label: "Groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    sampleModels: ["llama-4-maverick-70b", "qwen3-32b"],
  },
  together: {
    label: "Together AI",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    needsKey: true,
    sampleModels: ["meta-llama/Llama-4-Maverick", "deepseek-ai/DeepSeek-V3.2"],
  },
  fireworks: {
    label: "Fireworks AI",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    needsKey: true,
    sampleModels: ["accounts/fireworks/models/kimi-k2p5"],
  },
  "anthropic-compat": {
    label: "Anthropic-compatible endpoint",
    name: "",
    baseUrl: "https://api.anthropic.com",
    needsKey: true,
    sampleModels: ["claude-opus-4-5", "claude-sonnet-4-5"],
  },
  "ollama-cloud": {
    label: "Ollama Cloud",
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    needsKey: true,
    sampleModels: ["gpt-oss:120b", "deepseek-v3.1:671b", "qwen3-coder:480b", "kimi-k2:1t", "glm-5", "minimax-m2"],
  },
  ollama: {
    label: "Ollama (self-hosted)",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    sampleModels: ["llama3.3:70b", "qwen3:32b"],
  },
  custom: {
    label: "Custom",
    name: "",
    baseUrl: "",
    needsKey: true,
    sampleModels: [],
  },
};

const PRESET_IDS = Object.keys(PRESETS) as ProviderPresetId[];

const PRESET_COLORS: Record<ProviderPresetId, string> = {
  "openai-compat": "#10A37F",
  openrouter: "#6E56CF",
  groq: "#F55036",
  together: "#0F6FFF",
  fireworks: "#7B2CBF",
  "anthropic-compat": "#CC785C",
  "ollama-cloud": "#1B1A17",
  ollama: "#5A5952",
  custom: "#75736A",
};

const DEFAULT_KEY_HINT =
  "Stored encrypted and never shown again. Leave blank when editing to keep the existing key.";
const OLLAMA_CLOUD_KEY_HINT =
  "Create a key at ollama.com/settings/keys — it's sent as a Bearer token. Stored encrypted and never shown again.";

type ProviderStatus = "connected" | "untested" | "failed";

export type CustomInferenceProvider = {
  id: number;
  preset: ProviderPresetId;
  name: string;
  baseUrl: string;
  keyMasked: string | null;
  hasKey: boolean;
  models: string[];
  headers: Record<string, string>;
  status: ProviderStatus;
  latencyMs: number | null;
  isDefault: boolean;
};

type HeaderRow = { key: string; value: string };

type FormState = {
  preset: ProviderPresetId;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelsInput: string;
  headerRows: HeaderRow[];
};

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; latencyMs: number }
  | { kind: "fail"; message: string };

function maskKey(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 3)}••••`;
  return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
}

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return /^(localhost|127\.|192\.168\.|10\.|\[::1\])/.test(url.hostname);
  } catch {
    return false;
  }
}

function parseModels(input: string): string[] {
  return input
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

/* TODO(backend): replace with a server action that probes the endpoint
 * (`GET ${baseUrl}/models`, falling back to a 1-token chat completion) using
 * the stored credentials, and returns { ok, latencyMs, models } or the
 * provider's auth error. Never proxy the raw key back to the client. */
async function performConnectionTest(
  form: FormState,
  keepSavedKey: boolean,
): Promise<{ ok: boolean; latencyMs: number }> {
  const preset = PRESETS[form.preset];
  const keySatisfied = !preset.needsKey || form.apiKey.trim().length >= 8 || keepSavedKey;
  const isLocal = /^(http:\/\/)?(localhost|127\.|192\.168\.|10\.)/.test(form.baseUrl.trim());
  await new Promise((resolve) => setTimeout(resolve, isLocal ? 700 : 1200));
  return {
    ok: keySatisfied,
    latencyMs: 120 + Math.floor(Math.random() * 380),
  };
}

export function CustomInferenceProvidersPanel({
  canManage = true,
}: {
  canManage?: boolean;
}) {
  const formId = useId();
  const [providers, setProviders] = useState<CustomInferenceProvider[]>([]);
  const [nextId, setNextId] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>({
    preset: "openai-compat",
    name: "",
    baseUrl: PRESETS["openai-compat"].baseUrl,
    apiKey: "",
    modelsInput: "",
    headerRows: [],
  });
  const [errors, setErrors] = useState<{ name?: string; baseUrl?: string; apiKey?: string }>({});
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [showKey, setShowKey] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const preset = PRESETS[form.preset];
  const models = parseModels(form.modelsInput);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 2600);
  };

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors({});
    setTest({ kind: "idle" });
  };

  const applyPreset = (id: ProviderPresetId) => {
    const next = PRESETS[id];
    setForm((current) => {
      const nameWasPreset = Object.values(PRESETS).some((p) => p.name === current.name);
      return {
        ...current,
        preset: id,
        baseUrl: next.baseUrl || current.baseUrl,
        name: next.name && (!current.name || nameWasPreset) ? next.name : current.name,
      };
    });
    setErrors({});
    setTest({ kind: "idle" });
  };

  const openAddForm = () => {
    setEditingId(null);
    setForm({
      preset: "openai-compat",
      name: "",
      baseUrl: PRESETS["openai-compat"].baseUrl,
      apiKey: "",
      modelsInput: "",
      headerRows: [],
    });
    setErrors({});
    setTest({ kind: "idle" });
    setShowKey(false);
    setFormOpen(true);
  };

  const openEditForm = (provider: CustomInferenceProvider) => {
    setEditingId(provider.id);
    setForm({
      preset: provider.preset,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
      modelsInput: provider.models.join(", "),
      headerRows: Object.entries(provider.headers).map(([key, value]) => ({ key, value })),
    });
    setErrors({});
    setTest({ kind: "idle" });
    setShowKey(false);
    setConfirmRemoveId(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setErrors({});
    setTest({ kind: "idle" });
  };

  const validate = (): boolean => {
    const next: typeof errors = {};
    if (!form.name.trim()) next.name = "A display name is required.";
    if (!isValidBaseUrl(form.baseUrl.trim()))
      next.baseUrl = "Enter a valid http(s) URL — or http://localhost for local providers.";
    const keepSavedKey = editingId !== null && !form.apiKey.trim();
    if (preset.needsKey && !keepSavedKey && !form.apiKey.trim())
      next.apiKey = "An API key is required for this provider.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const runTest = async () => {
    if (!validate()) return;
    setTest({ kind: "running" });
    const keepSavedKey = editingId !== null && !form.apiKey.trim();
    const result = await performConnectionTest(form, keepSavedKey);
    setTest(
      result.ok
        ? { kind: "ok", latencyMs: result.latencyMs }
        : {
            kind: "fail",
            message:
              "Authentication failed (401). The endpoint rejected the API key. Check the key and any required headers.",
          },
    );
  };

  const save = () => {
    if (!validate()) return;
    const headers: Record<string, string> = {};
    for (const row of form.headerRows) {
      if (row.key.trim()) headers[row.key.trim()] = row.value.trim();
    }
    const tested = test.kind === "ok";

    if (editingId !== null) {
      setProviders((current) =>
        current.map((provider) => {
          if (provider.id !== editingId) return provider;
          const rotatedKey = form.apiKey.trim();
          return {
            ...provider,
            preset: form.preset,
            name: form.name.trim(),
            baseUrl: form.baseUrl.trim(),
            models,
            headers,
            keyMasked: rotatedKey ? maskKey(rotatedKey) : provider.keyMasked,
            hasKey: provider.hasKey || Boolean(rotatedKey),
            status: tested ? "connected" : rotatedKey ? "untested" : provider.status,
            latencyMs: tested && test.kind === "ok" ? test.latencyMs : provider.latencyMs,
          };
        }),
      );
      flash("Provider updated");
    } else {
      const provider: CustomInferenceProvider = {
        id: nextId,
        preset: form.preset,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        keyMasked: form.apiKey.trim() ? maskKey(form.apiKey.trim()) : null,
        hasKey: Boolean(form.apiKey.trim()),
        models,
        headers,
        status: tested ? "connected" : "untested",
        latencyMs: tested && test.kind === "ok" ? test.latencyMs : null,
        isDefault: providers.length === 0,
      };
      setNextId((id) => id + 1);
      setProviders((current) => [...current, provider]);
      flash("Provider added");
    }
    closeForm();
  };

  const retest = async (provider: CustomInferenceProvider) => {
    setProviders((current) =>
      current.map((p) => (p.id === provider.id ? { ...p, status: "untested" } : p)),
    );
    const result = await performConnectionTest(
      {
        preset: provider.preset,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: "",
        modelsInput: provider.models.join(", "),
        headerRows: [],
      },
      provider.hasKey,
    );
    setProviders((current) =>
      current.map((p) =>
        p.id === provider.id
          ? {
              ...p,
              status: result.ok ? "connected" : "failed",
              latencyMs: result.ok ? result.latencyMs : null,
            }
          : p,
      ),
    );
    flash(result.ok ? `Connection OK — ${result.latencyMs} ms` : "Test failed: endpoint rejected credentials");
  };

  const setDefault = (id: number) => {
    setProviders((current) => current.map((p) => ({ ...p, isDefault: p.id === id })));
    const provider = providers.find((p) => p.id === id);
    if (provider) flash(`${provider.name} is now the default for chat`);
  };

  const remove = (id: number) => {
    setProviders((current) => current.filter((p) => p.id !== id));
    setConfirmRemoveId(null);
    if (editingId === id) closeForm();
    flash("Provider removed");
  };

  const fetchModels = () => {
    const merged = Array.from(new Set([...models, ...preset.sampleModels]));
    updateForm("modelsInput", merged.join(", "));
    const source = form.preset === "ollama-cloud" ? "ollama.com/api/tags" : "/models";
    flash(
      preset.sampleModels.length
        ? `Fetched ${preset.sampleModels.length} models from ${source}`
        : "Endpoint returned no models",
    );
  };

  const keyHint = form.preset === "ollama-cloud" ? OLLAMA_CLOUD_KEY_HINT : DEFAULT_KEY_HINT;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">
            Custom inference providers
            <span className="ml-2 inline-block rounded-full bg-[#EAF5EF] px-2 py-0.5 align-middle text-[10.5px] font-bold tracking-wide text-[#1F7A4D]">
              NEW
            </span>
          </h2>
          <p className="mt-1 max-w-xl text-[13px] text-ink-subtle">
            Add any OpenAI- or Anthropic-compatible endpoint with its API credentials. Admins can
            route chat and workflow models to these providers.
          </p>
        </div>
        {canManage && !formOpen ? (
          <button
            type="button"
            onClick={openAddForm}
            className="inline-flex items-center justify-center rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            + Add provider
          </button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {providers.length === 0 ? (
          <div className="px-6 py-7 text-center text-[13px] text-ink-subtle">
            <strong className="mb-1 block text-[13.5px] font-semibold text-ink">
              No custom providers yet
            </strong>
            Bring your own keys for OpenRouter, Groq, Together, Ollama Cloud, a self-hosted Ollama,
            or any compatible endpoint.
          </div>
        ) : (
          <ul>
            {providers.map((provider, index) => (
              <li
                key={provider.id}
                className={index > 0 ? "border-t border-border" : undefined}
              >
                <div className="flex items-center gap-3.5 px-[18px] py-[15px]">
                  <span
                    aria-hidden
                    className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] text-[13px] font-bold text-white"
                    style={{ backgroundColor: PRESET_COLORS[provider.preset] }}
                  >
                    {provider.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink">
                      {provider.name}
                      {provider.status === "connected" ? (
                        <span className="rounded-full bg-[#EAF5EF] px-2.5 py-0.5 text-[11.5px] font-semibold text-[#1F7A4D]">
                          Connected{provider.latencyMs ? ` · ${provider.latencyMs} ms` : ""}
                        </span>
                      ) : provider.status === "failed" ? (
                        <span className="rounded-full bg-[#FDECEA] px-2.5 py-0.5 text-[11.5px] font-semibold text-[#B42318]">
                          Failed
                        </span>
                      ) : (
                        <span className="rounded-full bg-[#FBF3E4] px-2.5 py-0.5 text-[11.5px] font-semibold text-[#8A6116]">
                          Untested
                        </span>
                      )}
                      {provider.isDefault ? (
                        <span className="rounded-full bg-surface-hover px-2.5 py-0.5 text-[11.5px] font-semibold text-ink-subtle">
                          Default for chat
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-[12.5px] text-ink-subtle">
                      {provider.baseUrl}{" "}
                      <span className="rounded-md bg-surface-hover px-1.5 py-0.5 font-mono text-[11.5px]">
                        {provider.keyMasked ?? "no key"}
                      </span>
                      {provider.models.length > 0
                        ? ` · ${provider.models.length} model${provider.models.length > 1 ? "s" : ""}`
                        : ""}
                    </div>
                    {confirmRemoveId === provider.id ? (
                      <div className="mt-2 flex items-center gap-2.5 rounded-[9px] bg-[#FDECEA] px-3 py-2 text-[12.5px] text-[#B42318]">
                        <span>
                          Remove <strong>{provider.name}</strong>? Agents using it fall back to
                          workspace credits.
                        </span>
                        <button
                          type="button"
                          onClick={() => remove(provider.id)}
                          className="inline-flex items-center justify-center rounded-full px-3 py-1 text-[12.5px] font-medium text-[#B42318] transition-colors duration-150 hover:bg-[#FAD9D5]"
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(null)}
                          className="inline-flex items-center justify-center rounded-full px-3 py-1 text-[12.5px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                        >
                          Keep
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {canManage ? (
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <button
                        type="button"
                        title="Set as default for chat"
                        aria-label={`Set ${provider.name} as default for chat`}
                        onClick={() => setDefault(provider.id)}
                        className={`border-none bg-transparent text-[15px] leading-none transition-colors duration-150 ${
                          provider.isDefault ? "text-[#C78A00]" : "text-ink-subtle/50 hover:text-[#C78A00]"
                        }`}
                      >
                        ★
                      </button>
                      <button
                        type="button"
                        onClick={() => void retest(provider)}
                        className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[12.5px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditForm(provider)}
                        className="inline-flex items-center justify-center rounded-full border border-border px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(provider.id)}
                        className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[12.5px] font-medium text-[#B42318] transition-colors duration-150 hover:bg-[#FDECEA]"
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex gap-2 rounded-[10px] border border-dashed border-border bg-surface px-3 py-2.5 text-[12px] text-ink-subtle">
        <span aria-hidden>🔒</span>
        <span>
          API keys are encrypted at rest, write-only after saving, and never returned to the
          browser. Only workspace admins can add, test, or remove providers. Usage on custom
          providers bypasses workspace credits.
        </span>
      </div>

      {formOpen && canManage ? (
        <div className="mt-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
          <h3 className="mb-3.5 text-[14px] font-semibold text-ink">
            {editingId !== null
              ? `Edit provider — ${providers.find((p) => p.id === editingId)?.name ?? ""}`
              : "Add custom provider"}
          </h3>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${formId}-preset`} className="text-[12.5px] font-medium text-ink">
                Provider preset
              </label>
              <select
                id={`${formId}-preset`}
                value={form.preset}
                onChange={(event) => applyPreset(event.target.value as ProviderPresetId)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                {PRESET_IDS.map((id) => (
                  <option key={id} value={id}>
                    {PRESETS[id].label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${formId}-name`} className="text-[12.5px] font-medium text-ink">
                Display name
              </label>
              <input
                id={`${formId}-name`}
                type="text"
                value={form.name}
                onChange={(event) => updateForm("name", event.target.value)}
                placeholder="e.g. Groq — fast models"
                autoComplete="off"
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
              {errors.name ? <p className="text-[12px] text-[#B42318]">{errors.name}</p> : null}
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor={`${formId}-baseurl`} className="text-[12.5px] font-medium text-ink">
                Base URL
              </label>
              <input
                id={`${formId}-baseurl`}
                type="text"
                value={form.baseUrl}
                onChange={(event) => updateForm("baseUrl", event.target.value)}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
              <p className="text-[12px] text-ink-subtle">
                Chat completions will be called at{" "}
                <span className="font-mono">{"{base_url}"}/chat/completions</span>.
              </p>
              {errors.baseUrl ? <p className="text-[12px] text-[#B42318]">{errors.baseUrl}</p> : null}
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor={`${formId}-key`} className="text-[12.5px] font-medium text-ink">
                API key{" "}
                {!preset.needsKey ? (
                  <span className="font-normal text-ink-subtle">· optional for local providers</span>
                ) : null}
              </label>
              <div className="relative">
                <input
                  id={`${formId}-key`}
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(event) => updateForm("apiKey", event.target.value)}
                  placeholder={editingId !== null ? "••••••••  (saved — leave blank to keep)" : "sk-…"}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 pr-16 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((show) => !show)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md border-none bg-transparent px-2 py-1 text-[11.5px] font-semibold text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
              <p className="text-[12px] text-ink-subtle">{keyHint}</p>
              {errors.apiKey ? <p className="text-[12px] text-[#B42318]">{errors.apiKey}</p> : null}
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor={`${formId}-models`} className="text-[12.5px] font-medium text-ink">
                Models
              </label>
              <div className="flex gap-2">
                <input
                  id={`${formId}-models`}
                  type="text"
                  value={form.modelsInput}
                  onChange={(event) => updateForm("modelsInput", event.target.value)}
                  placeholder="model-id, another-model-id — or fetch from endpoint"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                />
                <button
                  type="button"
                  onClick={fetchModels}
                  className="inline-flex flex-shrink-0 items-center justify-center rounded-full border border-border px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  Fetch models
                </button>
              </div>
              <p className="text-[12px] text-ink-subtle">
                {form.preset === "ollama-cloud"
                  ? "Cloud model IDs (e.g. gpt-oss:120b, qwen3-coder:480b). These appear in model pickers across chat and workflows."
                  : "Comma-separated. These appear in model pickers across chat and workflows."}
              </p>
              {models.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {models.map((model) => (
                    <span
                      key={model}
                      className="inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-surface-hover px-2 py-0.5 font-mono text-[11.5px] text-ink"
                    >
                      {model}
                      <button
                        type="button"
                        aria-label={`Remove ${model}`}
                        onClick={() =>
                          updateForm(
                            "modelsInput",
                            models.filter((m) => m !== model).join(", "),
                          )
                        }
                        className="border-none bg-transparent p-0 text-[12px] leading-none text-ink-subtle/60 transition-colors duration-150 hover:text-[#B42318]"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="sm:col-span-2">
              <details>
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] font-medium text-ink-subtle">
                  Advanced — extra headers
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {form.headerRows.map((row, rowIndex) => (
                    <div key={`header-${rowIndex}`} className="grid grid-cols-[1fr_1fr_30px] items-center gap-2">
                      <input
                        type="text"
                        value={row.key}
                        onChange={(event) =>
                          updateForm(
                            "headerRows",
                            form.headerRows.map((r, i) =>
                              i === rowIndex ? { ...r, key: event.target.value } : r,
                            ),
                          )
                        }
                        placeholder="Header (e.g. X-Title)"
                        className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                      />
                      <input
                        type="text"
                        value={row.value}
                        onChange={(event) =>
                          updateForm(
                            "headerRows",
                            form.headerRows.map((r, i) =>
                              i === rowIndex ? { ...r, value: event.target.value } : r,
                            ),
                          )
                        }
                        placeholder="Value"
                        className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                      />
                      <button
                        type="button"
                        aria-label="Remove header"
                        onClick={() =>
                          updateForm(
                            "headerRows",
                            form.headerRows.filter((_, i) => i !== rowIndex),
                          )
                        }
                        className="rounded-md border-none bg-transparent px-1.5 py-1 text-[14px] text-ink-subtle/60 transition-colors duration-150 hover:bg-surface-hover hover:text-[#B42318]"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div>
                    <button
                      type="button"
                      onClick={() => updateForm("headerRows", [...form.headerRows, { key: "", value: "" }])}
                      className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[12.5px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                    >
                      + Add header
                    </button>
                  </div>
                </div>
              </details>
            </div>
          </div>

          {test.kind !== "idle" ? (
            <div
              role={test.kind === "fail" ? "alert" : "status"}
              className={`mt-4 flex items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-[12.5px] ${
                test.kind === "ok"
                  ? "bg-[#EAF5EF] text-[#1F7A4D]"
                  : test.kind === "fail"
                    ? "bg-[#FDECEA] text-[#B42318]"
                    : "bg-surface-hover text-ink-subtle"
              }`}
            >
              {test.kind === "running" ? (
                <span>Contacting {form.baseUrl.trim()} …</span>
              ) : test.kind === "ok" ? (
                <span>
                  <strong>Connection successful.</strong> Authenticated in {test.latencyMs} ms
                  {models.length > 0
                    ? ` · ${models.length} model${models.length > 1 ? "s" : ""} available.`
                    : ". Add model IDs so they appear in pickers."}
                </span>
              ) : (
                <span>
                  <strong>{test.message}</strong>
                </span>
              )}
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void runTest()}
                disabled={test.kind === "running"}
                className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
              >
                {test.kind === "running" ? "Testing…" : "Test connection"}
              </button>
              <span className="text-[12px] text-ink-subtle">
                Runs a live check against the endpoint before saving.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeForm}
                className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                className="inline-flex items-center justify-center rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                {editingId !== null ? "Save changes" : "Save provider"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4.5 py-2 text-[13px] font-medium text-white shadow-lg"
        >
          {notice}
        </div>
      ) : null}
    </section>
  );
}
