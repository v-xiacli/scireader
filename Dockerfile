FROM node:22-slim

# Install poppler-utils for pdf-poppler page rendering
RUN apt-get update && apt-get install -y poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Next.js standalone output
COPY .next/standalone ./
COPY .next/static ./.next/static

# Fix pdfjs-dist worker file missing from standalone trace
COPY node_modules/.pnpm/pdfjs-dist@4.10.38/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs \
     ./node_modules/.pnpm/pdfjs-dist@4.10.38/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs

EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]