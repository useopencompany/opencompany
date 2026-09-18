const IS_DEV = process.env.APP_VARIANT === "development";

export default {
  name: IS_DEV ? "opencompany dev" : "opencompany",
  slug: "mobile-app",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: IS_DEV ? "opencompany-dev" : "opencompany",
  userInterfaceStyle: "automatic",
  platforms: ["ios"],
  ios: {
    icon: IS_DEV ? "./assets/ios-dev.icon" : "./assets/ios.icon",
    supportsTablet: false,
    bundleIdentifier: IS_DEV ? "cloud.opencompany.mobile-dev" : "cloud.opencompany.mobile",
    infoPlist: {
      CADisableMinimumFrameDurationOnPhone: true,
      NSPhotoLibraryAddUsageDescription:
        "opencompany needs permission to save images from chat messages to your photo library.",
    },
    config: {
      usesNonExemptEncryption: false,
    },
  },
  plugins: [
    "expo-router",
    [
      "expo-image-picker",
      {
        photosPermission: "Allow opencompany to access photos you choose to attach to messages.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow opencompany to use your camera to attach photos to messages.",
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: false,
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "26.0",
        },
      },
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: "#F7F7F5",
        image: "./assets/images/splash-icon.png",
        dark: {
          image: "./assets/images/splash-icon-dark.png",
          backgroundColor: "#111111",
        },
        imageWidth: 76,
      },
    ],
    [
      "expo-dev-client",
      {
        launchMode: "most-recent",
        addGeneratedScheme: IS_DEV,
      },
    ],
    "expo-web-browser",
    "expo-secure-store",
    "react-native-quick-crypto",
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    router: {},
    eas: {
      projectId: "1370f590-6c69-4e42-86e9-9bd68058d0f4",
    },
  },
};
