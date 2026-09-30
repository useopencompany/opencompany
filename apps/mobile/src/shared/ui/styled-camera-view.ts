import { CameraView } from "expo-camera";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { withUniwind } from "uniwind";

export const StyledCameraView: (props: ComponentPropsWithRef<typeof CameraView>) => ReactNode =
  withUniwind(CameraView);
