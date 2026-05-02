# 2026-05-01 — Review Gate UI Toggle（R45）

## Status

Active

## Context

R44 系列收完後，使用者反饋：自己一個人在用 wave-deploy-agent 部署自己的 vibe-coded 專案，每次 push 都要等自己跑去 dashboard 按 approve 很煩。Review gate 的初衷是「兩眼互看」——但如果 reviewer 跟 deployer 是同一個人，那這層就只是儀式性延遲。

但又不能直接拔掉。理由：

1. **未來會有別人用**：產品定位是「給 vibe-coded 專案的安全閘門」，下游使用者預設要保留 review。
2. **Scan + LLM analysis 的審計記錄要留**：threat report 是合規證據，不能因為 reviewer 是同一個人就跳掉產生。
3. **要可即時切換**：使用者今天累，想關；明天交給同事 review，要開回來。重新部署改 env var 太重。

需求：把 review 做成 settings 頁面的開關。
- ON（預設）：照原本邏輯停在 `review_pending`，等人工 approve。
- OFF：scan + LLM 照樣跑，產生 review record，但 pipeline 自動 approve 並直接 dispatch deploy。

## Decision

### 1. Storage：沿用既有 `settings` table（單列 JSONB）

不新建 table。`settings` 表本來就有 GCP / Cloudflare / Slack / API keys 一堆 column，加一個 `requireReview: boolean` 進 `data` JSONB 即可。

新建 `apps/api/src/services/settings-service.ts` 作為 runtime 讀取的單一進入點：

```typescript
export interface RuntimeSettings {
  requireReview: boolean;
}

export const RUNTIME_DEFAULTS: RuntimeSettings = {
  requireReview: true,  // 安全方向：預設開
};

export function parseRuntimeSettings(stored: unknown): RuntimeSettings {
  // 容錯：JSON string / object / null / 壞 JSON 都回到 defaults
  ...
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  // table 不存在 / row 不存在 → defaults
}
```

**為什麼 parser 跟 reader 分開**：parser 是純函式，可以無 DB 跑單元測試。`test-settings-service.ts` 鎖 10 個 case：undefined / null / 空 object / boolean true/false / 非 boolean garbage / JSON string round-trip / 壞 JSON / RUNTIME_DEFAULTS sanity。

### 2. Pipeline-worker：分支在 Step 9（scan + LLM 之後）

`apps/api/src/services/pipeline-worker.ts` Step 9 的舊邏輯：
```
transitionProject → review_pending
createReview(scanReport.id)
notifyReviewNeeded(...)  // Discord
```

新邏輯：
```
transitionProject → review_pending
createReview(scanReport.id)
const settings = await getRuntimeSettings();

if (settings.requireReview) {
  // 原邏輯：發 Discord 通知，等人工
  notifyReviewNeeded(...);
} else if (reviewId) {
  // R45 新路徑
  await submitReview(reviewId, 'approved', 'system', 'auto-approved (review disabled)');
  await transitionProject(projectId, 'approved', 'system', { reviewId, autoApproved: true });
  runDeployPipeline(projectId, reviewId).catch(...);
}
```

關鍵設計：

- **State machine 沒改**：`review_pending → approved` 本來就是合法 transition（人工 approve 就走這條），auto-approve 只是不同 reviewer（`'system'` vs human email）。R42 鎖死的 PINNED_TRANSITIONS 不需要動。
- **Audit trail 完整**：`scanReport` + `review` row 都還在，`reviewer = 'system'` 跟 `reason = 'auto-approved (review disabled)'` 留下證據。
- **Boss 可以反悔**：把開關打回 ON，下次 pipeline 又會停在 `review_pending`，但已經 dispatch 出去的 deploy 不會被 retract（這是 by design：不要做隱晦 rollback）。

### 3. Settings GET/PUT：boolean 安全處理

`routes/settings.ts` 的舊 merge loop 是 `if (value && key in settings)`——這會把 `false` 當 falsy 過濾掉。改寫成 type-aware：

```typescript
// GET
for (const [key, value] of Object.entries(data)) {
  if (value === undefined || !(key in settings)) continue;
  if (typeof value === 'boolean') {
    settings[k] = value;  // 不過濾 false
  } else if (typeof value === 'string') {
    if (SECRET_KEYS.has(k)) {
      settings[k] = value ? '••••••••' : '';
    } else {
      settings[k] = value;
    }
  }
}

// PUT
for (const [key, value] of Object.entries(body)) {
  if (value === undefined) continue;
  if (typeof value === 'string') {
    if (value === '') continue;
    if (value === '••••••••') continue;  // 沒改的 secret 不蓋
  }
  merged[key] = value;  // boolean 直接覆蓋（含 false）
}
```

### 4. UI：Toggle component（`<button role="switch">`）

不用 native checkbox（樣式跟設計系統不合）。用 `<button role="switch" aria-checked>` + 滑動小白圓。

```tsx
<Toggle
  label={t('requireReview')}
  hint={t('requireReviewHint')}
  value={settings.requireReview}
  onChange={(v) => update('requireReview', v)}
/>
```

加進 settings page 最上方一個獨立 Section（`reviewGate`），讓使用者一打開頁面就看到。i18n keys 在 en + zh-TW 同步。

### 5. Defaults：安全方向預設開

`RUNTIME_DEFAULTS.requireReview = true`。新裝、settings row 還沒建、parsing 失敗——都往 ON 倒。理由：少一個審查，最壞 case 是 vibe-coded 專案的 prompt-injection / SSRF 直接到 prod。多一個審查，最壞 case 是 boss 多按一個按鈕。不對稱。

## Consequences

**好處：**
- Solo dev 自己用：開關關掉 → push 完不用再去 dashboard，pipeline 自己走完。
- Audit 不變：scan + LLM 報告照樣存，後續要追責有 row。
- 沒改 state machine：R42 鎖的 transitions 全部維持，risk 表面積最小。
- Parser 純函式：可單元測試（10 個 case 鎖）。

**代價：**
- `settings` table 變成 hot path（每次 pipeline 跑都讀一次）。但只有 1 row，PG 連 connection pool warm 起來就是 sub-millisecond 級的 query，不擔心。
- 多一個 settings 欄位要記得 i18n（en + zh-TW 各加 3 keys）。
- 開關目前是「全站」單一旗標，不是 per-project。如果未來要某些專案強制 review、某些不用，需要再升級成 per-project override（屆時欄位移到 `projects.metadata`）。

**未來可能需要做：**
- Per-project override（上面提的）
- Auto-approve 的 retention：未來如果要 audit log 「這次部署是 auto-approved」，可以在 `deployments` table 加 `auto_approved: boolean` 欄位
- Slack 通知 hook：auto-approve 時也發訊息（現在只有 review-needed 時發），讓 boss 知道有部署正在跑

## 驗證

- `tsc --noEmit` 兩個 workspace 全綠
- `./scripts/sweep-zero-dep-tests.sh` 2729 passed / 0 failed across 45 files
- 新檔 `test-settings-service.ts` 10/10 PASS（parser 純函式所有 edge case）
- 部署：等 commit + push + Cloud Build
