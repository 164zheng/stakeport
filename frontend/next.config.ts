import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the World routes read public/deployment.json at runtime (serverless functions don't ship public/ otherwise)
  outputFileTracingIncludes: { "/api/world/**": ["./public/deployment.json"] },
};

export default nextConfig;
