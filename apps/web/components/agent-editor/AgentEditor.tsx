"use client";

import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { TiptapDoc } from "@opencompany/db/schema";
import { mentionSuggestion } from "./mentionSuggestion";

type Props = {
  initialContent: TiptapDoc;
  onChange: (doc: TiptapDoc) => void;
};

export function AgentEditor({ initialContent, onChange }: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Mention.configure({
        HTMLAttributes: { class: "agent-mention" },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        suggestion: mentionSuggestion,
      }),
    ],
    content: hasContent(initialContent) ? initialContent : undefined,
    editorProps: {
      attributes: {
        class:
          "tiptap-agent prose-none min-h-[240px] outline-none text-[13.5px] leading-7 text-ink/90",
      },
    },
    onUpdate({ editor }) {
      onChange(editor.getJSON() as TiptapDoc);
    },
  });

  useEffect(() => {
    return () => {
      editor?.destroy();
    };
  }, [editor]);

  return <EditorContent editor={editor} />;
}

function hasContent(doc: TiptapDoc) {
  return Array.isArray(doc.content) && doc.content.length > 0;
}
