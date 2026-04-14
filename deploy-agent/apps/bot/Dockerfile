FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY apps/bot/package*.json ./apps/bot/
RUN npm ci --workspace=apps/bot

FROM node:22-alpine
WORKDIR /app
RUN addgroup --system --gid 1001 agent && adduser --system --uid 1001 agent
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY apps/bot/ ./apps/bot/
USER agent
ENV NODE_ENV=production
CMD ["npx", "tsx", "apps/bot/src/index.ts"]
