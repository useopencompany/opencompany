import { inngest } from "@/lib/inngest/client";

export const SIGNUP_WELCOME_EMAIL_REQUESTED_EVENT = "email.signup_welcome_requested";

export type SignupWelcomeEmailRequestedEventData = {
  userId: string;
  workspaceId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

export function dispatchSignupWelcomeEmailRequested(input: SignupWelcomeEmailRequestedEventData) {
  return inngest.send({
    name: SIGNUP_WELCOME_EMAIL_REQUESTED_EVENT,
    data: input,
  });
}
