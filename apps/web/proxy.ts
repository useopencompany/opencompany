import { authkitProxy } from "@workos-inc/authkit-nextjs";
import { getWorkOSRedirectUri } from "@/lib/workos";

export default authkitProxy({
  redirectUri: getWorkOSRedirectUri(),
  signUpPaths: ["/auth/sign-up"],
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [
      "/",
      "/signin",
      "/signup",
      "/auth/callback",
      "/auth/organization",
      "/auth/sign-in",
      "/auth/sign-up",
      "/api/inngest",
      "/docs",
      "/docs/:path*",
    ],
  },
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|docs(?:/.*)?).*)"],
};
