/**
 * Upload Failure Registry — typed discriminated union
 *
 * 設計原則：
 * - 每個錯誤碼對應一個 i18n key + 一個可恢復動作 (recovery hint)
 * - Server 回傳統一的 envelope: { stage, code, detail, message }
 * - Client 用 mapUploadError(envelope) 把它轉成 UploadFailure 並渲染
 * - 若 code 不在 registry 裡 (kind: 'unknown')，client 會 fetch /api/upload/diagnose 取得 LLM 分析
 */

/** 上傳流程的階段 */
export type UploadStage =
  | 'validate'      // 前端檔案驗證（大小、副檔名）
  | 'init'          // POST /api/upload/init 取得 GCS resumable session
  | 'upload'        // PUT 到 GCS resumable URL
  | 'submit'        // POST /api/projects/submit-gcs 觸發伺服器處理
  | 'extract'       // 伺服器解壓縮 zip
  | 'analyze'       // LLM/規則分析專案
  | 'deploy';       // 觸發部署 worker

/** 已知失敗類型（discriminated union by `code`）*/
export type UploadFailureCode =
  | 'file_too_large_for_direct'      // 用戶想用舊 /api/projects 但檔案 > 30MB
  | 'file_extension_invalid'          // 不是 .zip
  | 'init_session_failed'             // /api/upload/init 失敗
  | 'gcs_auth_failed'                 // GCS 401/403
  | 'gcs_timeout'                     // GCS PUT timeout
  | 'network_error'                   // fetch / XHR 中斷
  | 'submit_failed'                   // /api/projects/submit-gcs 失敗
  | 'extract_failed'                  // 解壓縮失敗（壞 zip / 太大 / path traversal）
  | 'extract_buffer_overflow'         // unzip stdout > maxBuffer
  | 'analyze_failed'                  // LLM 分析失敗（含 fallback 也失敗）
  | 'domain_conflict'                 // domain 已被其他專案占用
  | 'project_quota_exceeded'          // 已達專案數上限
  | 'unknown';                        // 註冊表未涵蓋（觸發 LLM fallback）

/** Server 回傳的結構化錯誤 envelope */
export interface UploadErrorEnvelope {
  ok: false;
  stage: UploadStage;
  code: UploadFailureCode;
  message: string;                  // 給人看的（伺服器端的初步訊息，client 可選擇覆蓋）
  detail?: Record<string, unknown>; // 機器可讀的細節（fileSize, maxAllowed, gcsStatus...）
  requestId?: string;               // 方便除錯
  retryable?: boolean;              // server 提示這個錯能不能 retry
  /** 若 code === 'unknown'，client 應呼叫 /api/upload/diagnose 取得 LLM 分析 */
  llmDiagnostic?: UploadLLMDiagnostic;
}

/** LLM 分析結果（給 client 直接渲染）*/
export interface UploadLLMDiagnostic {
  category: 'user' | 'platform' | 'unknown';
  userFacingMessage: string;        // 給用戶看的繁中訊息
  suggestedFix: string;             // 給用戶可執行的下一步
  rootCause?: string;               // 技術原因
  provider: 'claude' | 'gpt-5' | 'rule_based';
}

/** Client 端 normalize 後的失敗物件（給 UI 渲染用）*/
export interface UploadFailure {
  stage: UploadStage;
  code: UploadFailureCode;
  /** i18n key — uploadErrors.{i18nKey} */
  i18nKey: string;
  /** i18n 內插用的變數（例如 fileSize, maxSize）*/
  i18nVars?: Record<string, string | number>;
  /** 可恢復動作提示（i18n key）*/
  recoveryHintKey?: string;
  /** 是否可 retry（顯示「重試」按鈕）*/
  retryable: boolean;
  /** 用於 clipboard 報告的原始 envelope */
  raw: UploadErrorEnvelope;
  /** 若是 unknown，這裡會有 LLM 分析結果 */
  llm?: UploadLLMDiagnostic;
}

/** LocalStorage 草稿 schema — 跨重整保留表單 */
export interface UploadDraft {
  v: 1;                             // schema version
  projectId: string | 'new';
  formData: {
    name?: string;
    domain?: string;
    description?: string;
    githubUrl?: string;
    [key: string]: string | undefined;
  };
  /** Base64 縮圖（< 100KB），用於提示「你之前選了 myapp.zip」*/
  fileMeta?: {
    name: string;
    size: number;
    lastModified: number;
  };
  savedAt: string;                  // ISO timestamp
  /** 7 天後自動清除 */
  expiresAt: string;
}

/** Clipboard 錯誤報告格式 */
export interface UploadErrorReport {
  timestamp: string;
  branch?: string;
  projectId: string | 'new';
  envelope: UploadErrorEnvelope;
  userAgent: string;
  fileMeta?: { name: string; size: number };
}
