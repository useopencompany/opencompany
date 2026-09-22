import Constants from "expo-constants";

export const APP_VARIANT =
  Constants.expoConfig?.extra?.appVariant === "development" ? "development" : "production";

export const IS_DEVELOPMENT_BUILD = APP_VARIANT === "development";
