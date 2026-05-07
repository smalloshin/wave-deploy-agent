// Reconciler recovery decider — pure function (R47).
//
// 為什麼存在這個檔：
//   reconciler.ts 偵測到 deployment 沒寫 cloudRunUrl 時，舊邏輯一律 mark failed。
//   實際上 deploy-worker 那個寫入是單次 DB write，網路抖一下就會掉，但 Cloud Run
//   服務其實已經活著（單一 incident: wavenet-ai-gateway-frontend / revision
//   da-...-00001-2x7 被誤判 failed）。
//
//   修法：拿 Cloud Run 真相回來校對；若服務 ready + 條件成功 + 跑的 revision 跟
//   DB 記的 revision 對得上 → 把 cloudRunUrl 補寫回 DB（recovery）。其他狀況走
//   原本 mark failed 路徑，行為不變。
//
// 為什麼是 pure function：
//   recovery 邏輯有 8 條分支（race / both empty / known service / ready+match /
//   ready+failed condition / zombie / missing service / ambiguous）。把 Cloud
//   Run REST 跟 DB IO 拆出去之後，這個檔只是 "input → verdict"，可以用 12 個
//   zero-dep 測試把每條分支鎖死。reconciler.ts 的 IO 程式碼只負責「組 input、
//   dispatch verdict」。

/**
 * Cloud Run 服務真相 input shape（與 deploy-engine 的 CloudRunServiceTruth 對齊
 * 但這邊 redeclare 是為了讓這個檔不依賴 deploy-engine — 純函式檔不應該 import
 * 任何會碰 GCP REST / fs / pg 的模組）。
 */
export interface ReconcilerCloudRunTruth {
  exists: boolean;
  ready: boolean;
  uri: string | null;
  liveRevision: string | null;
  conditionState:
    | 'CONDITION_SUCCEEDED'
    | 'CONDITION_FAILED'
    | 'CONDITION_RECONCILING'
    | 'UNKNOWN';
}

/**
 * deployment input shape — 只取 decider 需要的欄位（避免依賴整個 Deployment
 * type，這個檔保持 zero-dep）。
 */
export interface ReconcilerDeploymentInput {
  id: string;
  cloudRunUrl: string | null;
  cloudRunService: string | null;
  revisionName: string | null;
  /** ISO string 或 Date — 內部 toMs 處理兩種 */
  createdAt: string | Date;
}

export type ReconcilerVerdict =
  | { kind: 'mark-failed'; reason: string }
  | { kind: 'recover-cloudrun-url'; uri: string }
  | { kind: 'fast-forward' }
  | { kind: 'skip'; reason: string };

// 25 分鐘 race 窗（R57.1 升級，原 R51 的 15 分鐘）：
//
// R51 把 6 分鐘升到 15 分鐘，因為 Next.js + 大 npm install Cloud Build 7+ 分鐘，
// 加 Cloud Run revision swap / IAM / tag / capture 整條 9 分鐘，15 分鐘給空間。
//
// R57 加了 Step 3.5 pre-deploy migration（Prisma + Alembic via Cloud Run Jobs），
// migration job 本身有 cold start ~30-90s + 實際跑 schema migration 可能 1-3 min。
// 整條 deploy 從 9 min 漲到 12-15 min，剛好踩在 R51 race window 邊緣，臨界值會出
// false-positive。
//
// R57.1 升 15 → 25 min：
//   - 大型 Next.js + Prisma migration + 大 schema = 12-15 min 主流
//   - 真卡死的 deploy（沒 Cloud Run service materialize）多等 10 分鐘介入，
//     反正 Cloud Run 沒啟動 = 沒 user impact，false-positive=0 換 10 min wait
//   - reconciler tick 是 2 min 一次，所以 25 min race window = 12-13 個 tick
//     會跳過該 deployment，沒額外負擔
export const RECONCILER_RACE_WINDOW_MS = 25 * 60 * 1000;

function toMs(t: string | Date): number {
  if (t instanceof Date) return t.getTime();
  return new Date(t).getTime();
}

/**
 * Pure decider. 給 deployment 紀錄、Cloud Run 真相、現在時間 → verdict。
 *
 * 分支順序（設計 invariant，不要重排）：
 *   1. race window 保護（最高優先；防止跟 deploy-worker 搶寫）
 *   2. 已經有 cloudRunUrl → fast-forward（reconciler 後續流程接手）
 *   3. cloudRunUrl 空 + cloudRunService 空 → mark-failed（無從 recover）
 *   4. cloudRunUrl 空 + cloudRunService 有 + Cloud Run 服務不存在 → mark-failed
 *   5. cloudRunUrl 空 + 服務存在但 conditionState=FAILED → mark-failed
 *   6. cloudRunUrl 空 + 服務 ready + revision 對不上（zombie / publish split）→ mark-failed
 *   7. cloudRunUrl 空 + 服務 ready + revision 一致 + 條件 succeeded + uri 有 → recover
 *   8. 其他模糊狀況（reconciling / 缺 uri / liveRevision 是 null 但有 deployment.revisionName 等）
 *      → skip（下輪再試）
 */
export function decideReconcilerAction(
  deployment: ReconcilerDeploymentInput,
  cloudRunTruth: ReconcilerCloudRunTruth,
  nowMs: number,
): ReconcilerVerdict {
  const ageMs = nowMs - toMs(deployment.createdAt);

  // (1) race window — 即使 cloudRunUrl 空，也先讓 deploy-worker 跑完
  if (ageMs < RECONCILER_RACE_WINDOW_MS) {
    return {
      kind: 'skip',
      reason: `deployment too young (age=${Math.round(ageMs / 1000)}s < ${RECONCILER_RACE_WINDOW_MS / 1000}s); let deploy-worker finish writing`,
    };
  }

  // (2) cloudRunUrl 已經有 → 走原 fast-forward 路徑
  if (deployment.cloudRunUrl) {
    return { kind: 'fast-forward' };
  }

  // (3) 兩個都空 → 從 DB 端就無從 recover（沒有 service name 可查 Cloud Run）
  if (!deployment.cloudRunService) {
    return {
      kind: 'mark-failed',
      reason: 'reconciler: deployment has no cloudRunUrl AND no cloudRunService — cannot recover',
    };
  }

  // 從這裡開始：cloudRunUrl 空 + cloudRunService 有，要查 Cloud Run truth

  // (4) Cloud Run 端確定服務不存在 → mark failed
  if (!cloudRunTruth.exists) {
    return {
      kind: 'mark-failed',
      reason: `reconciler: Cloud Run service ${deployment.cloudRunService} does not exist (or unreachable on this tick)`,
    };
  }

  // (5) 服務存在但條件 FAILED → mark failed
  if (cloudRunTruth.conditionState === 'CONDITION_FAILED') {
    return {
      kind: 'mark-failed',
      reason: `reconciler: Cloud Run service ${deployment.cloudRunService} terminalCondition=CONDITION_FAILED`,
    };
  }

  // (6) ready 但 liveRevision 跟 DB 對不上 → zombie / split，交給其他 handler
  if (cloudRunTruth.ready && deployment.revisionName !== null) {
    if (
      cloudRunTruth.liveRevision !== null &&
      cloudRunTruth.liveRevision !== deployment.revisionName
    ) {
      return {
        kind: 'mark-failed',
        reason: `reconciler: revision mismatch (db=${deployment.revisionName} vs live=${cloudRunTruth.liveRevision}) — likely zombie or publish-split, refusing to back-fill`,
      };
    }
  }

  // (7) recovery 條件全到位
  if (
    cloudRunTruth.ready &&
    cloudRunTruth.conditionState === 'CONDITION_SUCCEEDED' &&
    cloudRunTruth.uri !== null &&
    cloudRunTruth.uri.length > 0 &&
    deployment.revisionName !== null &&
    cloudRunTruth.liveRevision === deployment.revisionName
  ) {
    return { kind: 'recover-cloudrun-url', uri: cloudRunTruth.uri };
  }

  // (8) 其他狀況：reconciling 中、ready 但 uri 是 null、ready 但 liveRevision 是
  // null、deployment.revisionName 是 null（剛建還沒寫到 revision）等。下輪再試。
  return {
    kind: 'skip',
    reason: `reconciler: ambiguous Cloud Run state (ready=${cloudRunTruth.ready} condition=${cloudRunTruth.conditionState} uri=${cloudRunTruth.uri ? 'set' : 'null'} liveRevision=${cloudRunTruth.liveRevision ?? 'null'} dbRevision=${deployment.revisionName ?? 'null'})`,
  };
}
