'use client';

/**
 * UploadErrorBlock — 上傳錯誤的統一 UI
 *
 * 渲染：
 *   - 階段 + 錯誤碼 (chip)
 *   - 主訊息（i18n 或 LLM userFacingMessage）
 *   - 修復建議
 *   - 操作：重試 / 取消 / 複製錯誤報告
 *
 * Design tokens 全部用 DS 4.0：--danger / --danger-bg, --warn-bg, --info-bg, --r-md, --fs-sm
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { UploadFailure } from '@deploy-agent/shared';
import { buildErrorReport } from '@/lib/upload-error-mapper';

export interface UploadErrorBlockProps {
  failure: UploadFailure;
  /** 上傳上下文（用於錯誤報告）*/
  context: {
    projectId: string | 'new';
    fileMeta?: { name: string; size: number };
  };
  /** 是否正在 fetch LLM 分析（顯示 spinner）*/
  diagnosing?: boolean;
  onRetry?: () => void;
  onCancel?: () => void;
}

export function UploadErrorBlock({ failure, context, diagnosing, onRetry, onCancel }: UploadErrorBlockProps) {
  const t = useTranslations('projectDetail.uploadErrors');
  const [copied, setCopied] = useState(false);

  const stageLabel = (() => {
    try {
      return t(`stageLabels.${failure.stage}`);
    } catch {
      return failure.stage;
    }
  })();

  // 主訊息：優先使用 i18n key，若 LLM 有 userFacingMessage 則覆蓋
  const mainMessage = (() => {
    if (failure.llm?.userFacingMessage) return failure.llm.userFacingMessage;
    try {
      return t(`${failure.i18nKey}.message`, failure.i18nVars ?? {});
    } catch {
      return failure.raw.message || t('unknown.message');
    }
  })();

  const hint = (() => {
    if (failure.llm?.suggestedFix) return failure.llm.suggestedFix;
    try {
      return t(`${failure.i18nKey}.hint`, failure.i18nVars ?? {});
    } catch {
      return undefined;
    }
  })();

  const categoryLabel = failure.llm
    ? t(`llmCategory.${failure.llm.category}`)
    : null;

  async function handleCopyReport() {
    const report = buildErrorReport(failure, context);
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback：opening prompt
      window.prompt('複製這段錯誤報告：', report);
    }
  }

  return (
    <div
      role="alert"
      style={{
        marginTop: '12px',
        padding: '14px 16px',
        background: 'var(--danger-bg)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--r-md)',
        color: '#1a1a1a',
        fontSize: 'var(--fs-sm)',
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <strong style={{ color: 'var(--danger)', fontSize: 'var(--fs-md)' }}>
          {t('title')}
        </strong>
        <span
          style={{
            padding: '2px 8px',
            background: '#fff',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--r-pill)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--danger)',
          }}
        >
          {t('stage')}: {stageLabel}
        </span>
        <span
          style={{
            padding: '2px 8px',
            background: '#fff',
            border: '1px solid #999',
            borderRadius: 'var(--r-pill)',
            fontSize: 'var(--fs-xs)',
            color: '#444',
            fontFamily: 'monospace',
          }}
        >
          {failure.code}
        </span>
        {categoryLabel && (
          <span
            style={{
              padding: '2px 8px',
              background: failure.llm?.category === 'platform' ? 'var(--warn-bg)' : 'var(--info-bg)',
              border: `1px solid ${failure.llm?.category === 'platform' ? 'var(--warn)' : 'var(--info)'}`,
              borderRadius: 'var(--r-pill)',
              fontSize: 'var(--fs-xs)',
              color: failure.llm?.category === 'platform' ? 'var(--warn)' : 'var(--info)',
            }}
          >
            {categoryLabel}
          </span>
        )}
      </div>

      <div style={{ marginBottom: '8px', fontWeight: 500 }}>{mainMessage}</div>

      {hint && (
        <div style={{ marginBottom: '12px', color: '#444', fontSize: 'var(--fs-sm)' }}>
          → {hint}
        </div>
      )}

      {diagnosing && (
        <div
          style={{
            marginBottom: '12px',
            padding: '8px 12px',
            background: 'var(--info-bg)',
            borderRadius: 'var(--r-sm)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--info)',
          }}
        >
          {t('llmAnalyzing')}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {failure.retryable && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              padding: '6px 14px',
              background: 'var(--danger)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--r-sm)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            {t('actions.retry')}
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '6px 14px',
              background: '#fff',
              color: '#444',
              border: '1px solid #ccc',
              borderRadius: 'var(--r-sm)',
              fontSize: 'var(--fs-sm)',
              cursor: 'pointer',
            }}
          >
            {t('actions.cancel')}
          </button>
        )}
        <button
          type="button"
          onClick={handleCopyReport}
          style={{
            padding: '6px 14px',
            background: '#fff',
            color: '#444',
            border: '1px solid #ccc',
            borderRadius: 'var(--r-sm)',
            fontSize: 'var(--fs-sm)',
            cursor: 'pointer',
          }}
        >
          {copied ? t('actions.copied') : t('actions.copyReport')}
        </button>
      </div>
    </div>
  );
}
