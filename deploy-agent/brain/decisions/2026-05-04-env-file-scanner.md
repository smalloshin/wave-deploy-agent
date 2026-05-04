# 2026-05-04 — .env file scanner（R55）

## Status

Active

## Context

`luca-v2-20260504-luca-optimizer-kb` 部署在 1.3 秒就被 R49 Step 2.7 block 了，錯誤訊息：

```
failedStep: Step 2.7: Required env vars
errorCode: env_vars_required
missingRequired:
  - GEMINI_API_KEY: paired credential — owned by external service, cannot auto-generate
```

但**用戶 source 裡有 `.env` 檔案，裡面已經寫了 `GEMINI_API_KEY=AIzaSyCXUnYqWGCzpMHmv6mZDPmz8iCViRPpvUk`**。R49 卻判定 missing。

**Root cause**：R49 的 `userProvidedKeys` 只看 `project.config.envVars`（dashboard 設的那欄），沒讀 source 裡的 `.env`。所以即使 user 已經提供值，R49 也看不到。

從 user 角度：「我明明 source 裡有寫，你為什麼擋？」這是 R49 的 false-positive。

順帶發現一個 **P0 security 問題**：user 的 `.env` 包含**真實 production secrets**：

```
OPENAI_API_KEY=sk-svcacct-OhzTMp5vBf3oVKxNS7Rg8...
JWT_SECRET=f89964c7491f16e2abfdfcd447c2879ec04ec413c2e0247c29e1d9f6930c2008
META_ACCESS_TOKEN=EAAMyof4K2FcBRPRceXiZCRZB8X1gZBUCXDwZBWlsbAc2qRA...
GOOGLE_CLIENT_SECRET=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
GOOGLE_ADS_DEVELOPER_TOKEN=VObAOh6nBPeMB1tb7saKgA
GEMINI_API_KEY=AIzaSyCXUnYqWGCzpMHmv6mZDPmz8iCViRPpvUk
... (還有更多)
```

這些已經在我們 GCS（`sources-fixed/...`）跟 deployed-source-capture 裡了。**Pipeline 應該至少 log 警告**讓 operator 知道。

## Decision

### Part 1：新 pure module `env-file-scanner.ts`

```typescript
export interface EnvFileScanResult {
  keys: Set<string>;          // 所有讀到的 KEY
  filesRead: string[];        // 實際讀的檔案（給 log）
  realSecretsDetected: Array<{ key, file, reason }>;  // 真實 secrets 偵測
}

export function scanEnvFiles(projectDir: string): EnvFileScanResult;
export function parseEnvFileContent(content: string): Map<string, string>;
export function detectRealSecret(value: string): string | null;
```

**讀什麼**（root-level 而已，不 recurse）：
- `.env`
- `.env.local`
- `.env.production`
- `.env.staging`
- `.env.development`

**跳過什麼**（templates，值是 placeholder）：
- `.env.example`
- `.env.sample`
- `.env.template`
- `.env.dist`
- `.env.test`
- `.env.tpl`

**Parser**：tolerant — 處理 `# comment`, blank lines, `export KEY=VALUE`, `"quoted"`, `'single-quoted'`, inline `# comment`（only on unquoted values，避免砍掉 quoted 字串裡的 `#`），CRLF。Reject invalid identifiers（數字開頭 / 含 `-` / 含空白）。

**Real-secret 偵測**（pattern + placeholder filter）：

| Pattern | 範例 | Reason |
|---------|------|--------|
| `^sk-svcacct-...` | OpenAI service account | OpenAI service account key |
| `^sk-ant-...` | Anthropic | Anthropic API key |
| `^sk-...` | OpenAI generic | OpenAI API key (sk-...) |
| `^AIza...` | Google API | Google API key (AIza...) |
| `^EAA...` | Meta access token | Meta / Facebook access token |
| `^ghp_...` / `^github_pat_...` | GitHub | GitHub personal access token |
| `^GOCSPX-...` | Google OAuth | Google OAuth client secret |
| `^xox[abp]-...` | Slack | Slack token |
| `^[a-f0-9]{32,}$` | hex | long hex string (likely secret hash) |

**Placeholder filter**（這些 value 不算 secret）：
- `your-key-here`, `your_secret`, `YOUR-API-KEY`
- `<replace>`, `<your-key>`
- `xxx`, `xxxxxx`, `placeholder`, `TODO`, `change-me`, `fixme`
- `${SOME_VAR}`
- `true` / `false` / `null` / `none`
- 純數字（port 之類）

順序很重要：**specific patterns 在前**（`sk-svcacct-` / `sk-ant-` 在 `sk-` 之前），不然會被 generic 搶先匹配。

### Part 2：整合進 pipeline-worker.ts Step 2.7

在現有的 `userProvidedKeys = parseEnvVarKeys(...)` 之後立刻加：

```typescript
try {
  const envFileScan = scanEnvFiles(projectDir);
  if (envFileScan.filesRead.length > 0) {
    for (const k of envFileScan.keys) userProvidedKeys.add(k);
    console.log(`[Pipeline] R55: read ${envFileScan.keys.size} env var(s) from ${envFileScan.filesRead.join(', ')}`);
  }
  if (envFileScan.realSecretsDetected.length > 0) {
    console.warn(`[Pipeline] R55: ⚠️  SECURITY: detected ${envFileScan.realSecretsDetected.length} REAL secret(s) committed`);
    // log up to 8 specifics
  }
} catch { /* never throw */ }
```

Best-effort：scan 失敗就 skip，不阻塞 pipeline。

### Part 3：刻意不做

- **不 block deploy on real secrets**：user 已經 commit 了，現在 block 太晚（secrets 已經在 GCS）。Just warn 讓 operator 自己 rotate
- **不自動把 secrets 從 source 刪除**：動 user files 是 footgun
- **不擴 scan 到 subdirs**：standard 約定 `.env` 在 root，recurse 只是增加 false-positive surface
- **不讀 `.env.example`**：值是 placeholder，merge 進去會反而擋住 user 沒設的真 keys

## Consequences

**好處：**
- `luca-v2-20260504-luca-optimizer-kb` 那類「commit 了 .env 卻被誤判 missing」的 case 直接解掉
- 未來任何 commit `.env` 的 Python 專案都受惠
- 順帶有 security warning 機制，operator 能立刻發現 commit 的 secrets
- 43 個 zero-dep 測試把 parser + scanner + secret detector 各條 path 鎖死

**代價：**
- 多一次 fs scan（root-level only，~5ms）
- 容忍性大但不太可能撞到 false-positive — `.env.example` 排除掉了
- Real-secret detector 是規則式（regex pattern + placeholder filter），對未來新型 token format 可能漏掉。現有 8 種 patterns 涵蓋 OpenAI / Anthropic / Google / Meta / GitHub / Slack / hex hash —— 主流 90%+

**未來可能需要做：**
- Node/JS 專案也適用（目前 R49 wire 只有 Python branch）。R56 提案可以 generalize R49+R55 到 Node
- Real-secret 偵測 push 進 review report，dashboard UI 顯示 yellow warning banner
- 自動建議 .gitignore 加 `.env`（dockerignore-fixer style，動 user files 之前要評估）

## 驗證

- `tsc --noEmit` 兩個 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **2957 passed / 0 failed across 52 files**（從 R53 的 2914/51 加 43 個 env-file-scanner 測試剛好對上）
- Test coverage：
  - parseEnvFileContent: 13 tests（comments / blanks / quoted / `export` / inline `#` / invalid ID / underscore ID / empty value / `=` in value / CRLF / non-string）
  - detectRealSecret: 16 tests（每種 token format + 全部 placeholder type + short / empty / quoted-real）
  - scanEnvFiles: 14 tests（read .env / merge multiple / skip templates / mix / canonical luca / non-existent dir / empty / oversize / no-recurse / non-string projectDir / placeholder no-flag）
- Real-world 驗收：等 R55 上線後 resubmit `luca-v2-20260504-luca-optimizer-kb`，預期 R55 從 `.env` 讀到 GEMINI_API_KEY → R49 not block → 進 deploy
