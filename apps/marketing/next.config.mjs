/** @type {import('next').NextConfig} */
const nextConfig = {
  // The marketing site ships TypeScript source from @opencompany/ui (no build step),
  // so Next must transpile it like a first-party module.
  transpilePackages: ["@opencompany/ui"],
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
