/** @type {import('next').NextConfig} */
const nextConfig = {
  // The design system ships TypeScript source from @opencompany/ui (no build step),
  // so Next must transpile it like a first-party module.
  transpilePackages: ["@opencompany/ui"],
};

export default nextConfig;
