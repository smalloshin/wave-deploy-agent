/**
 * Upload Error Mapper
 *
 * 把 server 回傳的 envelope（或 client 端的 Error / XHR 失敗）normalize 成 UploadFailure，
 * 對應 i18n key + recovery hint。
 *
 * 流程：
 *   1) 若是 server envelope → 直接查 registry by code
 *   2) 若是 client 錯誤（fetch/XHR/Error）→ heuristic 推斷（網路、timeout、檔案大小）
 *   3) 若 code === 'unknown'，呼叫者應 fetch /api/upload/diagnose 取得 LLM 分析
 */

import type {
  UploadErrorEnvelope,
  UploadFailure,
  UploadFailureCode,
  UploadStage,
} from '@deploy-agent/shared';

const CODE_TO_I18N: Record<UploadFailureCode, { key: string; recoveryKey?: string; retryable: boolean }> = {
  file_too_large_for_direct: {
    key: 'fileTooLargeForDirect',
    recoveryKey: 'fileTooLargeForDirect.hint',
    retryable: true,
  },
  file_extension_invalid: {
    key: 'fileExtensionInvalid',
    recoveryKey: 'fileExtensionInvalid.hint',
    retryable: false,
  },
  init_session_failed: {
    key: 'initSessionFailed',
    recoveryKey: 'initSessionFailed.hint',
    retryable: true,
  },
  gcs_auth_failed: {
    key: 'gcsAuthFailed',
    recoveryKey: 'gcsAuthFailed.hint',
    retryable: true,
  },
  gcs_timeout: {
    key: 'gcsTimeout',
    recoveryKey: 'gcsTimeout.hint',
    retryable: true,
  },
  network_error: {
    key: 'networkError',
    recoveryKey: 'networkError.hint',
    retryable: true,
  },
  submit_failed: {
    key: 'submitFailed',
    recoveryKey: 'submitFailed.hint',
    retryable: true,
  },
  extract_failed: {
    key: 'extractFailed',
    recoveryKey: 'extractFailed.hint',
    retryable: false,
  },
  extract_buffer_overflow: {
    key: 'extractBufferOverflow',
    recoveryKey: 'extractBufferOverflow.hint',
    retryable: false,
  },
  analyze_failed: {
    key: 'analyzeFailed',
    recoveryKey: 'analyzeFailed.hint',
    retryable: true,
  },
  domain_conflict: {
    key: 'domainConflict',
    recoveryKey: 'domainConflict.hint',
    retryable: false,
  },
  project_quota_exceeded: {
    key: 'projectQuotaExceeded',
    recoveryKey: 'projectQuotaExceeded.hint',
    retryable: false,
  },
  unknown: {
    key: 'unknown',
    recoveryKey: 'unknown.hint',
    retryable: true,
  },
};

/** 把 server envelope 轉成 UploadFailure */
export function mapEnvelope(envelope: UploadErrorEnvelope): UploadFailure {
  const meta = CODE_TO_I18N[envelope.code] ?? CODE_TO_I18N.unknown;
  const i18nVars = extractI18nVars(envelope);
  return {
    stage: envelope.stage,
    code: envelope.code,
    i18nKey: meta.key,
    i18nVars,
    recoveryHintKey: meta.recoveryKey,
    retryable: envelope.retryable ?? meta.retryable,
    raw: envelope,
    llm: envelope.llmDiagnostic,
  };
}

/**
 * 把 client 端錯誤（fetch reject、XHR onerror、Error）heuristic 轉成 UploadFailure
 * 用於：尚未拿到 server response 就壞掉的情況（網路斷線、CORS、timeout）
 */
export function mapClientError(
  err: unknown,
  context: { stage: UploadStage; fileSize?: number; maxSize?: number }
): UploadFailure {
  let code: UploadFailureCode = 'unknown';
  let detail: Record<string, unknown> = {};
  const message = err instanceof Error ? err.message : String(err);

  // 網路錯誤 (fetch TypeError: Failed to fetch / Network request failed)
  if (
    err instanceof TypeError &&
    (message.includes('fetch') || message.includes('Network'))
  ) {
    code = 'network_error';
  }
  // AbortError → timeout
  else if (err instanceof Error && err.name === 'AbortError') {
    code = 'gcs_timeout';
  }
  // 檔案太大（client 端先擋）
  else if (
    context.stage === 'validate' &&
    context.fileSize &&
    context.maxSize &&
    context.fileSize > context.maxSize
  ) {
    code = 'file_too_large_for_direct';
    detail = {
      fileSize: context.fileSize,
      maxSize: context.maxSize,
    };
  }
  // 副檔名錯誤
  else if (message.includes('extension') || message.includes('zip')) {
    code = 'file_extension_invalid';
  }

  const envelope: UploadErrorEnvelope = {
    ok: false,
    stage: context.stage,
    code,
    message,
    detail,
    retryable: code !== 'file_extension_invalid',
  };

  return mapEnvelope(envelope);
}

/** 從 envelope.detail 抽出 i18n 變數 */
function extractI18nVars(envelope: UploadErrorEnvelope): Record<string, string | number> | undefined {
  const detail = envelope.detail ?? {};
  const vars: Record<string, string | number> = {};

  if (typeof detail.fileSize === 'number') {
    vars.fileSize = formatBytes(detail.fileSize);
  } else if (typeof detail.fileSize === 'string') {
    vars.fileSize = detail.fileSize;
  }
  if (typeof detail.maxSize === 'number') {
    vars.maxSize = formatBytes(detail.maxSize);
  } else if (typeof detail.maxSize === 'string') {
    vars.maxSize = detail.maxSize;
  }
  if (typeof detail.ext === 'string') vars.ext = detail.ext;
  if (typeof detail.domain === 'string') vars.domain = detail.domain;

  return Object.keys(vars).length > 0 ? vars : undefined;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 嘗試 fetch /api/upload/diagnose 來補 LLM 分析（僅在 code === 'unknown' 時呼叫）*/
export async function fetchDiagnostic(
  envelope: UploadErrorEnvelope,
  apiBaseUrl: string
): Promise<UploadFailure> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/upload/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope }),
    });
    if (!res.ok) throw new Error(`diagnose failed: ${res.status}`);
    const data = (await res.json()) as { llmDiagnostic: UploadErrorEnvelope['llmDiagnostic'] };
    const enriched: UploadErrorEnvelope = { ...envelope, llmDiagnostic: data.llmDiagnostic };
    return mapEnvelope(enriched);
  } catch {
    // diagnose 自己壞了 → 回傳原始 unknown，UI 顯示通用訊息
    return mapEnvelope(envelope);
  }
}

/** 產生可貼到 issue / chat 的錯誤報告 */
export function buildErrorReport(
  failure: UploadFailure,
  ctx: { projectId: string | 'new'; fileMeta?: { name: string; size: number } }
): string {
  const lines = [
    `=== Upload Error Report ===`,
    `Time: ${new Date().toISOString()}`,
    `Project: ${ctx.projectId}`,
    `Stage: ${failure.stage}`,
    `Code: ${failure.code}`,
    `Retryable: ${failure.retryable}`,
    `Message: ${failure.raw.message}`,
  ];
  if (ctx.fileMeta) {
    lines.push(`File: ${ctx.fileMeta.name} (${formatBytes(ctx.fileMeta.size)})`);
  }
  if (failure.raw.requestId) lines.push(`Request ID: ${failure.raw.requestId}`);
  if (failure.raw.detail && Object.keys(failure.raw.detail).length > 0) {
    lines.push(`Detail: ${JSON.stringify(failure.raw.detail, null, 2)}`);
  }
  if (failure.llm) {
    lines.push(``, `--- LLM Diagnostic (${failure.llm.provider}) ---`);
    lines.push(`Category: ${failure.llm.category}`);
    lines.push(`User-facing: ${failure.llm.userFacingMessage}`);
    lines.push(`Suggested fix: ${failure.llm.suggestedFix}`);
    if (failure.llm.rootCause) lines.push(`Root cause: ${failure.llm.rootCause}`);
  }
  lines.push(``, `User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`);
  return lines.join('\n');
}
