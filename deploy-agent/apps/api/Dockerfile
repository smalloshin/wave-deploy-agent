FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/shared/package*.json ./packages/shared/
RUN npm ci --workspace=apps/api --workspace=packages/shared

FROM node:22-alpine
WORKDIR /app

# Install security scanning tools (semgrep + trivy)
# Note: keep py3-pip installed — removing it also removes 'packaging' which semgrep needs
RUN apk add --no-cache python3 py3-pip curl tar gzip postgresql16-client && \
    pip3 install --break-system-packages semgrep && \
    curl -sL https://github.com/aquasecurity/trivy/releases/download/v0.69.3/trivy_0.69.3_Linux-64bit.tar.gz -o /tmp/trivy.tar.gz && \
    tar xzf /tmp/trivy.tar.gz -C /usr/local/bin trivy && \
    chmod +x /usr/local/bin/trivy && \
    rm /tmp/trivy.tar.gz && \
    apk del curl && \
    rm -rf /root/.cache /tmp/*

RUN addgroup --system --gid 1001 agent && adduser --system --uid 1001 agent
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER agent
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "apps/api/src/index.ts"]
