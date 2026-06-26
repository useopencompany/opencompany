/** @type {import('next').NextConfig} */
const nextConfig = {
  // @opencompany/ui ships TypeScript source, so Connector transpiles it like app code.
  transpilePackages: ["@opencompany/ui"],
};

export default nextConfig;
