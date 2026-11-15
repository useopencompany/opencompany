import { AuthPage } from "@/components/auth/AuthPage";

export const metadata = { referrer: "no-referrer" };

export default function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ invitation_token?: string; email?: string; returnPathname?: string }>;
}) {
  return <AuthPage mode="sign-up" searchParams={searchParams} />;
}
