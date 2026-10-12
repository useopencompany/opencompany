import { CustomInferenceProvidersPanel } from "@/components/CustomInferenceProvidersPanel";
import { InferenceSettingsRoute } from "@/components/Routes";

export default function InferenceSettingsPage() {
  return (
    <>
      <InferenceSettingsRoute />
      <CustomInferenceProvidersPanel />
    </>
  );
}
