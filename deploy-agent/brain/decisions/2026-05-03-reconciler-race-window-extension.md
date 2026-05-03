# 2026-05-03 — Reconciler race window extension（R51）

## Status

Active

## Context

R47 上線後 `wavenet-ai-gateway-frontend` resubmit 部署，pipeline 跑完 review 進入 deploying（15:50:16），但 reconciler 在 15:57:44（age=448s ≈ 7m28s）就標記 failed，說 "deployment has no cloudRunUrl AND no cloudRunService — cannot recover"。

實際上 Cloud Run revision `da-wavenet-ai-gateway-frontend-00002-qt8` 在 15:59:24 才被建立（age ≈ 9m），整條 deploy 跑了 ~9 分鐘才結束（Next.js + npm install + image build + push + Cloud Run create + IAM + tag + capture）。Reconciler 在第 7 分鐘就誤判「卡死」、提早 mark failed。

**Root cause**：R47 把 race window 設 6 分鐘。當時的計算：
- deploy-worker retry 1.3s
- captureDeployedSource 1-2 分鐘

但忽略了 **Cloud Build 本身在 deploy-worker 內部跑**（Step 3 build → push image），對大型 Next.js 專案動輒 7+ 分鐘。整條 deploy 路徑：

```
0:00  approved → deploying  (deploy-worker 進入)
0:00  Step 1: extract source
0:30  Step 2: pre-build env gate (R49)
0:35  Step 3: Cloud Build (image build + push)  ← 5-7 分鐘
6:35  Step 4: Cloud Run create (revision instantiate)  ← 1-2 分鐘
8:00  Step 5: post-deploy (IAM, tag, capture, write cloudRunUrl)
9:00  完成
```

Reconciler 在第 7 分鐘看 deployment 紀錄，cloudRunUrl 跟 cloudRunService 都還沒寫進去（deploy-worker 還在 Step 3 等 Cloud Build），race window 已過 → mark failed。

## Decision

`RECONCILER_RACE_WINDOW_MS` 從 `6 * 60 * 1000` 改為 `15 * 60 * 1000`。

15 分鐘的算法：
- Cloud Build 大型專案：上限 10-12 分鐘（observed: Next.js 7 min；Python 3-5 min；luca-web 自己的 Dockerfile 1.5 min）
- Cloud Run revision instantiate：1-2 分鐘
- Post-deploy（IAM, tag, capture, DB write）：~1 分鐘
- 總和：~15 分鐘 worst case

15 分鐘 race window **不會錯過真的卡死**：
- 真卡死 = deploy-worker 例外、Cloud Build 失敗但 deploy-worker 沒接到事件、Cloud Run 永遠沒 materialize
- 這些 case 的「user impact = 0」（沒服務啟動），多等 9 分鐘換取 false-positive 為 0 是 ROI 巨大的 trade

## Consequences

**好處：**
- `wavenet-ai-gateway-frontend` 那類「Next.js 大型 build」不再被誤判
- 任何將來的大型專案部署都受益

**代價：**
- 真卡死的 deploy 多等 9 分鐘才被 reconciler 介入。對 user 的影響：0（Cloud Run 沒服務在跑，zero traffic impact）
- 對 operator 的影響：dashboard 上專案在 deploying 狀態多停留 9 分鐘。Acceptable

**未來可能需要做：**
- 動態 race window：根據專案大小 / 偵測到的 Cloud Build 是否 active 動態調整。但 6→15 已經涵蓋 99% case，動態複雜度不值得
- 從 Cloud Build API 直接查 active build 狀態：如果該專案有 active Cloud Build → skip。比 race window 更精準但要多一次 API call per tick

## 驗證

- `tsc --noEmit` 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → 2888 passed / 0 failed across 50 files（test count 不變，只調整常數跟 fixture）
- 兩個 race window 測試已 update：default fixture 10 min → 20 min；「inside 6 min」測試改成「inside 15 min」
- Real-world 驗收：等 R51 上線後 resubmit `wavenet-ai-gateway-frontend`，預期 9 分鐘部署完成，reconciler 不再誤判
