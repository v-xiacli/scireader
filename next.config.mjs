/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist', '@napi-rs/canvas'],
  },
};

export default nextConfig;
