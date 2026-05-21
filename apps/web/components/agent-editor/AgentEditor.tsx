"use client";

import type { TiptapDoc } from "@opencompany/db/schema";
import Mention from "@tiptap/extension-mention";
import type { UseEditorOptions } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { mentionSuggestion } from "./mentionSuggestion";

type Props = {
  initialContent: TiptapDoc;
  onChange: (doc: TiptapDoc) => void;
};

export function AgentEditor({ initialContent, onChange }: Props) {
  const editorOptions: UseEditorOptions = {
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
    editorProps: {
      attributes: {
        class:
          "tiptap-agent prose-none min-h-[240px] outline-none text-[13.5px] leading-7 text-ink/90",
      },
    },
    onUpdate({ editor }) {
      onChange(editor.getJSON() as TiptapDoc);
    },
  };

  if (hasContent(initialContent)) {
    editorOptions.content = initialContent;
  }

  const editor = useEditor(editorOptions);

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
