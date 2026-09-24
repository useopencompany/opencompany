import { downloadChatAttachment } from "@opencompany/agent/chat-attachment-storage";
import type { slackApiRequest } from "@opencompany/agent/integrations/slack";

export type SlackPostImageSource = {
  title: string;
  filename: string;
  blobPathname: string;
};
export type SlackPostImage = { fileId: string; title: string };

type Dependencies = {
  request: typeof slackApiRequest;
  download: (pathname: string, options: { signal: AbortSignal }) => Promise<Buffer>;
  fetch: typeof fetch;
};

const defaults: Omit<Dependencies, "request"> = { download: downloadChatAttachment, fetch };

// Slack's section text limit. The post's own text is capped at 3500 characters, so a long one
// spans two sections rather than being cut.
const SECTION_TEXT_LIMIT = 3000;
// A file referenced right after its upload completes is rejected as invalid_blocks until Slack
// finishes processing it, and Slack publishes no readiness signal. The rejection means nothing was
// posted, so waiting and posting again cannot duplicate the message.
export const SLACK_IMAGE_READY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

// Uploads without a channel keep the files private to the bot until the post that references them.
// Sharing them straight into the thread would post them as their own message, which drops the
// delivery metadata reconciliation reads and returns no message timestamp to thread replies under.
export async function uploadSlackPostImages(
  input: { token: string; images: SlackPostImageSource[] },
  deps: Pick<Dependencies, "request"> & Partial<Dependencies>,
): Promise<SlackPostImage[]> {
  const { request, download, fetch: upload } = { ...defaults, ...deps };
  const uploaded = await Promise.all(
    input.images.map(async (image): Promise<SlackPostImage> => {
      const bytes = await download(image.blobPathname, { signal: AbortSignal.timeout(30_000) });
      const ticket = await request<{ upload_url?: string; file_id?: string }>({
        token: input.token,
        method: "files.getUploadURLExternal",
        signal: AbortSignal.timeout(10_000),
        form: { filename: image.filename, length: String(bytes.byteLength) },
      });
      if (typeof ticket.upload_url !== "string" || typeof ticket.file_id !== "string")
        throw new Error("Slack returned no upload URL for the image.");
      const response = await upload(ticket.upload_url, {
        method: "POST",
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Slack image upload failed with ${response.status}.`);
      return { fileId: ticket.file_id, title: image.title };
    }),
  );
  if (uploaded.length > 0)
    await request({
      token: input.token,
      method: "files.completeUploadExternal",
      signal: AbortSignal.timeout(15_000),
      form: {
        files: JSON.stringify(uploaded.map((file) => ({ id: file.fileId, title: file.title }))),
      },
    });
  return uploaded;
}

export function slackPostBlocks(text: string, images: SlackPostImage[]) {
  return [
    ...splitSectionText(text).map((chunk) => ({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    })),
    ...images.map((image) => ({
      type: "image",
      slack_file: { id: image.fileId },
      alt_text: image.title.slice(0, 2000),
      title: { type: "plain_text", text: image.title.slice(0, 2000) },
    })),
  ];
}

// Breaks at a line or word boundary, never inside a <url|label> link or a surrogate pair, so each
// section still renders the mrkdwn it was written with.
function splitSectionText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SECTION_TEXT_LIMIT) {
    const window = rest.slice(0, SECTION_TEXT_LIMIT);
    let cut = window.lastIndexOf("\n");
    if (cut < SECTION_TEXT_LIMIT / 2) cut = window.lastIndexOf(" ");
    if (cut < SECTION_TEXT_LIMIT / 2) cut = SECTION_TEXT_LIMIT;
    const openLink = window.lastIndexOf("<", cut);
    if (openLink > window.lastIndexOf(">", cut) && openLink > 0) cut = openLink;
    if (/[\uD800-\uDBFF]/.test(rest.charAt(cut - 1))) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[ \n]/, "");
  }
  chunks.push(rest);
  return chunks;
}

export function isSlackFileNotReady(error: unknown) {
  return error instanceof Error && /returned invalid_blocks/.test(error.message);
}

export function slackImageLinkText(text: string, taskUrl: string | null) {
  return taskUrl
    ? `${text}\n\n<${taskUrl}|See the images in opencompany>`
    : `${text}\n\n_The images are in the opencompany task._`;
}
