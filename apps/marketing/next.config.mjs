/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source without a separate build step,
  // so Next must transpile them like first-party modules.
  transpilePackages: ["@opencompany/analytics", "@opencompany/ui"],
  async redirects() {
    return [
      {
        source: "/talk",
        destination: "https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding",
        permanent: true,
      },
      {
        source: "/product",
        destination: "/",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
