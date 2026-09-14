import type { PrototypeGroup } from "./tool-permission-model";

/**
 * The real Gmail plugin surface: the 17 tools registered in
 * packages/agent/src/integrations/gmail-mcp-server.ts, in the three capability groups the
 * settings page renders today. Real data matters here — the whole question is whether the
 * interaction survives a group with nine tools in it.
 */
export const GMAIL_GROUPS: PrototypeGroup[] = [
  {
    id: "query",
    label: "Read Gmail",
    description: "Search and read messages, threads, drafts, and labels in your Gmail account.",
    defaultMode: "ask",
    tools: [
      {
        id: "gmail:list_drafts",
        name: "List drafts",
        description: "List draft ids in the connected Gmail account.",
      },
      {
        id: "gmail:get_draft",
        name: "Get draft",
        description: "Read one Gmail draft by id, including its headers and body.",
      },
      {
        id: "gmail:search_threads",
        name: "Search threads",
        description: "Search Gmail threads using Gmail's standard search syntax.",
      },
      {
        id: "gmail:get_thread",
        name: "Get thread",
        description: "Read the messages in one Gmail thread by id.",
      },
      {
        id: "gmail:get_message",
        name: "Get message",
        description: "Read one Gmail message by id.",
      },
      {
        id: "gmail:download_attachment",
        name: "Download attachment",
        description:
          "Create a short-lived download URL for one Gmail attachment. Pass the message id and MIME part id from get_message or get_thread, then fetch the URL promptly to save the original file bytes.",
      },
      {
        id: "gmail:list_labels",
        name: "List labels",
        description: "List system and user labels in the connected Gmail account.",
      },
    ],
  },
  {
    id: "draft",
    label: "Create drafts",
    description: "Save new email drafts in Gmail for you to review and send.",
    defaultMode: "on",
    tools: [
      {
        id: "gmail:create_draft",
        name: "Create draft",
        description: "Create a Gmail draft for manual review. This tool never sends the message.",
      },
    ],
  },
  {
    id: "write",
    label: "Organize Gmail",
    description:
      "Add or remove labels, create labels, move mail to trash, and mark or unmark spam.",
    defaultMode: "ask",
    tools: [
      {
        id: "gmail:label_thread",
        name: "Label thread",
        description: "Apply one or more Gmail labels to every message in a thread.",
      },
      {
        id: "gmail:unlabel_thread",
        name: "Remove thread labels",
        description: "Remove one or more Gmail labels from every message in a thread.",
      },
      {
        id: "gmail:trash_thread",
        name: "Trash thread",
        description: "Move a Gmail thread to trash without permanently deleting it.",
      },
      {
        id: "gmail:untrash_thread",
        name: "Restore thread",
        description: "Remove a Gmail thread from trash.",
      },
      {
        id: "gmail:label_message",
        name: "Label message",
        description: "Apply one or more Gmail labels to a message.",
      },
      {
        id: "gmail:unlabel_message",
        name: "Remove message labels",
        description: "Remove one or more Gmail labels from a message.",
      },
      {
        id: "gmail:trash_message",
        name: "Trash message",
        description: "Move a Gmail message to trash without permanently deleting it.",
      },
      {
        id: "gmail:untrash_message",
        name: "Restore message",
        description: "Remove a Gmail message from trash.",
      },
      {
        id: "gmail:create_label",
        name: "Create label",
        description: "Create a user label in the connected Gmail account.",
      },
    ],
  },
];

/** The approval the prototype replays: the everyday label write that today's "Always allow" over-grants. */
export const APPROVAL_TOOL_ID = "gmail:label_thread";
