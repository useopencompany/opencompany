import { AuthPage } from "@/components/auth/AuthPage";

export default function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ invitation_token?: string; email?: string }>;
}) {
  return <AuthPage mode="sign-up" searchParams={searchParams} />;
}
