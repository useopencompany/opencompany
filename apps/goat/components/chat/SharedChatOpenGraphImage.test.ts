import { expect, it } from "vitest";
import { createSharedChatOpenGraphImage } from "@/components/chat/SharedChatOpenGraphImage";

it("renders a non-cacheable PNG social preview", async () => {
  const response = createSharedChatOpenGraphImage("Architecture review");
  const bytes = new Uint8Array(await response.arrayBuffer());

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});
