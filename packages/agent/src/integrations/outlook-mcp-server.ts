import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import type { CapabilityId } from "../actions/capabilities";
import { createFirstPartyMcpTicket, verifyFirstPartyMcpTicket } from "./first-party-mcp-ticket";
import { graphApiCall, graphApiDownload } from "./microsoft-access-token";
import { microsoftMcpRuntimeEndpointUrl } from "./microsoft-mcp";
import {
  authorizeMicrosoftTicket,
  callGraph,
  createMicrosoftMcpService,
  graphId,
  graphIdSchema,
  graphPage,
  graphPageSchema,
  graphRecord,
  graphUrl,
  type MicrosoftMcpServiceInput,
  type MicrosoftToolContext,
  registerMicrosoftTool,
} from "./microsoft-mcp-server";

export const OUTLOOK_TOOL_CAPABILITIES = {
  search_messages: "query",
  get_message: "query",
  get_conversation: "query",
  list_drafts: "query",
  list_attachments: "query",
  download_attachment: "query",
  list_folders: "query",
  create_draft: "draft",
  create_folder: "write",
  move_message: "write",
  archive_message: "write",
  trash_message: "write",
  categorize_message: "write",
} as const satisfies Record<string, CapabilityId>;
const MESSAGE_FIELDS =
  "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isDraft,isRead,hasAttachments,categories,parentFolderId,webLink";
const attachmentSchema = { messageId: graphIdSchema, attachmentId: graphIdSchema };
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function createOutlookMcpService(
  input: MicrosoftMcpServiceInput & { apiDownload?: typeof graphApiDownload },
) {
  const policy = {
    ...input,
    provider: "outlook" as const,
    capabilities: OUTLOOK_TOOL_CAPABILITIES,
  };
  const service = createMicrosoftMcpService({
    ...policy,
    register(server, context) {
      const register = <S extends z.ZodRawShape>(
        name: keyof typeof OUTLOOK_TOOL_CAPABILITIES,
        description: string,
        schema: S,
        execute: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
      ) =>
        registerMicrosoftTool(server, {
          name,
          description,
          schema,
          capability: OUTLOOK_TOOL_CAPABILITIES[name],
          destructive: name === "trash_message",
          execute,
        });
      register(
        "search_messages",
        "Search Outlook messages using Microsoft KQL (for example from:ada@example.com or subject:invoice). Results can include multiple messages in one conversation. Follow nextPageToken for more results.",
        {
          ...graphPageSchema,
          query: z.string().trim().min(1).max(1000).optional(),
          folderId: graphIdSchema.optional(),
        },
        async (args) => {
          const path = args.folderId
            ? `mailFolders/${graphId(args.folderId)}/messages`
            : "messages";
          const page = await graphPage(
            context,
            graphUrl(path, {
              $top: String(args.pageSize ?? 25),
              $select: MESSAGE_FIELDS,
              ...(args.query
                ? { $search: JSON.stringify(args.query) }
                : { $orderby: "receivedDateTime desc" }),
            }),
            args.pageToken,
          );
          return { messages: page.items, nextPageToken: page.nextPageToken };
        },
      );
      register(
        "get_message",
        "Read an Outlook message or draft, including its plain-text body. Use list_attachments to resolve attachment ids.",
        { messageId: graphIdSchema },
        async ({ messageId }) =>
          compactMessage(
            await callGraph(
              context,
              "GET",
              graphUrl(`messages/${graphId(messageId)}`, { $select: `${MESSAGE_FIELDS},body` }),
            ),
          ),
      );
      register(
        "get_conversation",
        "Read messages belonging to one Outlook conversationId. Follow every nextPageToken for the complete conversation; Outlook conversation ids are not message ids.",
        { ...graphPageSchema, conversationId: graphIdSchema },
        async (args) => {
          const page = await graphPage(
            context,
            graphUrl("messages", {
              $filter: `conversationId eq '${args.conversationId.replace(/'/gu, "''")}'`,
              $top: String(args.pageSize ?? 25),
              $select: `${MESSAGE_FIELDS},body`,
            }),
            args.pageToken,
          );
          return { messages: page.items.map(compactMessage), nextPageToken: page.nextPageToken };
        },
      );
      register(
        "list_drafts",
        "List saved Outlook drafts. Read a draft with get_message before editing it in Outlook.",
        graphPageSchema,
        async (args) => {
          const page = await graphPage(
            context,
            graphUrl("mailFolders/drafts/messages", {
              $top: String(args.pageSize ?? 25),
              $select: MESSAGE_FIELDS,
            }),
            args.pageToken,
          );
          return { drafts: page.items, nextPageToken: page.nextPageToken };
        },
      );
      register(
        "list_attachments",
        "List message attachment metadata without downloading content. File attachments up to 20 MB can be downloaded; embedded Outlook items and reference attachments are not supported.",
        { ...graphPageSchema, messageId: graphIdSchema },
        async (args) => {
          const page = await graphPage(
            context,
            graphUrl(`messages/${graphId(args.messageId)}/attachments`, {
              $top: String(args.pageSize ?? 25),
              $select: "id,name,contentType,size,isInline",
            }),
            args.pageToken,
          );
          return { attachments: page.items, nextPageToken: page.nextPageToken };
        },
      );
      register(
        "download_attachment",
        "Create a private download link for one Outlook file attachment, valid for five minutes. The link is bound to the exact message and attachment, and access is checked again on download. Files are limited to 20 MB.",
        attachmentSchema,
        async (args) => {
          const metadata = await attachmentMetadata(context, args);
          const { ticket, expiresAt } = createFirstPartyMcpTicket({
            ...context.payload,
            audience: "opencompany-outlook-attachment-download",
            signingContext: "opencompany-outlook-attachment-ticket",
            operation: { type: "tools/call", tool: "download_attachment", capability: "query" },
            secret: input.internalSecret,
            ttlMs: 300_000,
          });
          const url = new URL(`${microsoftMcpRuntimeEndpointUrl("outlook")}/attachments/download`);
          url.search = new URLSearchParams({
            ...args,
            ticket,
            signature: downloadSignature(
              ticket,
              args.messageId,
              args.attachmentId,
              input.internalSecret,
            ),
          }).toString();
          return {
            ...metadata,
            downloadUrl: url.toString(),
            expiresAt: new Date(expiresAt).toISOString(),
          };
        },
      );
      register(
        "list_folders",
        "List top-level Outlook mail folders, or children of a folder. Includes hidden folders. Use the returned folder id to move messages; well-known archive, inbox, and deleteditems names are also accepted.",
        { ...graphPageSchema, parentFolderId: graphIdSchema.optional() },
        async (args) => {
          const page = await graphPage(
            context,
            graphUrl(
              args.parentFolderId
                ? `mailFolders/${graphId(args.parentFolderId)}/childFolders`
                : "mailFolders",
              {
                $top: String(args.pageSize ?? 25),
                includeHiddenFolders: "true",
                $select:
                  "id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount",
              },
            ),
            args.pageToken,
          );
          return { folders: page.items, nextPageToken: page.nextPageToken };
        },
      );
      register(
        "create_draft",
        "Save a new Outlook email draft for the user to review and send in Outlook. This does not send email. Only plain-text bodies are supported.",
        {
          subject: z.string().max(500),
          body: z.string().max(100000),
          to: z.array(z.email().max(320)).min(1).max(50),
          cc: z.array(z.email().max(320)).max(50).optional(),
          bcc: z.array(z.email().max(320)).max(50).optional(),
        },
        async (args) => {
          const recipients = (addresses: string[]) =>
            addresses.map((address) => ({ emailAddress: { address } }));
          return compactMessage(
            await callGraph(context, "POST", graphUrl("messages"), {
              subject: args.subject,
              body: { contentType: "Text", content: args.body },
              toRecipients: recipients(args.to),
              ccRecipients: recipients(args.cc ?? []),
              bccRecipients: recipients(args.bcc ?? []),
            }),
          );
        },
      );
      register(
        "create_folder",
        "Create an Outlook mail folder at the top level or within an existing folder.",
        { name: z.string().trim().min(1).max(255), parentFolderId: graphIdSchema.optional() },
        async (args) =>
          callGraph(
            context,
            "POST",
            graphUrl(
              args.parentFolderId
                ? `mailFolders/${graphId(args.parentFolderId)}/childFolders`
                : "mailFolders",
            ),
            { displayName: args.name },
          ),
      );
      // A move and a categories PATCH both answer with the whole message
      // resource, body included, so they go through the same truncation the
      // read tools use instead of returning an unbounded mail body.
      const move = async (messageId: string, destinationId: string) =>
        compactMessage(
          await callGraph(context, "POST", graphUrl(`messages/${graphId(messageId)}/move`), {
            destinationId,
          }),
        );
      register(
        "move_message",
        "Move a message to an Outlook folder. Moving can change the message id; use the returned id for subsequent actions.",
        { messageId: graphIdSchema, destinationFolderId: graphIdSchema },
        (args) => move(args.messageId, args.destinationFolderId),
      );
      register(
        "archive_message",
        "Move a message to the Outlook Archive folder. This is reversible. Use the returned message id after moving.",
        { messageId: graphIdSchema },
        (args) => move(args.messageId, "archive"),
      );
      register(
        "trash_message",
        "Move a message to Deleted Items. This is reversible and does not permanently delete mail. Use move_message with destinationFolderId inbox to restore it using the returned id.",
        { messageId: graphIdSchema },
        (args) => move(args.messageId, "deleteditems"),
      );
      register(
        "categorize_message",
        "Replace the categories on one message. Read its current categories first and preserve any the user wants to keep. An empty list removes all categories. Use category display names from Outlook; this does not manage the account's master category list.",
        {
          messageId: graphIdSchema,
          categories: z.array(z.string().trim().min(1).max(255)).max(50),
        },
        async (args) =>
          compactMessage(
            await callGraph(context, "PATCH", graphUrl(`messages/${graphId(args.messageId)}`), {
              categories: [...new Set(args.categories)],
            }),
          ),
      );
    },
  });
  return {
    ...service,
    async downloadAttachment(request: Request) {
      const url = new URL(request.url);
      const ticket = url.searchParams.get("ticket") ?? "";
      const parsed = z.object(attachmentSchema).safeParse({
        messageId: url.searchParams.get("messageId"),
        attachmentId: url.searchParams.get("attachmentId"),
      });
      const payload = verifyFirstPartyMcpTicket({
        audience: "opencompany-outlook-attachment-download",
        signingContext: "opencompany-outlook-attachment-ticket",
        ticket,
        secret: input.internalSecret,
      });
      if (
        !parsed.success ||
        !payload ||
        payload.operation.type !== "tools/call" ||
        payload.operation.tool !== "download_attachment" ||
        payload.operation.capability !== "query"
      )
        return new Response("Invalid download ticket.", { status: 401 });
      const expected = Buffer.from(
        downloadSignature(
          ticket,
          parsed.data.messageId,
          parsed.data.attachmentId,
          input.internalSecret,
        ),
      );
      const actual = Buffer.from(url.searchParams.get("signature") ?? "");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        return new Response("Invalid download signature.", { status: 401 });
      const authorization = await authorizeMicrosoftTicket(policy, payload);
      if (authorization) return authorization;
      const context: MicrosoftToolContext = {
        payload,
        connection: {
          provider: "outlook",
          userWorkosId: payload.userWorkosId,
          integrationId: payload.integrationId,
        },
        signal: request.signal,
        apiCall: input.apiCall ?? graphApiCall,
      };
      try {
        const metadata = await attachmentMetadata(context, parsed.data);
        const { bytes } = await (input.apiDownload ?? graphApiDownload)(
          context.connection,
          graphUrl(
            `messages/${graphId(parsed.data.messageId)}/attachments/${graphId(parsed.data.attachmentId)}/$value`,
          ),
          { signal: request.signal, maxBytes: MAX_ATTACHMENT_BYTES },
        );
        const filename = encodeURIComponent(metadata.name).replace(
          /['()*]/gu,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        return new Response(bytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
            "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${filename}`,
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex, nofollow, noarchive",
          },
        });
      } catch {
        return new Response(
          "Attachment unavailable. Check the connection and request a new download link.",
          { status: 502 },
        );
      }
    },
  };
}

function compactMessage(value: unknown) {
  const message = graphRecord(value);
  if (message.body && typeof message.body === "object") {
    const body = graphRecord(message.body);
    if (typeof body.content === "string")
      return {
        ...message,
        body: { contentType: body.contentType, content: body.content.slice(0, 30000) },
        bodyTruncated: body.content.length > 30000,
      };
  }
  return message;
}
async function attachmentMetadata(
  context: MicrosoftToolContext,
  args: { messageId: string; attachmentId: string },
) {
  const value = graphRecord(
    await callGraph(
      context,
      "GET",
      graphUrl(`messages/${graphId(args.messageId)}/attachments/${graphId(args.attachmentId)}`, {
        $select: "id,name,contentType,size,isInline",
      }),
    ),
  );
  if (value["@odata.type"] !== "#microsoft.graph.fileAttachment")
    throw new Error(
      "Only file attachments can be downloaded. Embedded Outlook items and reference attachments are not supported.",
    );
  if (
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > MAX_ATTACHMENT_BYTES
  )
    throw new Error("Outlook attachments must be at most 20 MB.");
  if (typeof value.name !== "string" || !value.name || value.name.length > 1024)
    throw new Error("Microsoft returned invalid attachment metadata.");
  return {
    name: value.name,
    size: value.size,
    contentType:
      typeof value.contentType === "string" ? value.contentType : "application/octet-stream",
  };
}
function downloadSignature(
  ticket: string,
  messageId: string,
  attachmentId: string,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update("opencompany-outlook-attachment-download\0")
    .update(JSON.stringify([ticket, messageId, attachmentId]))
    .digest("base64url");
}
