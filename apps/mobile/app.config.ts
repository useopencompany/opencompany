const IS_DEV = process.env.APP_VARIANT === "development";

export default {
  name: IS_DEV ? "opencompany dev" : "opencompany",
  slug: "mobile-app",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "opencompany",
  userInterfaceStyle: "automatic",
  platforms: ["ios"],
  ios: {
    icon: IS_DEV ? "./assets/ios-dev.icon" : "./assets/ios.icon",
    supportsTablet: false,
    bundleIdentifier: IS_DEV ? "cloud.opencompany.mobile-dev" : "cloud.opencompany.mobile",
  },
  plugins: [
    "expo-router",
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
