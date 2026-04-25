/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ["@react-pdf/renderer"],
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
