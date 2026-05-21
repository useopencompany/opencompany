import { authkitProxy } from "@workos-inc/authkit-nextjs";
import { getWorkOSRedirectUri } from "@/lib/workos";

export default authkitProxy({
  redirectUri: getWorkOSRedirectUri(),
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/", "/auth/callback", "/auth/sign-in"],
  },
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
