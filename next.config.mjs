/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["@react-pdf/renderer"],
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
