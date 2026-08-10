import { AuthPage } from "@/components/auth/AuthPage";

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ invitation_token?: string; email?: string }>;
}) {
  return <AuthPage mode="sign-in" searchParams={searchParams} />;
}
