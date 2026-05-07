# 2026-05-07 — Vite static-app detection in dockerfile-gen（R59）

## Status

Active

## Context

`bid-ops-frontend` 部署 v1 失敗 canonical：

```
detectedLanguage: typescript
detectedFramework: null   ← 沒認出 Vite
```

`dockerfile-gen.ts` 對 typescript+null 走 generic Node SSR template：

```dockerfile
FROM node:22-alpine AS deps
...
RUN npm run build 2>/dev/null || true
ENV PORT=3000
CMD ["node", "dist/index.js"]
```

但 Vite + React 專案 `npm run build` 輸出**只有靜態檔案在 `dist/`**，不會產生 `dist/index.js` server entry。Container 啟動找不到 entry → 沒 listen → Cloud Run health check 4 分鐘 timeout → fail。

LLM diagnosis 抓得到 root cause（gpt provider：「Vite 是純前端，build 後沒 server entrypoint」）但 platform 沒 deterministic 修法。User workaround：自己加 nginx Dockerfile + 重 deploy。

## Decision

加 Vite 偵測 + 專屬 Dockerfile 生成器。

### 偵測（`project-detector.ts:80`）

`deps['vite']` 存在 AND `vite.config.{ts,js,mjs}` 存在 → `framework = 'vite-static'`、`port = 80`。

兩個條件 AND 是為了避免 false positive：有些 package 把 `vite` 列為 peer dep 但實際不用 Vite 當 build tool。

```typescript
else if (deps['vite']) {
  const hasViteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
    .some((name) => fileNames.has(name));
  if (hasViteConfig) {
    result.framework = 'vite-static';
    result.port = 80;
  }
}
```

### 生成器（`dockerfile-gen.ts` 新 `generateViteStaticDockerfile`）

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
RUN : > /tmp/nginx.conf.template \
 && echo 'server {' >> /tmp/nginx.conf.template \
 && echo '    listen 80;' >> /tmp/nginx.conf.template \
 && echo '    root /usr/share/nginx/html;' >> /tmp/nginx.conf.template \
 && echo '    index index.html;' >> /tmp/nginx.conf.template \
 && echo '    location / { try_files $uri $uri/ /index.html; }' >> /tmp/nginx.conf.template \
 && echo '    gzip on;' >> /tmp/nginx.conf.template \
 && echo '    gzip_types ...' >> /tmp/nginx.conf.template \
 && echo '}' >> /tmp/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "sed \"s/listen 80;/listen ${PORT:-8080};/\" /tmp/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
```

### 為什麼這個架構

| 選項 | 為什麼不選 |
|------|-----------|
| `serve -s dist -l ${PORT}` (Node-based static server) | 多裝一個 npm package，runtime 也是 Node 大映像 |
| 寫死 `listen ${PORT}` 在 nginx config（envsubst 整份）| 需要 envsubst + `${VARS}` 列表，比 sed 一個字串複雜 |
| **nginx + sed 替換 `listen 80;`（選用）** | nginx:alpine 約 50 MB、可生產級、SPA fallback 內建、sed 一行解 PORT 注入 |
| 用 user 自己的 nginx.conf | 違反 R44h 精神（不動 user files），且 R59 是 auto-gen path（user 沒 Dockerfile = 大概也沒 nginx.conf）|

### 為什麼用 echo + heredoc 寫 nginx config 而不是 COPY

Auto-gen Dockerfile 必須 self-contained — 我們不能假設 user source 裡有 `nginx.conf` 模板。echo + heredoc 把 default 寫死在 Dockerfile build 時間就好。

### SPA fallback（`try_files $uri $uri/ /index.html`）

Vite + React Router / Vue Router 走 client-side routing。Deep link（`/about`、`/users/123`）瀏覽器會直接打 `/about` URL → nginx 找不到 file → 404。`try_files` fallback 到 `index.html` 讓 React Router 在 client 處理 routing。是 Vite/CRA SPA 必備設定。

## Consequences

**好處**：
- 未來 user 上傳 Vite 專案沒帶 Dockerfile，pipeline 自動產 nginx 多階段 build，5-7 min 內 live（不再 4 分鐘 timeout）
- bid-ops-frontend 那種 case 變 first-class supported（user 也不需要自己手寫 Dockerfile）
- nginx 比 Node serve 快、image 小、生產級
- SPA fallback 內建解 client-side routing 404

**代價**：
- nginx:alpine 約 50 MB image（vs Node serve 約 200 MB image — nginx 反而省）
- sed 替換 `listen 80;` 是 fragile：user 自己改的 nginx.conf 如果有 `listen 80 default_server;` 不會被替換到（regex 是 word-boundary）。但 auto-gen path 我們完全控制 default config，這不是問題
- Vite library mode（`build.lib` 設定）跟 SSR mode（`ssr` plugin）不適用此 Dockerfile — 但 R59 v1 不偵測這些 sub-mode，user 自己處理（R59.1 future work）

**已知未解 risk**：
- vite 偵測沒看 `vite.config.ts` 內容 — 只看 file 存在。v1 不分 SPA / library / SSR，所有都當 SPA。如果 user 是 library 模式，R59 產的 image 是 unusable 的（nginx 找不到 dist/index.html）但 build 不會 crash pipeline
- 沒處理 Astro / Remix / Solid Start / Tanstack Start 等其他 static-output 框架 — 各自要單獨偵測 + 生成器（future work R59.x）

## 驗證

- `tsc --noEmit` 兩 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **3025 passed / 0 failed across 55 files**（3018 → +7 R59 tests）
- 7 個新 R59 tests in `test-dockerfile-gen.ts`：
  - multi-stage build with nginx runtime
  - SPA fallback `try_files`
  - sh -c form for $PORT expansion
  - regression guard：不 emit `node dist/index.js`
  - npm/pnpm/yarn/bun lockfile patterns 各自處理
  - nginx config + gzip
  - EXPOSE 8080 + ENV PORT=8080

- E2E（未做）：等下次 user 上傳 Vite project 沒帶 Dockerfile 自然驗證

## 後續

- TODOS.md R59 entry 標 done
- R59.1 future：偵測 Vite 子模式（SSR / library）並走不同 Dockerfile 路徑
- R59.2 future：Astro / Remix / Solid 等 static-output 框架擴充
