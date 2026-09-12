"use client";

import type { WikiDto } from "@opencompany/protocol";
import { toast } from "@opencompany/ui/components/sonner";
import { BookOpen, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IntentPrefetchLink } from "@/components/IntentPrefetchLink";
import {
  SIDEBAR_SECTION_ACTION_CLASSNAME,
  SidebarSectionHeader,
  useCollapsedSidebarSection,
} from "@/components/SidebarSection";
import { wikiHref } from "@/lib/wiki-routes";
import { createWiki, listWikis } from "@/lib/wikis";

const WIKIS_LIST_ID = "sidebar-wikis";
const SECTION_COLLAPSED_STORAGE_KEY = "opencompany-sidebar-wikis-collapsed";

export type SidebarWikisState = ReturnType<typeof useSidebarWikis>;

/**
 * The wikis the reader may open, default first.
 *
 * Wikis are workspace-level and change rarely, so they are loaded over REST and refreshed on focus
 * rather than given a live-synced collection of their own -- the same shape `useSidebarProjects`
 * uses. `GET /v1/wikis` already filters out restricted wikis the reader is not a member of, so a
 * wiki they cannot reach never reaches this list.
 */
export function useSidebarWikis() {
  const [wikis, setWikis] = useState<WikiDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  // Wikis created here that a given server response may predate. A create can land while a load
  // is in flight, and that response would otherwise drop the wiki the reader just made. Each one
  // is released as soon as a response carries it, so this is empty in the ordinary case.
  const createdLocally = useRef<WikiDto[]>([]);

  const withCreatedLocally = useCallback((next: WikiDto[]) => {
    if (createdLocally.current.length === 0) return next;
    const served = new Set(next.map((wiki) => wiki.id));
    createdLocally.current = createdLocally.current.filter((wiki) => !served.has(wiki.id));
    return createdLocally.current.length === 0 ? next : [...next, ...createdLocally.current];
  }, []);

  const reload = useCallback(() => {
    const request = ++generation.current;
    void listWikis()
      .then((next) => {
        if (request !== generation.current) return;
        setWikis(withCreatedLocally(next));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (request !== generation.current) return;
        setError(cause instanceof Error ? cause.message : "Wikis could not be loaded.");
      })
      .finally(() => {
        if (request === generation.current) setLoading(false);
      });
  }, [withCreatedLocally]);

  useEffect(reload, [reload]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  // The created wiki is spliced in rather than waiting on a reload, so its row is navigable the
  // moment it appears. Ordering matches the server's: default first, then creation order.
  const create = useCallback(async (name: string) => {
    try {
      const created = await createWiki({ name, access: "workspace" });
      createdLocally.current = [...createdLocally.current, created];
      setWikis((current) =>
        current.some((wiki) => wiki.id === created.id) ? current : [...current, created],
      );
      setError(null);
      setLoading(false);
      return created;
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The wiki could not be created.");
      return null;
    }
  }, []);

  return { wikis, loading, error, reload, create };
}

export function SidebarWikis({
  state,
  activeWikiSlug,
}: {
  state: SidebarWikisState;
  /** The wiki the reader is currently inside, so its row reads as the current page. */
  activeWikiSlug: string | null;
}) {
  const {
    collapsed: sectionCollapsed,
    toggle: toggleSection,
    expand: expandSection,
  } = useCollapsedSidebarSection(SECTION_COLLAPSED_STORAGE_KEY);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Enter and clicking away both save, Escape discards -- the same bargain the Projects "+" makes.
  const saveNewWiki = async () => {
    const trimmed = name.trim();
    if (saving) return;
    if (!trimmed) {
      setCreating(false);
      return;
    }
    setSaving(true);
    const created = await state.create(trimmed);
    setSaving(false);
    if (!created) return;
    setName("");
    setCreating(false);
    // A collapsed section would hide the wiki that was just created. Cancelling leaves the
    // reader's collapse choice alone.
    expandSection();
  };

  return (
    <section aria-label="Wiki" className="pb-2">
      <SidebarSectionHeader
        label="Wiki"
        collapsed={sectionCollapsed}
        onToggle={toggleSection}
        listId={WIKIS_LIST_ID}
        action={
          <button
            type="button"
            aria-label="New wiki"
            title="New wiki"
            onClick={() => setCreating(true)}
            className={SIDEBAR_SECTION_ACTION_CLASSNAME}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        }
      />

      {creating ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveNewWiki();
          }}
          className="px-2 pb-1"
        >
          <label className="sr-only" htmlFor="new-wiki-name">
            Wiki name
          </label>
          <input
            id="new-wiki-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void saveNewWiki()}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setName("");
              setCreating(false);
            }}
            autoFocus
            maxLength={120}
            placeholder="Wiki name"
            disabled={saving}
            className="h-7 w-full rounded-md border border-border bg-canvas px-2 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong disabled:opacity-60"
          />
        </form>
      ) : null}

      {sectionCollapsed ? null : (
        <div id={WIKIS_LIST_ID}>
          {state.error ? (
            <div className="px-4 pb-1 text-[11.5px] leading-4">
              <p role="alert" className="text-danger">
                {state.error}
              </p>
              <button
                type="button"
                onClick={state.reload}
                className="text-ink-subtle underline hover:text-ink"
              >
                Try again
              </button>
            </div>
          ) : null}

          <div className="flex flex-col gap-px px-2">
            {state.wikis.map((wiki) => (
              <WikiRow key={wiki.id} wiki={wiki} active={activeWikiSlug === wiki.slug} />
            ))}
          </div>

          {state.loading && state.wikis.length === 0 ? (
            <p role="status" className="px-4 pb-1 text-[11.5px] leading-4 text-ink-faint">
              Loading wikis…
            </p>
          ) : null}
          {!state.loading && state.wikis.length === 0 && !creating && !state.error ? (
            <p className="px-4 pb-1 text-[11.5px] leading-4 text-ink-faint">
              Create a wiki to keep a body of knowledge together.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function WikiRow({ wiki, active }: { wiki: WikiDto; active: boolean }) {
  return (
    <IntentPrefetchLink
      href={wikiHref(wiki.slug)}
      aria-current={active ? "page" : undefined}
      className={`group flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        active ? "bg-surface-active text-ink" : "text-ink/90 hover:bg-surface-hover hover:text-ink"
      }`}
    >
      <BookOpen
        size={14}
        strokeWidth={1.75}
        aria-hidden="true"
        className={`shrink-0 ${active ? "text-ink" : "text-ink/60 group-hover:text-ink/80"}`}
      />
      <span className="truncate tracking-[-0.005em]">{wiki.name}</span>
    </IntentPrefetchLink>
  );
}
