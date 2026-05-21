"use client";

import { useMemo, useRef, useState } from "react";
import { MentionList, type MentionListHandle } from "./MentionList";
import { AGENT_MENTION_ITEMS } from "./tools";

type Props = {
  initialBody: string;
  onChange: (body: string) => void;
};

export function AgentEditor({ initialBody, onChange }: Props) {
  const [body, setBody] = useState(initialBody);
  const [selectionStart, setSelectionStart] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionListRef = useRef<MentionListHandle>(null);
  const mention = useMemo(
    () => currentMention(body, selectionStart),
    [body, selectionStart],
  );
  const items = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return AGENT_MENTION_ITEMS.filter((item) => {
      return (
        item.kind.includes(query) ||
        item.label.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query)
      );
    });
  }, [mention]);

  function update(nextBody: string, nextSelectionStart?: number) {
    setBody(nextBody);
    onChange(nextBody);
    if (typeof nextSelectionStart === "number") {
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextSelectionStart, nextSelectionStart);
        setSelectionStart(nextSelectionStart);
      });
    }
  }

  function insertMention(label: string) {
    if (!mention) return;
    const mentionToken = `@${label}`;
    const suffix = body.slice(selectionStart);
    const hasFollowingSpace = suffix.startsWith(" ");
    const nextBody = `${body.slice(0, mention.start)}${mentionToken}${
      hasFollowingSpace ? "" : " "
    }${suffix}`;
    update(nextBody, mention.start + mentionToken.length + 1);
  }

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => {
          setSelectionStart(event.currentTarget.selectionStart);
          update(event.currentTarget.value);
        }}
        onClick={(event) => setSelectionStart(event.currentTarget.selectionStart)}
        onKeyUp={(event) => setSelectionStart(event.currentTarget.selectionStart)}
        onSelect={(event) => setSelectionStart(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (mention && items.length > 0) {
            const handled = mentionListRef.current?.onKeyDown(event.nativeEvent);
            if (handled) {
              event.preventDefault();
              return;
            }
          }

          if (event.key === "Tab") {
            event.preventDefault();
            const start = event.currentTarget.selectionStart;
            const end = event.currentTarget.selectionEnd;
            const nextBody = `${body.slice(0, start)}  ${body.slice(end)}`;
            update(nextBody, start + 2);
          }
        }}
        placeholder="Describe what this agent should do. Mention models or tools with @."
        spellCheck
        className="min-h-[320px] w-full resize-none bg-transparent text-[13.5px] leading-7 text-ink/90 outline-none placeholder:text-ink-subtle/70"
      />
      {mention && (
        <div className="absolute left-0 top-7 z-20">
          <MentionList
            ref={mentionListRef}
            items={items}
            query={mention.query}
            command={(item) => insertMention(item.label)}
          />
        </div>
      )}
    </div>
  );
}

function currentMention(body: string, cursor: number) {
  const before = body.slice(0, cursor);
  const match = /(^|[\s([{])@([A-Za-z0-9_.\/-]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";

  return {
    start: cursor - query.length - 1,
    query,
  };
}
