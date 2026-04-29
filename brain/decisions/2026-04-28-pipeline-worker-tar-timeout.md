# 2026-04-28 — pipeline-worker.ts sync tar timeout 30s/60s → 600s

## Status

Active

## Context

R44b 把 `apps/api/src/routes/projects.ts` 的 `execFileAsync('tar', ...)` 兩處 timeout 從 60s 拉到 600s，修了 ZIP→tarball 跨太平洋上傳對台灣使用者的失敗。

但 R44b 只 sweep 了 routes 那層的 async sites，**漏掉 `apps/api/src/services/pipeline-worker.ts` 的兩個同步 `execFileSync` site**：

```typescript
// pipeline-worker.ts:110 — extract GCS source bundle 進 projectDir
execFileSync('tar', ['xzf', tgzPath, '-C', projectDir], { timeout: 30_000 });

// pipeline-worker.ts:291 — pack mutated projectDir 重新塞回 GCS（fixed-source upload）
execFileSync('tar', ['-czf', tarballPath, '-C', projectDir, '.'], { timeout: 60_000 });
```

實例：legal-flow 426 MB upload 過了 R44b 的 first-leg upload，過了 R44d 的 detector，到 fixed-source upload step 時 projectDir AI 修改後 ~300+ MB → `tar -czf` 60s 跑不完 → `spawnSync tar ETIMEDOUT` → project status 變 `failed`，errorCode `fixed_source_upload_failed`。

Cloud Run log 證據：
```
[CRITICAL errorCode=fixed_source_upload_failed]
Fixed-source upload for "legal-flow" FAILED: tar-failed: spawnSync tar ETIMEDOUT
```

## Decision

兩個 sync site 都改：

```typescript
// Round 44e — pipeline-worker.ts:110
execFileSync('tar', ['xzf', tgzPath, '-C', projectDir], {
  timeout: 600_000,
  maxBuffer: 100 * 1024 * 1024,
});

// Round 44e — pipeline-worker.ts:291
try {
  execFileSync('tar', ['-czf', tarballPath, '-C', projectDir, '.'], {
    timeout: 600_000,
    maxBuffer: 100 * 1024 * 1024,
  });
} catch (tarErr) {
  throw new Error(`tar-failed: ${(tarErr as Error).message}`);
}
```

參數對齊 R44b 的 routes/projects.ts async sites：10 分鐘 timeout、100 MB stdout/stderr buffer。

## Consequences

### 好處

- **R44b 鏈路全部閉環**：API ingress + worker 內部 tar 操作 timeout 一致
- **不再因 projectDir 體積大而失敗**：~600 MB projectDir 在 Cloud Run 標準 NIC 約 30-60s 完成 tar，10 分鐘 budget 留充足 head room
- **錯誤訊息有結構**：tar-failed 會被外層 catch 包成 `errorCode=fixed_source_upload_failed`，audit log 看得到

### 代價

- **單個 worker tick 最壞 case 變長**：原本 60s timeout 失敗就 fail-fast，現在最壞要等 10 分鐘
  - Cloud Run instance 在這段時間佔記憶體不釋放
  - 可接受：失敗本來就少，timeout-on-success 比 timeout-on-still-running 危險低
- **沒有 streaming**：`execFileSync` 整段塞 maxBuffer，超過 100MB stderr 會炸
  - 實務 tar 的 stderr 只有 warning，不會接近 100MB
  - 真要超過代表 tarball 本身有大問題，fail-fast 也合理
- **沒處理 tar quota exceed**：磁碟空間爆了還是會 fail，只是 error message 不一樣

## 相關決策

- 上游：R44b（routes/projects.ts execFileAsync timeout）
- 同期：R44d（archive-normalizer，反斜線 zip 路徑）
- 後續可能：R44c-stream（submit-gcs streaming download/upload，避免 memory 跟檔案大小同比）

## 教訓 — 跨檔案 sweep 漏網

R44b 的 commit 訊息寫「修 tar timeout」但只改 routes layer。pipeline-worker 是 worker layer 跑同樣的 tar 操作但用 sync API，grep `execFileAsync` 抓不到。

**下次 sweep 規則**：用 `grep -r 'tar.*timeout' apps/api/src/` 而不是 grep API 名稱，能同時抓到 sync + async。

## Round saga 完整時間軸

```
R44   2026-04-27  GCS download → tar bundle → upload to Cloud Build 全鏈路出錯
R44b  2026-04-28  routes/projects.ts execFileAsync timeout 60s → 600s（async sites）
R44c  2026-04-28  submit-gcs validation + structured error codes
R44d  2026-04-28  archive-normalizer.ts（Windows backslash zip）
R44e  2026-04-28  pipeline-worker.ts execFileSync timeout 30s/60s → 600s（this ADR，sync sites）
```
