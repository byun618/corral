// 종료 확인 관문 (LIFE-591 E3ⓒ) — 수정된 파일 탭이 있으면 앱 종료(⌘Q·메뉴·Dock)·창 닫기를 **런타임 정리(`stopRuntime`)보다 먼저** 막고 렌더러에 확인을 맡긴다.
//
// 렌더러가 수정 파일 목록을 바뀔 때마다 민다(`setDirty`) — main 은 그 목록으로 **동기** 판정한다(`before-quit`·창 `close` 의 `preventDefault` 는 동기여야 한다).
// 막으면 `requestConfirm`(렌더러에 「확인해 달라」)만 보내고 아무것도 정리하지 않는다 — 사용자가 취소하면 앱·런타임·터미널은 그대로다.
// 렌더러가 저장/저장 안 함으로 끝내면 `allow()` 뒤 다시 `app.quit()` — 그때부터는 막지 않는다(`before-quit` → 기존 정리 순서 그대로).
import type { DirtyFile } from '../shared/file-view.js'

export type QuitGate = {
  setDirty: (files: DirtyFile[]) => void
  dirty: () => DirtyFile[]
  /** 종료·창 닫기 입구가 부른다 — true 면 막았다(부른 쪽이 `preventDefault`). 막을 때마다 확인을 요청한다(중복은 렌더러가 거른다). */
  intercept: (via: string) => boolean
  /** 렌더러가 확인을 마쳤다 — 이후 종료를 막지 않는다. */
  allow: () => void
  allowed: () => boolean
}

export function createQuitGate(input: { requestConfirm: () => boolean; log?: (tag: string, data: Record<string, unknown>) => void }): QuitGate {
  let files: DirtyFile[] = []
  let allowed = false
  return {
    setDirty: (next) => {
      files = next
    },
    dirty: () => files,
    intercept: (via) => {
      if (allowed || files.length === 0) return false
      // 확인을 받을 렌더러가 없으면 막지 않는다(막으면 종료할 길이 없어진다) — 그때 렌더러 쪽 내용도 이미 없다.
      const asked = input.requestConfirm()
      input.log?.('quit.intercepted', { via, files: files.length, asked })
      return asked
    },
    allow: () => {
      allowed = true
    },
    allowed: () => allowed,
  }
}

/** 렌더러가 민 목록의 형 검사 — 모르는 모양은 버린다(빈 목록이 아니라 null — 부른 쪽이 기존 값을 지킨다). */
export function parseDirtyFiles(input: unknown): DirtyFile[] | null {
  if (!Array.isArray(input)) return null
  const files: DirtyFile[] = []
  for (const item of input) {
    if (typeof item !== 'object' || item === null) return null
    const root = 'root' in item ? item.root : undefined
    const rel = 'rel' in item ? item.rel : undefined
    if (typeof root !== 'string' || typeof rel !== 'string') return null
    files.push({ root, rel })
  }
  return files
}
