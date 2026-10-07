import { AuthPage } from "@/components/auth/AuthPage";

export const metadata = { referrer: "no-referrer" };

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ invitation_token?: string; email?: string; returnPathname?: string }>;
}) {
  return <AuthPage mode="sign-in" searchParams={searchParams} />;
}
