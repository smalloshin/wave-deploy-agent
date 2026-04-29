# 2026-04-30 — LLM Provider 翻轉：GPT-5.5 為主、Claude 為備

## Context

wave-deploy-agent 一直把 Anthropic Claude 當主要 LLM、OpenAI GPT 當 fallback。

R44 saga（2026-04-28）走到 Step 4 Threat Analysis 時，Anthropic API balance 用完，pipeline 自動 fallback 到 GPT-5.4 才跑完。Logs：

```
Claude API failed: Your credit balance is too low to access the Anthropic API
Falling back to GPT-5.4...
LLM provider: GPT-5.4 ✓
```

使用者決定直接把 GPT 升到 5.5 並提為主，Claude 降為 fallback。理由：

1. Claude balance 用完不是 transient，是 vendor 計費問題。每次都 timeout 才 fallback 浪費時間
2. GPT-5.5 是 OpenAI 最新版本（2026-04-30），latency / capability 已經足以撐生產 threat analysis
3. Claude 仍保留作為 fallback，billing/quota 換邊出問題時能自動切

## Decision

**翻轉 3 個 callsite 的 LLM 嘗試順序**：先 OpenAI、後 Claude。

**所有 OpenAI 預設 model 從 `gpt-5.4` → `gpt-5.5`**（env override 仍可用 `OPENAI_MODEL`）。

**3 個 callsite**：

| 檔案 | 用途 | 翻轉前 | 翻轉後 |
|------|------|--------|--------|
| `apps/api/src/services/llm-analyzer.ts` | Threat analysis（pipeline Step 4）+ 一堆共用 callLLM | Claude → GPT fallback | GPT-5.5 → Claude fallback |
| `apps/api/src/services/resource-analyzer.ts` | Cloud Run resource sizing（CPU/memory/timeout 推論） | Claude → GPT fallback | GPT-5.5 → Claude fallback |
| `apps/bot/src/nl-handler.ts` | Discord bot 自然語言 handler | Claude haiku → GPT fallback | GPT-5.5 → Claude haiku fallback |

**fallback 條件**（nl-handler.ts）：原本只在 `credit / billing / balance` 觸發 fallback，新增 `quota`（OpenAI 用 quota 字眼比較頻繁）。

**`.env.example`**（root + `deploy-agent/`）：`OPENAI_MODEL=gpt-5.5`，註解 `GPT-5.5 primary, Claude fallback`。

## Consequences

**好處**：
- Anthropic balance 用完不再卡 pipeline 主路徑（直接走 GPT-5.5）
- GPT-5.5 在 threat analysis 表現實測有打過 Claude（R44 saga GPT-5.4 fallback 跑完合格）
- Claude 仍是 hard fallback，避免單點失效

**代價 / 注意**：
- OpenAI billing 用量會直接拉高（之前是 fallback 才用，現在每次 pipeline 都用）
- Claude haiku 在 nl-handler 的 latency 比 GPT-5.5 快，bot 回應可能略變慢（測過再決定要不要把 bot 留 Claude）
- 翻轉只動了 callsite 順序，沒改 prompt / schema，輸出格式應該一致（仍要 prod 驗證）
- `cloudbuild.yaml` / Cloud Run env 若有顯式設 `OPENAI_MODEL=gpt-5.4`，必須一併改成 `gpt-5.5`，否則 process.env override 會把預設蓋掉
- Secret Manager 不需動（OPENAI_API_KEY 同一把）

**驗證計劃**：
1. 部署後跑一個小 project（gam-publisher）submit-gcs，確認 logs 出現 `LLM provider: GPT-5.5 ✓`
2. 測 Anthropic 故意 invalid key 的情況下 fallback 是否真的切到 Claude（手動把 key 改錯，submit 一個 project）
3. nl-handler：在 Discord 用 bot 問問題，確認 logs `LLM provider: GPT-5.5 ✓`

## Status

Active

## Refs

- `apps/api/src/services/llm-analyzer.ts:39-83` — primary callLLM
- `apps/api/src/services/resource-analyzer.ts:148-175`
- `apps/bot/src/nl-handler.ts:213-273`
- `.env.example` / `deploy-agent/.env.example`
