import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { CircleAlert } from "lucide-react";

const CONTENT_REJECTION_MARKERS = [
  "datainspectionfailed",
  "data_inspection_failed",
  "inappropriate content",
  "content filter",
  "content_filter",
];

export function TurnErrorNotice({
  error,
  hasPartialOutput,
}: {
  error: string;
  hasPartialOutput: boolean;
}) {
  const description = turnErrorDescription(error, hasPartialOutput);

  return (
    <Alert className="w-fit max-w-[80%] px-3 py-2.5 text-[13px]" variant="warning">
      <CircleAlert aria-hidden="true" />
      <AlertTitle className="text-[13px]">Response stopped</AlertTitle>
      <AlertDescription className="text-[12.5px] leading-5">
        <p>{description}</p>
      </AlertDescription>
    </Alert>
  );
}

function turnErrorDescription(error: string, hasPartialOutput: boolean) {
  const normalizedError = error.toLowerCase();
  const contentWasRejected = CONTENT_REJECTION_MARKERS.some((marker) =>
    normalizedError.includes(marker),
  );

  if (contentWasRejected) {
    return hasPartialOutput
      ? "The selected model couldn’t process some content returned by a source. Everything completed above is still available. Try another model to continue."
      : "The selected model couldn’t process some content in this request. Try another model to continue.";
  }

  return hasPartialOutput
    ? "The response stopped unexpectedly. Everything completed above is still available."
    : "The response stopped unexpectedly. Please try again.";
}
