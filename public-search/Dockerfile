FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:public-search
ENV PUBLIC_SEARCH_PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PUBLIC_SEARCH_PORT || '8787') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/public-search/server.js"]
