# 2026-04-30 — wave-deploy skill：marker-file 為核心的智慧路由

## Status

Active

## Context

deploy-agent 的 web dashboard 是部署主介面，但對「每次小改 → 推一版」這種頻繁工作流摩擦太大：開瀏覽器、選專案、上傳檔案、等掃描 → 5 個動作至少一分鐘。

使用者要 Claude Code skill 化這條路：在終端機一句 `/wave-deploy` 就把 cwd 推到對應的專案上去。

最直覺的設計（v0 想法）是「每次都問：新專案還是更版？要更版的話請輸入 project name 或 URL」。但這樣每次都要使用者重新打字，本質上沒解決摩擦問題，只是把摩擦從 dashboard 搬到 CLI。

關鍵洞察：**skill 應該替使用者記住「這個目錄對應哪個專案」**，下次再跑就一鍵確認即可。這是 Vercel CLI（`.vercel/project.json`）、Firebase CLI（`.firebaserc`）、Netlify CLI（`.netlify/state.json`）都用的同一個 pattern——marker file。

## Decision

`~/.claude/skills/wave-deploy/` skill 採用 marker-file 為核心的智慧路由：

1. **預備偵測**（必跑）：`bin/wave-deploy-detect` bash script
   - 讀 `./.deploy-agent.json`（marker，記 projectId / projectName / url / lastDeployedAt）
   - 讀 `./package.json#name`（猜中可能的伺服器專案）
   - 讀 `git remote get-url origin`（未來用）
   - `GET /api/projects` 拿伺服器清單
   - 輸出四種 match level JSON：
     - `high` — marker 命中且伺服器有此 projectId（最常見的後續部署路徑）
     - `stale` — marker 存在但伺服器找不到（專案被刪）
     - `medium` — 無 marker，但有同名專案
     - `none` — 全新專案
   - 額外：`configMissing: true` 表示首次使用、要走 setup

2. **智慧路由**：根據 match level 走不同 AskUserQuestion：
   - high → 「更新此專案還是部署為新專案？」（A 推薦更新）
   - stale → 「marker 失效。新建還是重連？」
   - medium → 「找到同名專案，連結還是新建？」
   - none → 直接走新專案 flow，不問

3. **Update flow**：tar → `POST /api/upload/init` → PUT GCS → `POST /api/projects/:id/new-version`
4. **New project flow**：tar → upload → `POST /api/projects/submit-gcs`（帶 name + customDomain）
5. **Polling**：每 15s 輪 `/api/projects/:id`，狀態流 `scanning → review_pending → deploying → live`
6. **不主動 approve 安全審查**：人工閘門就是給人看的，skill 只引導使用者去 dashboard 或顯示 approve curl 範例
7. **收尾寫 marker** + 加進 `.gitignore`（marker 含 token-like 資訊不該 commit）

### 關鍵實作細節

- **detect 寫成 bash + jq**，不要 Node/TS：skill 要零 build step，使用者 clone 下來能跑
- **jq 的 `select(. != "")` 陷阱**：在 object constructor 裡某個欄位回傳 empty stream 會讓**整個物件**消失（silent zero output）。改用 `def nz: if . == "" then null else . end;` helper，empty 變 null 而非空流
- **Marker URL 用 customDomain，不是 cloudRunUrl**：`/api/projects/:id/detail` 的 `deployments[0].customDomain` 是 hostname（例 `legal-flow-builder.punwave.com`，無 scheme），要自己加 `https://`；只有 customDomain 缺時才回退到 `cloudRunUrl`
- **Config 路徑**：`~/.deploy-agent/config.json`（chmod 600）存 endpoint + apiKey；首次跑會引導去 dashboard 建 key
- **只在 v0.1 做 detect + deploy + write-marker**：status / logs / approve 等子命令延後到 v0.2

## Consequences

**好處**

- **後續部署 1-click**：marker 記住對應，第二次跑只要按 A 確認更新
- **安全閘門保留**：人工審查照舊走 dashboard，skill 不繞過
- **可逆**：marker 隨時 `rm` 解綁，重連也容易
- **跟 deploy-agent 主流程零耦合**：API 都是現有的 `/api/upload/init` + `/api/projects/submit-gcs` + `/api/projects/:id/new-version`，沒動 server 一行
- **AUTH_MODE permissive 下能跑**：anonymous 看得到 public 專案清單，第一版能 demo；之後 enforced 模式上線時 detect 會 fall back 到 API key
- **失敗大聲**：marker 失效（stale）走獨立 case，不會默默變成「咦怎麼又多一個重複專案」

**代價**

- **Marker 只繫到 cwd**：搬目錄、改名、worktree 都要重綁。Vercel / Netlify CLI 都接受這個 trade-off
- **monorepo 暫不支援**：marker schema 只記單一 projectId，多服務 repo 要 v0.2 的 `services: [...]` 擴充
- **Skill 不主動 approve**：使用者還是要切到 dashboard 看 scan report 才能往下推，這是設計 feature 不是 bug
- **大檔（>100MB）會卡**：v0.1 還是一次 PUT 完，沒接 chunked upload。chunked-upload-defaults ADR (2026-04-27) 的邏輯只在 web dashboard，CLI 還沒寫；v0.2 補

**未來工作（v0.2 以上）**

- `/wave-deploy status` — 顯示當前 cwd 對應專案的最新狀態 + URL + last image
- `/wave-deploy logs` — gcloud logging read 抓最近 N 行 log
- `/wave-deploy approve <review-id>` — 給有 `reviews:decide` 權限的 API key 用
- monorepo `services: [{ id, name, dirName }]` schema
- chunked upload（>100MB 自動切）
- detect `--json-only` 給 CI 用
- `.deploy-agent.json` 之外考慮 `.deploy-agent/state.json` 命名空間（Vercel 風格），預留多檔擴充

## 相關 ADR

- 2026-04-27 [bot-api-key-bootstrap](./2026-04-27-bot-api-key-bootstrap.md)：API key 機制本身就是這個 skill 的鑑權基礎
- 2026-04-25 [rbac-system-permissive-then-enforced](./2026-04-25-rbac-system-permissive-then-enforced.md)：permissive → enforced 切換時 skill 還能繼續用，已驗證
- 2026-04-27 [chunked-upload-defaults](./2026-04-27-chunked-upload-defaults.md)：v0.2 大檔切塊要從 web 端搬到 CLI

## 檔案清單

- `~/.claude/skills/wave-deploy/SKILL.md` — skill 主檔（frontmatter + 完整流程）
- `~/.claude/skills/wave-deploy/bin/wave-deploy-detect` — bash 偵測腳本（177 行）
- `~/.deploy-agent/config.json` — 使用者本機 endpoint + apiKey（chmod 600）
- `<cwd>/.deploy-agent.json` — 每個專案的 marker（自動加進 `.gitignore`）
