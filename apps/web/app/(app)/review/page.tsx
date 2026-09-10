import { ReviewInboxRoute } from "@/components/ReviewInbox";
import { ReviewInboxDisabledRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";

export default async function ReviewPage() {
  const context = await currentUser();
  if (!context.user.reviewInboxEnabled) return <ReviewInboxDisabledRoute />;
  return <ReviewInboxRoute />;
}
