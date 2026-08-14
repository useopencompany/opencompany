"use client";

import { Check, KeyRound, Loader2, LockKeyhole, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  clearRepoEnvAction,
  deleteRepoConfigAction,
  type RepoConfigView,
  saveRepoEnvAction,
  saveRepoSetupInstructionsAction,
  type WorkspaceRepository,
} from "@/lib/repo-config-actions";

export function RepositorySettings({
  initialRepositories,
  initialConfigs,
  canEdit,
}: {
  initialRepositories: WorkspaceRepository[];
  initialConfigs: RepoConfigView[];
  canEdit: boolean;
}) {
  const [configs, setConfigs] = useState(initialConfigs);
  const repositoryOptions = useMemo(
    () => repositoryOptionsFrom(initialRepositories, configs),
    [initialRepositories, configs],
  );
  const [selectedRepository, setSelectedRepository] = useState(
    () =>
      initialConfigs[0]?.repositoryExternalId ?? initialRepositories[0]?.repositoryExternalId ?? "",
  );
  const selectedConfig = configs.find(
    (config) => config.repositoryExternalId === selectedRepository,
  );
  const selectedOption = repositoryOptions.find(
    (repository) => repository.repositoryExternalId === selectedRepository,
  );
  const [envContent, setEnvContent] = useState("");
  const [setupInstructions, setSetupInstructions] = useState(
    () => selectedConfig?.setupInstructions ?? "",
  );
  const [envError, setEnvError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [envSaved, setEnvSaved] = useState(false);
  const [setupSaved, setSetupSaved] = useState(false);
  const [isSavingEnv, startSavingEnv] = useTransition();
  const [isClearingEnv, startClearingEnv] = useTransition();
  const [isSavingSetup, startSavingSetup] = useTransition();
  const [isRemovingConfig, startRemovingConfig] = useTransition();

  const selectRepository = (repositoryExternalId: string) => {
    const config = configs.find(
      (candidate) => candidate.repositoryExternalId === repositoryExternalId,
    );
    setSelectedRepository(repositoryExternalId);
    setEnvContent("");
    setSetupInstructions(config?.setupInstructions ?? "");
    setEnvError(null);
    setSetupError(null);
    setRemoveError(null);
    setEnvSaved(false);
    setSetupSaved(false);
  };

  const updateConfig = (config: RepoConfigView) => {
    setConfigs((current) =>
      [
        ...current.filter(
          (candidate) => candidate.repositoryExternalId !== config.repositoryExternalId,
        ),
        config,
      ].toSorted((a, b) => a.repositoryFullName.localeCompare(b.repositoryFullName)),
    );
  };

  const saveEnvironment = () => {
    if (!selectedRepository || !envContent.trim()) return;
    setEnvError(null);
    setEnvSaved(false);
    startSavingEnv(async () => {
      const result = await saveRepoEnvAction({
        repositoryExternalId: selectedRepository,
        envContent,
      });
      if (!result.ok) {
        setEnvError(result.message);
        return;
      }
      updateConfig(result.config);
      setEnvContent("");
      setEnvSaved(true);
    });
  };

  const clearEnvironment = () => {
    if (!selectedRepository) return;
    setEnvError(null);
    setEnvSaved(false);
    startClearingEnv(async () => {
      const result = await clearRepoEnvAction({
        repositoryExternalId: selectedRepository,
      });
      if (!result.ok) {
        setEnvError(result.message);
        return;
      }
      updateConfig(result.config);
      setEnvContent("");
    });
  };

  const saveSetup = () => {
    if (!selectedRepository) return;
    setSetupError(null);
    setSetupSaved(false);
    startSavingSetup(async () => {
      const result = await saveRepoSetupInstructionsAction({
        repositoryExternalId: selectedRepository,
        setupInstructions,
      });
      if (!result.ok) {
        setSetupError(result.message);
        return;
      }
      updateConfig(result.config);
      setSetupSaved(true);
    });
  };

  const removeConfiguration = () => {
    if (!selectedConfig) return;
    setRemoveError(null);
    startRemovingConfig(async () => {
      const result = await deleteRepoConfigAction({
        repositoryExternalId: selectedConfig.repositoryExternalId,
      });
      if (!result.ok) {
        setRemoveError(result.message);
        return;
      }

      setConfigs((current) =>
        current.filter((config) => config.repositoryExternalId !== result.repositoryExternalId),
      );
      setEnvContent("");
      setSetupInstructions("");
      setEnvError(null);
      setSetupError(null);
      setEnvSaved(false);
      setSetupSaved(false);

      if (!selectedOption?.available) {
        const nextRepository = repositoryOptions.find(
          (repository) => repository.repositoryExternalId !== result.repositoryExternalId,
        );
        selectRepository(nextRepository?.repositoryExternalId ?? "");
      }
    });
  };

  if (repositoryOptions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface px-5 py-8 text-center">
        <p className="text-[14px] font-medium text-ink">No GitHub repositories available</p>
        <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-5 text-ink-subtle">
          Connect GitHub and grant the workspace access to at least one repository before adding
          setup details.
        </p>
        {canEdit ? (
          <Link
            href="/settings/integrations"
            className="mt-4 inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Connect GitHub
          </Link>
        ) : null}
      </div>
    );
  }

  const envKeys = selectedConfig?.envKeys ?? [];
  const environmentPending = isSavingEnv || isClearingEnv;
  const canEditSelectedRepository = canEdit && selectedOption?.available === true;

  return (
    <div className="flex flex-col gap-7">
      {!canEdit ? (
        <div className="rounded-lg border border-border bg-surface-muted px-3.5 py-3 text-[12.5px] leading-5 text-ink-muted">
          Repository setup is shared across the workspace. Only workspace admins can change it.
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <label
          htmlFor="repository-config-picker"
          className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle"
        >
          Repository
        </label>
        <select
          id="repository-config-picker"
          value={selectedRepository}
          onChange={(event) => selectRepository(event.target.value)}
          className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          {repositoryOptions.map((repository) => (
            <option key={repository.repositoryExternalId} value={repository.repositoryExternalId}>
              {repository.repositoryFullName}
              {repository.available ? (repository.private ? " · Private" : "") : " · Unavailable"}
            </option>
          ))}
        </select>
        {selectedOption && !selectedOption.available ? (
          <p className="text-[12px] leading-5 text-warning">
            This configured repository is no longer in the connected GitHub catalog. You can still
            remove its saved configuration.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">
            <LockKeyhole size={17} strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-ink">Environment file</h2>
            <p className="mt-0.5 text-[12.5px] leading-5 text-ink-subtle">
              Paste the complete local <span className="font-mono">.env</span>. Values are encrypted
              and never shown again.
            </p>
          </div>
        </div>

        {envKeys.length > 0 ? (
          <div className="rounded-lg bg-surface-muted px-3 py-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              <KeyRound size={12} strokeWidth={2} />
              Saved variables
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {envKeys.map((key) => (
                <code key={key} className="text-[12px] leading-5 text-ink-muted">
                  {key}=••••••
                </code>
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-lg bg-surface-muted px-3 py-2 text-[12px] text-ink-subtle">
            No environment file saved.
          </p>
        )}

        {canEditSelectedRepository ? (
          <>
            <textarea
              value={envContent}
              onChange={(event) => {
                setEnvContent(event.target.value);
                setEnvError(null);
                setEnvSaved(false);
              }}
              placeholder={"DATABASE_URL=…\nAPI_KEY=…"}
              aria-label="Environment file contents"
              autoComplete="off"
              spellCheck={false}
              rows={7}
              className="w-full resize-y rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-[12px] leading-5 text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            />
            {envError ? <p className="text-[12px] leading-4 text-warning">{envError}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={saveEnvironment}
                disabled={environmentPending || !envContent.trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingEnv ? <Loader2 size={13} className="animate-spin" /> : null}
                {envKeys.length > 0 ? "Replace environment" : "Save environment"}
              </button>
              {envKeys.length > 0 ? (
                <button
                  type="button"
                  onClick={clearEnvironment}
                  disabled={environmentPending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
                >
                  {isClearingEnv ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  Clear
                </button>
              ) : null}
              {envSaved ? (
                <span className="inline-flex items-center gap-1 text-[12px] text-ink-subtle">
                  <Check size={13} />
                  Saved
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Setup instructions</h2>
          <p className="mt-0.5 text-[12.5px] leading-5 text-ink-subtle">
            Tell the coding agent how to use the staged env file and bootstrap this repository. Do
            not put secret values in these instructions.
          </p>
        </div>
        <textarea
          value={setupInstructions}
          onChange={(event) => {
            setSetupInstructions(event.target.value);
            setSetupError(null);
            setSetupSaved(false);
          }}
          placeholder="Copy the staged env file into the repo root, then run bun install and bun run setup."
          aria-label="Setup instructions"
          disabled={!canEditSelectedRepository}
          rows={5}
          className="w-full resize-y rounded-lg border border-border bg-canvas px-3 py-2.5 text-[13px] leading-5 text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:bg-surface-muted disabled:text-ink-muted"
        />
        {setupError ? <p className="text-[12px] leading-4 text-warning">{setupError}</p> : null}
        {canEditSelectedRepository ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveSetup}
              disabled={isSavingSetup}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
            >
              {isSavingSetup ? <Loader2 size={13} className="animate-spin" /> : null}
              Save instructions
            </button>
            {setupSaved ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-ink-subtle">
                <Check size={13} />
                Saved
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      {canEdit && selectedConfig ? (
        <section className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-surface p-4">
          <div>
            <h2 className="text-[14px] font-semibold text-ink">Remove configuration</h2>
            <p className="mt-0.5 text-[12.5px] leading-5 text-ink-subtle">
              Delete the saved environment and setup instructions for this repository.
            </p>
          </div>
          {removeError ? <p className="text-[12px] leading-4 text-warning">{removeError}</p> : null}
          <div>
            <button
              type="button"
              onClick={removeConfiguration}
              disabled={isRemovingConfig}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-warning/40 px-3 text-[13px] font-medium text-warning transition-colors hover:bg-warning/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-warning/30 disabled:opacity-50"
            >
              {isRemovingConfig ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )}
              Remove configuration
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function repositoryOptionsFrom(repositories: WorkspaceRepository[], configs: RepoConfigView[]) {
  const options = new Map<
    string,
    WorkspaceRepository & {
      available: boolean;
    }
  >();
  for (const repository of repositories) {
    options.set(repository.repositoryExternalId, { ...repository, available: true });
  }
  for (const config of configs) {
    if (!options.has(config.repositoryExternalId)) {
      options.set(config.repositoryExternalId, {
        repositoryExternalId: config.repositoryExternalId,
        repositoryFullName: config.repositoryFullName,
        private: true,
        available: false,
      });
    }
  }
  return [...options.values()].toSorted((a, b) =>
    a.repositoryFullName.localeCompare(b.repositoryFullName),
  );
}
