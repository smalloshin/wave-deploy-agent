---
name: deploy-ready
description: 讓專案符合 Wave Deploy Agent 部署規範的架構指南。開發時遵守這些規則，就能一鍵潮部署。觸發詞：「幫我準備部署」「部署規範」「deploy ready」
---

# /deploy-ready — Wave Deploy Agent 部署架構指南

這份指南告訴你（AI 或開發者）如何在開發階段就讓專案能夠被 Wave Deploy Agent 成功部署到 GCP Cloud Run。

---

## 支援的框架與語言

| 語言 | 框架 | 預設 Port | 啟動方式 |
|------|------|-----------|----------|
| Node.js | Next.js | 3000 | `node server.js` (standalone) |
| Node.js | Nuxt | 3000 | `node .output/server/index.mjs` |
| Node.js | SvelteKit | 5173 | `node build` |
| Node.js | Express / Fastify / Hono | 3000 | `node dist/index.js` |
| Python | FastAPI | 8000 | `uvicorn main:app --host 0.0.0.0` |
| Python | Django | 8000 | `gunicorn --bind 0.0.0.0:$PORT config.wsgi` |
| Python | Flask | 5000 | `gunicorn --bind 0.0.0.0:$PORT app:app` |
| Go | 任意 | 8080 | 編譯後的二進位檔 |
| Static | HTML/CSS/JS | 8080 | nginx |

不在上表的框架也能部署，但**必須自備 Dockerfile**。

---

## 必要條件（Checklist）

### 1. 專案根目錄要有可辨識的結構

系統依以下檔案偵測語言與框架：

```
Node.js  → package.json（必須存在）
Python   → requirements.txt / pyproject.toml / Pipfile（至少一個）
Go       → go.mod + go.sum
Static   → index.html（無 package.json）
```

**如果偵測不到語言，部署會失敗。**

### 2. Port 必須用環境變數

Cloud Run 會透過 `PORT` 環境變數告訴容器該監聽哪個 port。你的程式**必須**讀取 `PORT`：

```python
# Python (FastAPI)
import os
port = int(os.environ.get("PORT", 8000))
uvicorn.run(app, host="0.0.0.0", port=port)
```

```javascript
// Node.js (Express)
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0');
```

```go
// Go
port := os.Getenv("PORT")
if port == "" { port = "8080" }
http.ListenAndServe("0.0.0.0:"+port, handler)
```

**不要 hardcode port。不要 bind 到 127.0.0.1（必須用 0.0.0.0）。**

### 3. 環境變數管理

#### 自動偵測的變數（不用手動設）
- `NODE_ENV` → 自動設為 `production`
- `PORT` → Cloud Run 自動注入
- `HOST` / `HOSTNAME` → 自動設為 `0.0.0.0`
- `DATABASE_URL` → 如果程式碼有引用，自動建立 Cloud SQL 資料庫並注入連線字串
- `APP_URL` / `BASE_URL` / `SITE_URL` → 自動設為部署後的 URL
- `GCP_PROJECT` / `GOOGLE_CLOUD_PROJECT` → 自動設為 GCP 專案 ID
- Secret 類變數（`*_SECRET`, `*_KEY`）→ 自動生成高強度隨機值

#### 必須手動提供的變數
- 第三方 API Key：`OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `SENDGRID_API_KEY` 等
- OAuth 憑證：`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 等
- Redis 連線：`REDIS_URL`（Cloud SQL 自動配，但 Redis 不會）
- 任何系統無法猜到的外部服務憑證

#### 最佳做法：提供 `.env.example`

```bash
# .env.example — 部署系統會讀這個檔案來知道需要哪些變數
DATABASE_URL=postgresql://user:pass@localhost/mydb
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me
OPENAI_API_KEY=sk-xxx
```

系統會掃描 `.env.example`、`.env.sample`、`.env.template` 來找出需要的變數名。

#### 注意：`NEXT_PUBLIC_*` 是 build-time 變數

Next.js 的 `NEXT_PUBLIC_*` 變數必須在**建構時**就存在。部署後設定無效。
如果你的 Dockerfile 沒有處理，請用 ARG：

```dockerfile
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build
```

然後在部署後透過 dashboard 的環境變數管理設定。

### 4. Dockerfile（選填但建議）

如果不提供 Dockerfile，系統會依框架自動產生。但**自備 Dockerfile 有更好的控制力**。

#### 自備 Dockerfile 注意事項

```dockerfile
# 必須：監聽 PORT 環境變數
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

# 更好的做法：用 $PORT
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
```

**不要在 Dockerfile 中放真正的 secret：**
```dockerfile
# 錯誤 — secret 會被記錄在 image layer 中
ENV DATABASE_URL=postgresql://real-user:real-pass@prod-db/myapp

# 正確 — 用假值，部署時會被覆蓋
ENV DATABASE_URL=build-placeholder
```

系統會偵測 Dockerfile 中的 ENV 宣告，並把 dummy 值（`build-placeholder`、`change_me` 等）替換為正確的值。

### 5. 資料庫

#### Cloud SQL (PostgreSQL) — 自動配置

只要你的程式碼引用了以下任何變數，系統會**自動**：
- 在共享 Cloud SQL 上建立專屬資料庫（`proj_{your_project}`）
- 建立專屬用戶（`user_{your_project}`）
- 生成安全密碼
- 注入完整的連線字串

偵測的變數名：
- `DATABASE_URL`
- `*_DATABASE_URL`（例如 `POSTGRES_DATABASE_URL`）
- `DB_URL`

連線字串格式：
```
postgresql://user_{project}:{password}@/proj_{project}?host=/cloudsql/{instance}
```

#### 注意事項
- 使用 Unix socket 連線（Cloud Run 原生支援）
- 不需要設定 `DB_HOST`、`DB_PORT` 等，只要用 `DATABASE_URL` 就好
- ORM（SQLAlchemy, Prisma, TypeORM, Drizzle）都支援這個格式
- **不要在 .env 裡放本地的 postgres 連線** — 系統會自動替換成 Cloud SQL

### 6. 靜態檔案 / 前後端分離

Cloud Run 是容器服務，不是靜態託管。如果是純前端：

- **Next.js / Nuxt / SvelteKit** → 自動處理 SSR + 靜態
- **純 HTML/CSS/JS** → 系統會用 nginx 容器
- **React (CRA) / Vue (Vite)** → 自備 Dockerfile，用 nginx 或 `serve` 套件

```dockerfile
# React SPA 範例
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

---

## 常見失敗與解法

| 症狀 | 原因 | 解法 |
|------|------|------|
| `Container failed to start on PORT` | 程式啟動時 crash（通常是 DB 連不上） | 查看 Cloud Run logs，確認 DB 連線字串正確 |
| `exec format error` | 在 Mac ARM 建 image 但 Cloud Run 是 amd64 | Dockerfile 加 `FROM --platform=linux/amd64` |
| Build 成功但 404 | 框架沒有根路由 `/` | API 後端正常，用 `/docs` 或 `/api` 測試 |
| 環境變數顯示 0 | 尚未部署或未從 Cloud Run 讀取 | 部署完成後重新整理 dashboard |
| `NEXT_PUBLIC_*` 無效 | Build-time 變數沒在建構時設定 | 在 Dockerfile 用 ARG 傳入 |
| DB auth failed | 用了共享用戶連別人的 DB | 讓系統自動產生 per-project 連線字串 |

---

## 專案模板

### FastAPI + PostgreSQL

```
my-project/
├── main.py          # FastAPI app，引用 DATABASE_URL
├── models.py        # SQLAlchemy models
├── requirements.txt # fastapi, uvicorn, sqlalchemy, psycopg2-binary
├── Dockerfile       # （選填）
└── .env.example     # DATABASE_URL=postgresql://...
```

### Next.js

```
my-project/
├── package.json     # next, react, react-dom
├── next.config.js   # output: 'standalone' （建議）
├── src/
│   └── app/         # App Router
├── .env.example     # NEXT_PUBLIC_API_URL=http://localhost:3000
└── Dockerfile       # （建議自備，處理 NEXT_PUBLIC_* ARG）
```

### Express API

```
my-project/
├── package.json     # express + "start": "node dist/index.js"
├── src/
│   └── index.ts     # app.listen(process.env.PORT || 3000)
├── tsconfig.json
└── .env.example     # DATABASE_URL=postgresql://...
```

---

## 適用此指南的時機

當你被要求開發一個專案並且知道最終要透過 Wave Deploy Agent 部署時，**從一開始就遵守這些規則**：

1. 用 `process.env.PORT` / `os.environ["PORT"]` 監聽 port
2. 用 `DATABASE_URL` 環境變數連資料庫（不要 hardcode）
3. 提供 `.env.example` 列出所有環境變數
4. 確保有 `package.json` / `requirements.txt` 等標記檔
5. 如果是 Next.js，在 next.config.js 加 `output: 'standalone'`
6. Bind 到 `0.0.0.0`，不要 `127.0.0.1`
