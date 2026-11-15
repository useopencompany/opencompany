import { requireNativeModule } from "expo";

const NativePhotoPickerPrewarm = requireNativeModule<{ prewarm: () => Promise<void> }>(
  "NativePhotoPickerPrewarm",
);

/** Starts the system photo picker's process ahead of use, so Photos opens without a cold start. */
export const prewarmPhotoPicker = (): Promise<void> => NativePhotoPickerPrewarm.prewarm();
