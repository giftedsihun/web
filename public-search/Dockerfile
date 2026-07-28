FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:public-search
ENV PUBLIC_SEARCH_PORT=8787
EXPOSE 8787
CMD ["node", "dist/public-search/server.js"]
