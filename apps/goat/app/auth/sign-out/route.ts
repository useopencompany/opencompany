import { signOut } from "@workos-inc/authkit-nextjs";

export async function GET(request: Request) {
  await signOut({ returnTo: new URL("/auth/sign-in", request.url).toString() });
}
