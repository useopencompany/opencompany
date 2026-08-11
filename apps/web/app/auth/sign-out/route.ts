import { signOut } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { hostSessionCookieDeletion } from "@/lib/headless-chat-session-cookie";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const cookieStore = await cookies();
  cookieStore.set(
    hostSessionCookieDeletion(
      process.env.WORKOS_COOKIE_NAME?.trim() || "wos-session",
      requestUrl.protocol === "https:",
    ),
  );
  await signOut({ returnTo: new URL("/signin", request.url).toString() });
}
