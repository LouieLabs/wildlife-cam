/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a minimal self-contained server in .next/standalone for a small
  // container image (used by the Cloud Run Dockerfile).
  output: 'standalone',
};

export default nextConfig;
