# 2026-05-07 — Shared archive-extractor helper（R62）

## Status

Active

## Context

`submit-gcs` 跟 `new-version` 兩個 endpoint 都要 download user-supplied archive 然後 extract，但格式支援不一致：

| Route | `.zip` | `.tar.gz` | `.tgz` | `.tar` |
|-------|--------|-----------|--------|--------|
| `submit-gcs` | ✅ | ✅ | ✅ | ✅ |
| `new-version` (pre-R62) | ❌ | ✅ | ❌ | ❌ |

User wavenetdeveloper-rfp-agent v2 resubmit 撞到：上傳 `.zip` 給 new-version，`tar xzf` 不認，回 500 `gzip: stdin has more than one entry`。

## Decision

抽 shared helper `services/archive-extractor.ts`：

```typescript
export type ArchiveFormat = 'zip' | 'tar.gz' | 'tar';
export type ExtractResult =
  | { ok: true; format: ArchiveFormat }
  | { ok: false; code: 'unsupported_format'; extension: string }
  | { ok: false; code: 'extract_failed'; format: ArchiveFormat; error: string }
  | { ok: false; code: 'extract_buffer_overflow'; format: ArchiveFormat; error: string };

export function detectArchiveFormat(fileName: string): ArchiveFormat | null;
export async function extractArchive(
  archivePath: string,
  extractDir: string,
  fileName: string,
): Promise<ExtractResult>;
```

- `detectArchiveFormat` 是 pure 函式 — 看 fileName 末尾，case-insensitive
- `extractArchive` 對應呼叫 `unzip -q -o` / `tar -xzf` / `tar -xf`
- Discriminated result — caller 可 map 到自己的 error code（`submit-gcs` 用 `UploadFailureCode`，`new-version` 用簡單 string error）
- Never throws — extraction subprocess error 進 `error` 字串

兩個 routes 都改成呼叫 helper：
- `routes/projects.ts:587` 把 inline if/else 換成 `extractArchive(...)`
- `routes/versioning.ts:208` 把 `tar xzf` 換成 `extractArchive(...)`

### Common constants

`ARCHIVE_TIMEOUT_MS = 600_000` (10 min) 跟 `ARCHIVE_MAX_BUFFER = 100 MB` 從 `routes/projects.ts` 搬到 helper export，`projects.ts` 重新 import 它們（保留同樣的 timeout 行為）。

## Consequences

**好處**：
- `new-version` 現在認 `.zip` / `.tar.gz` / `.tgz` / `.tar` 跟 submit-gcs 同步
- DRY — 未來加新 archive format 只改一個地方
- 14 zero-dep tests 鎖死 wire contract（含 round-trip extract、case-insensitive、corrupt archive、missing file 不 throw）

**代價**：
- 新增 1 個 service file (~150 LOC) + 1 個 test file (~250 LOC)
- 兩個 routes 各 ~30 LOC inline → ~10 LOC import + call

**已知未解 risk**：
- 沒處理 `.7z`、`.rar`、`.tar.xz` 等更 exotic format。Vibe-coder 99% 用 zip / tar.gz，這些之後撞到再加

## 驗證

- `tsc --noEmit` 兩 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **3085 passed / 0 failed across 58 files**（3071 → +14 R62 tests +1 新檔 test-archive-extractor.ts）
- 14 個新測試：
  - `detectArchiveFormat`：5 case（zip / tar.gz / tgz / tar / unknown / case-insensitive）
  - `extractArchive`：tar.gz round-trip、tgz alias、zip round-trip（**user case canonical**）、plain tar、unsupported_format、case-insensitive dispatch、corrupt tar.gz、missing file

- E2E：rfp-agent v2 resubmit 走 new-version path 確認 zip 能解（剛剛跑過）

## 後續

- 等 R62 platform deploy 完，rfp-agent 已經 in-flight 不影響（用了 .tar.gz）
- TODOS.md 不用加 entry（這算 R57+R60 跟進 cleanup）
