# 2026-04-27 — Chunked GCS Resumable Upload Defaults

## Status

**Active**（commit `7741a35`，pending production deploy authorization）

Supersedes the round-27 emergency fix (commit `19af9c1`) which introduced chunked
upload but with too-aggressive defaults that still failed in real residential
connections.

## Context

Round 27 修了 426 MB Firefox `network_error`：把單一 `fetch(...)` PUT 改成 `XMLHttpRequest`
chunked resumable upload（8 MiB chunks，5 retries，30s backoff cap）。

部署上 production，user 真檔（447194585 bytes legal_flow_build.zip）**仍然失敗**。
curl 重現確認：

- User residential connection → asia-east1 GCS 走 Cloudflare，**effective ~313 KB/s**
- 8 MiB chunk = **每塊 ~26 秒** 才 PUT 完
- chunk 18（~150 MB / 33%）TCP-level timeout `curl: (55) Recv failure: Operation timed out`
- 5 retries × 30s backoff cap = **2.5 min retry budget per chunk**——對 Cloudflare 偶發中斷不夠

問題不在程式邏輯（round 27 的 chunked + 308 + status query recovery 都對），是
**default 值對 user 真實連線太樂觀**。

## Decision

四項 default 全部改：

| Knob | Round 27 | Round 30 | Why |
|------|----------|----------|-----|
| `DEFAULT_CHUNK_SIZE` | 8 MiB | **1 MiB** | GCS 推薦保守值；4 × 256 KiB 對齊；對 313 KB/s 連線 = ~3.3s/chunk，遠低於常見 idle timeout |
| `DEFAULT_MAX_RETRIES` | 5 | **15** | 在 60s cap 下，最壞 case = 15 × 60s = 15 min retry budget per chunk |
| `MAX_BACKOFF_MS` | 30s | **60s** | 跟 Google `@google-cloud/storage` SDK 對齊；給 GCS edge 真的炸的時候喘息空間 |
| `DEFAULT_CHUNK_TIMEOUT_MS` | (none) | **120s** | XHR 沒 default timeout，會掛在 TCP RST 才放手；明確 2-min upper bound 進 `xhr.timeout` |

附帶 API：`ResumableUploadOpts` 新增 `chunkTimeoutMs?: number`，內部 `putChunkXhr` opts 收 `timeoutMs`，
3 條 call site 全打通（zero-byte path / chunk PUT / status query）。

## Consequences

**Pros**
- 對慢/不穩連線（vibe-coded user 的家用 Wi-Fi）能完成，不再卡在 ~33%
- 1 MiB chunk 對 fast connection 也只是多幾次 round-trip（GCS 有 HTTP keep-alive），無顯著 throughput penalty
- XHR `xhr.timeout` 把 timeout 路徑分流到 `kind: 'gcs_timeout'`，跟一般 network error 區隔，error envelope 更精準
- Backoff cap 60s 跟 SDK 對齊，未來換 SDK 行為一致

**Cons**
- 1 MiB chunk = 比 8 MiB 多 8x 的 HTTP round-trips（GCS resumable 每塊一個 PUT），fast connection 會多 latency overhead，但 throughput 通常不變（HTTP/2 multiplexing + persistent connection）
- 15 retries × 60s = 最壞 15 min/chunk，整個 426 MB 檔最壞要花 ~106 hr——但這只是最壞 case，正常情況 retry budget 多半用不到
- XHR timeout 跟 AbortController 兩條 cancel path 並存（user 主動 cancel 走 abort，timeout 走 xhr.timeout），programmer 要記得區分

**Why not 256 KiB chunks?**
GCS resumable 最小單位是 256 KiB，理論上可以更小。但 256 KiB chunk = 4x 多 round-trips（vs 1 MiB），
對快連線 throughput penalty 開始有感。1 MiB 是甜蜜點。

**Why not dynamic chunk size?**
動態算（量測 throughput → 調 chunk size）邏輯複雜易錯，加上 first chunk 沒法量測前還是要 default 值。
保持 default static + per-call override（`chunkSizeBytes` opt 已存在）的設計。

**Why not retry indefinitely?**
15 retries × 60s cap 等於最壞 15 min/chunk。再多 user 早就關 tab 了。15 是「願意等的最大值」。

## Verification Plan

1. ✅ 91/91 unit tests pass（resumable-upload zero-dep test runner）
2. ✅ Cumulative sweep 1742/1742 pass across 30 zero-dep test files
3. ⏳ Real-file curl simulation: `tools/round30_chunk_upload.sh` against actual 447 MB file with 1 MiB chunks（in progress, ~17.6% done at write time, no errors so far）
4. ⏸️ Production deploy: blocked by sandbox in autonomous overnight mode；要 user 醒來明確授權 `gcloud builds submit`
5. ⏸️ Production smoke test: user 上傳 legal_flow_build.zip 從 dashboard，verify 完整 commit + scan + review flow

## References

- Commit: `7741a35` — fix(web): tighten chunked upload defaults
- Failed-fix: `19af9c1` (round 27) + `ac4d58b` — chunked upload introduced but defaults too loose
- Round 27 cloudbuild deploy: `118f5814`
- File: `apps/web/lib/resumable-upload.ts`（52 LOC delta）
- Tests: `apps/web/lib/test-resumable-upload.ts`（143 LOC delta, 91 PASS）
- GCS docs: <https://cloud.google.com/storage/docs/performing-resumable-uploads>
- @google-cloud/storage SDK reference for backoff cap: 60s standard
