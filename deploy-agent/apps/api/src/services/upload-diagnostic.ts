/**
 * Upload Diagnostic Service
 *
 * 當 client 收到 code === 'unknown' 的 envelope 時，會 POST 到 /api/upload/diagnose，
 * 這裡用 LLM (Claude → GPT-5.4 fallback) 分析錯誤，給用戶看的訊息 + 建議修法。
 *
 * 重用 llm-analyzer.ts 的 callLLM 來保持 provider 切換邏輯一致。
 */

import { callLLM } from './llm-analyzer';
import type { UploadErrorEnvelope, UploadLLMDiagnostic } from '@deploy-agent/shared';

const SYSTEM_PROMPT = `You are a senior platform engineer for "wave-deploy-agent", a one-person GCP deployment agent.
The user just hit an UPLOAD failure they don't understand. Your job: explain in friendly bilingual format and tell them what to do next.

Rules:
1. Output STRICT JSON (no markdown fences, no commentary outside JSON).
2. JSON shape:
   {
     "category": "user" | "platform" | "unknown",
     "userFacingMessage": "繁體中文 (Traditional Chinese) message; concise; no jargon; under 80 chars",
     "suggestedFix": "繁體中文 actionable next step; under 120 chars",
     "rootCause": "English technical root cause for ops; under 200 chars"
   }
3. Use category="user" if the user can fix it (bad zip, network, file too large).
4. Use category="platform" if it's a server bug, GCP outage, missing config (admin should fix).
5. Use category="unknown" only if you genuinely cannot tell.
6. Be specific. "請重試" alone is useless. Tell them WHY and the concrete step.
7. Never invent error codes that aren't in the envelope.`;

export async function analyzeUploadFailure(envelope: UploadErrorEnvelope): Promise<UploadLLMDiagnostic> {
  const userMessage = JSON.stringify(
    {
      stage: envelope.stage,
      code: envelope.code,
      message: envelope.message,
      detail: envelope.detail ?? {},
      requestId: envelope.requestId,
    },
    null,
    2
  );

  // Defensive timeout: LLM 不該卡住整個請求
  const timeoutMs = 12_000;
  const llmPromise = callLLM(SYSTEM_PROMPT, userMessage, 600);
  const timeoutPromise = new Promise<{ text: string; provider: 'claude' | 'gpt' }>((_, reject) =>
    setTimeout(() => reject(new Error('LLM diagnostic timeout')), timeoutMs)
  );

  try {
    const { text, provider } = await Promise.race([llmPromise, timeoutPromise]);
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as Partial<UploadLLMDiagnostic>;

    return {
      category: parsed.category === 'user' || parsed.category === 'platform' ? parsed.category : 'unknown',
      userFacingMessage:
        typeof parsed.userFacingMessage === 'string' && parsed.userFacingMessage.length > 0
          ? parsed.userFacingMessage
          : '上傳失敗，原因未知',
      suggestedFix:
        typeof parsed.suggestedFix === 'string' && parsed.suggestedFix.length > 0
          ? parsed.suggestedFix
          : '請重試或聯絡管理員',
      rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : undefined,
      provider: provider === 'gpt' ? 'gpt-5' : 'claude',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[upload-diagnostic] LLM 分析失敗：${msg}`);
    return ruleBasedFallback(envelope);
  }
}

/** LLM 都壞了 → 用簡單規則猜一下，至少給用戶一個訊息 */
function ruleBasedFallback(envelope: UploadErrorEnvelope): UploadLLMDiagnostic {
  const stageHints: Record<string, { msg: string; fix: string; cat: 'user' | 'platform' }> = {
    validate: {
      msg: '檔案驗證失敗',
      fix: '請確認檔案是 .zip 且大小未超過上限',
      cat: 'user',
    },
    init: {
      msg: '無法取得上傳憑證',
      fix: '通常是 session 過期或 GCP 配額用完。請重新整理頁面後重試',
      cat: 'platform',
    },
    upload: {
      msg: '上傳檔案到 GCS 時失敗',
      fix: '請檢查網路連線後重試。大檔案建議用穩定的 Wi-Fi',
      cat: 'user',
    },
    submit: {
      msg: '送出處理時失敗',
      fix: '檔案已上傳但處理失敗，請點重試',
      cat: 'platform',
    },
    extract: {
      msg: '解壓縮失敗',
      fix: '請確認 zip 可正常本地解壓，避免奇怪的目錄結構',
      cat: 'user',
    },
    analyze: {
      msg: '專案分析失敗',
      fix: 'AI 服務暫不可用，請稍後重試',
      cat: 'platform',
    },
    deploy: {
      msg: '觸發部署時失敗',
      fix: '請聯絡管理員',
      cat: 'platform',
    },
  };
  const hint = stageHints[envelope.stage] ?? { msg: '上傳失敗', fix: '請重試', cat: 'unknown' as const };
  return {
    category: hint.cat as 'user' | 'platform' | 'unknown',
    userFacingMessage: hint.msg,
    suggestedFix: hint.fix,
    rootCause: `Fallback at stage=${envelope.stage}, code=${envelope.code}`,
    provider: 'rule_based',
  };
}
