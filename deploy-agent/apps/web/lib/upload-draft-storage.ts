/**
 * Upload Draft LocalStorage helpers
 *
 * 把表單欄位 + 檔案 metadata 暫存到 localStorage，
 * 上傳失敗時用戶不會丟掉 5 分鐘填的資料。
 *
 * Schema: `wda:upload:draft:{projectId|"new"}` → UploadDraft (JSON)
 * 過期：7 天後自動清除
 */

import type { UploadDraft } from '@deploy-agent/shared';

const KEY_PREFIX = 'wda:upload:draft:';
const EXPIRY_DAYS = 7;
const MAX_DRAFT_SIZE = 50 * 1024; // 50KB safety cap

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function key(projectId: string | 'new'): string {
  return `${KEY_PREFIX}${projectId}`;
}

/** 儲存草稿（debounce 由 caller 處理）*/
export function saveDraft(
  projectId: string | 'new',
  formData: UploadDraft['formData'],
  fileMeta?: UploadDraft['fileMeta']
): void {
  if (!isBrowser()) return;
  try {
    const now = new Date();
    const expires = new Date(now.getTime() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const draft: UploadDraft = {
      v: 1,
      projectId,
      formData,
      fileMeta,
      savedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
    const serialized = JSON.stringify(draft);
    if (serialized.length > MAX_DRAFT_SIZE) {
      // form 太大就只存欄位、丟掉 fileMeta
      const minimal: UploadDraft = { ...draft, fileMeta: undefined };
      window.localStorage.setItem(key(projectId), JSON.stringify(minimal));
      return;
    }
    window.localStorage.setItem(key(projectId), serialized);
  } catch {
    // localStorage 滿了 / private mode → 安靜失敗
  }
}

/** 載入草稿（過期會自動清除並回傳 null）*/
export function loadDraft(projectId: string | 'new'): UploadDraft | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(key(projectId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as UploadDraft;
    if (draft.v !== 1) {
      window.localStorage.removeItem(key(projectId));
      return null;
    }
    const expiresAt = new Date(draft.expiresAt).getTime();
    if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
      window.localStorage.removeItem(key(projectId));
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/** 清除草稿（上傳成功時呼叫）*/
export function clearDraft(projectId: string | 'new'): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key(projectId));
  } catch {
    /* ignore */
  }
}

/** 清除所有過期 draft（啟動時可呼叫一次）*/
export function gcExpiredDrafts(): void {
  if (!isBrowser()) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      try {
        const draft = JSON.parse(raw) as UploadDraft;
        const expiresAt = new Date(draft.expiresAt).getTime();
        if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
          window.localStorage.removeItem(k);
        }
      } catch {
        // 壞資料直接清掉
        window.localStorage.removeItem(k);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Debounced save 工具（用於 onChange 連續觸發）*/
export function makeDebouncedSave(delayMs = 500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (
    projectId: string | 'new',
    formData: UploadDraft['formData'],
    fileMeta?: UploadDraft['fileMeta']
  ) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveDraft(projectId, formData, fileMeta), delayMs);
  };
}
