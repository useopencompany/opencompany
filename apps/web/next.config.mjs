import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@opencompany/analytics", "@opencompany/db"],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
