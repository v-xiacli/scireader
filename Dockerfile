FROM node:22-slim
WORKDIR /app
COPY .next/standalone ./
COPY .next/static ./.next/static
EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]