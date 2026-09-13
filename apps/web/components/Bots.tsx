"use client";

import type { BotDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Input } from "@opencompany/ui/components/input";
import { Label } from "@opencompany/ui/components/label";
import { Textarea } from "@opencompany/ui/components/textarea";
import { Bot, Loader2, Plus, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAppData } from "@/components/AppDataProvider";
import {
  SIDEBAR_SECTION_ACTION_CLASSNAME,
  SidebarSectionHeader,
  useCollapsedSidebarSection,
} from "@/components/SidebarSection";
import { listBots, saveBot } from "@/lib/bots";

const BotsContext = createContext<{
  enabled: boolean;
  bots: BotDto[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  saved: (bot: BotDto) => void;
}>({ enabled: false, bots: [], loading: false, error: null, reload: () => {}, saved: () => {} });

export function BotsProvider({ children }: { children: ReactNode }) {
  const { featureFlags, workspace } = useAppData();
  const [bots, setBots] = useState<BotDto[]>([]);
  const [loading, setLoading] = useState(featureFlags.bots === true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const reload = useCallback(() => {
    generation.current++;
    setLoading(true);
    setError(null);
    setRevision((current) => current + 1);
  }, []);
  useEffect(() => {
    if (!featureFlags.bots) return;
    let active = true;
    const request = ++generation.current;
    void listBots()
      .then((result) => {
        if (active && request === generation.current) setBots(result);
      })
      .catch((error: unknown) => {
        if (active && request === generation.current)
          setError(error instanceof Error ? error.message : "Could not load bots.");
      })
      .finally(() => {
        if (active && request === generation.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [featureFlags.bots, workspace.id, revision]);
  useEffect(() => {
    if (!featureFlags.bots) return;
    window.addEventListener("focus", reload);
    window.addEventListener("bots-changed", reload);
    return () => {
      window.removeEventListener("focus", reload);
      window.removeEventListener("bots-changed", reload);
    };
  }, [featureFlags.bots, reload]);
  const saved = (bot: BotDto) => {
    generation.current++;
    setLoading(false);
    setError(null);
    setBots((current) => [bot, ...current.filter((item) => item.id !== bot.id)]);
    setRevision((current) => current + 1);
  };
  return (
    <BotsContext.Provider
      value={{ enabled: featureFlags.bots === true, bots, loading, error, reload, saved }}
    >
      {children}
    </BotsContext.Provider>
  );
}

const BOTS_LIST_ID = "sidebar-bots";
const BOTS_COLLAPSED_STORAGE_KEY = "opencompany-sidebar-bots-collapsed";

export function SidebarBots() {
  const { featureFlags } = useAppData();
  const { bots, loading, error, reload } = useContext(BotsContext);
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  const { collapsed, toggle, expand } = useCollapsedSidebarSection(BOTS_COLLAPSED_STORAGE_KEY);
  if (!featureFlags.bots) return null;
  return (
    <section className="pt-4" aria-label="Bots">
      <SidebarSectionHeader
        label="Bots"
        collapsed={collapsed}
        onToggle={toggle}
        listId={BOTS_LIST_ID}
        action={
          <button
            type="button"
            aria-label="Create bot"
            title="Create bot"
            onClick={() => setCreating(true)}
            className={SIDEBAR_SECTION_ACTION_CLASSNAME}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        }
      />
      {collapsed ? null : (
        <div id={BOTS_LIST_ID}>
          <nav aria-label="Bots" className="flex max-h-60 flex-col gap-px overflow-y-auto px-2">
            {bots.map((bot) => (
              <Link
                key={bot.id}
                href={`/chat/${bot.id}`}
                aria-current={pathname === `/chat/${bot.id}` ? "page" : undefined}
                className={`flex items-center gap-2 rounded-md px-2 py-[5px] text-[13px] hover:bg-surface-hover ${pathname === `/chat/${bot.id}` ? "bg-surface-active text-ink" : "text-ink/90"}`}
              >
                <Bot size={14} className="shrink-0 text-ink/60" />
                <span className="truncate">{bot.name}</span>
              </Link>
            ))}
          </nav>
          {loading && !bots.length ? (
            <p className="px-4 pb-1 text-[11.5px] leading-4 text-ink-faint" role="status">
              Loading bots…
            </p>
          ) : null}
          {error ? (
            <div className="px-4 pb-1 text-[11.5px] leading-4">
              <p role="alert" className="text-danger">
                {error}
              </p>
              <button
                type="button"
                onClick={reload}
                className="text-ink-subtle underline hover:text-ink"
              >
                Try again
              </button>
            </div>
          ) : null}
          {!loading && !error && !bots.length ? (
            <p className="px-4 pb-1 text-[11.5px] leading-4 text-ink-faint">
              Create a bot for ongoing work.
            </p>
          ) : null}
        </div>
      )}
      {creating ? (
        // A saved bot's row lives below the fold, so it reopens the section. Cancelling the dialog
        // leaves the reader's collapse choice alone.
        <BotEditor onSaved={expand} onClose={() => setCreating(false)} />
      ) : null}
    </section>
  );
}

export function BotSettingsButton({ conversationId }: { conversationId: string }) {
  const { bots, enabled } = useContext(BotsContext);
  const bot = bots.find((item) => item.id === conversationId);
  const [open, setOpen] = useState(false);
  if (!enabled || !bot) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        aria-label="Bot settings"
        onClick={() => setOpen(true)}
      >
        <Settings size={15} />
      </Button>
      {open ? <BotEditor key={bot.id} bot={bot} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function BotEditor({
  bot,
  onSaved,
  onClose,
}: {
  bot?: BotDto;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { saved } = useContext(BotsContext);
  const [id] = useState(() => bot?.id ?? crypto.randomUUID());
  const [name, setName] = useState(bot?.name ?? "");
  const [description, setDescription] = useState(bot?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className={
          bot
            ? "inset-y-0 left-auto right-0 top-0 flex h-dvh w-full max-w-sm translate-x-0 translate-y-0 flex-col rounded-none border-l border-border"
            : ""
        }
      >
        <DialogTitle>{bot ? "Bot settings" : "Create bot"}</DialogTitle>
        <DialogDescription>
          {bot
            ? "Changes apply to the next message. Your conversation stays here."
            : "Give your bot a name and describe the work it should help with."}
        </DialogDescription>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving || !name.trim()) return;
            setSaving(true);
            setError(null);
            try {
              const result = await saveBot(
                { id, name: name.trim(), description: description.trim() },
                !bot,
              );
              saved(result);
              onSaved?.();
              onClose();
              if (!bot) router.push(`/chat/${result.id}`);
              router.refresh();
            } catch (error) {
              setError(error instanceof Error ? error.message : "Could not save bot.");
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`bot-name-${id}`}>Name</Label>
            <Input
              id={`bot-name-${id}`}
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
              placeholder="Research assistant"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`bot-description-${id}`}>Description</Label>
            <Textarea
              id={`bot-description-${id}`}
              maxLength={4000}
              rows={6}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={saving}
              placeholder="Help me research customers and keep track of what we learn."
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {saving ? "Saving…" : bot ? "Save changes" : "Create bot"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
