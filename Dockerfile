FROM node:22-slim

WORKDIR /app

# Copy Next.js standalone output
COPY .next/standalone ./
COPY .next/static ./.next/static

# Fix pdfjs-dist assets missing from standalone trace
COPY node_modules/.pnpm/pdfjs-dist@4.10.38/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs \
     ./node_modules/.pnpm/pdfjs-dist@4.10.38/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs
COPY node_modules/.pnpm/pdfjs-dist@4.10.38/node_modules/pdfjs-dist/standard_fonts \
     ./node_modules/.pnpm/pdfjs-dist@4.10.38/node_modules/pdfjs-dist/standard_fonts

EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
