/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist', 'pdf-poppler'],
  },
};

export default nextConfig;
