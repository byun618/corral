// 메뉴는 한 번에 하나 (LIFE-478 K2ⓓ) — 198 `orca-close-all-context-menus` 대응.
//
// 메뉴가 열릴 때 자기 id 를 알리고, 열려 있는 다른 메뉴는 그 알림에 닫힌다. 카드 우클릭 메뉴·카드 ⋯·레포 ⋯·옵션 메뉴·탭 메뉴·
// ? 메뉴가 같은 버스를 쓴다. hover 카드도 이 알림에 닫힌다(메뉴가 열리는 순간 위층이 생긴다).
import { useEffect, useId, useRef } from 'react'

const EVENT = 'corral:menu-open'

export function announceMenuOpen(owner: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: owner }))
}

/** 다른 메뉴가 열리면 `listener` — 해제 함수를 돌려준다. `owner` 가 null 이면 모든 알림을 받는다(hover 카드). */
export function onMenuOpen(owner: string | null, listener: () => void): () => void {
  const handler = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail !== owner) listener()
  }
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

/** 메뉴 하나 — 열릴 때 알리고, 열려 있는 동안 다른 메뉴가 열리면 `close`. */
export function useMenuBus(input: { open: boolean; close: () => void }): void {
  const owner = useId()
  const closeRef = useRef(input.close)
  closeRef.current = input.close
  useEffect(() => {
    if (!input.open) return
    announceMenuOpen(owner)
    return onMenuOpen(owner, () => closeRef.current())
  }, [input.open, owner])
}

/** 카드 대화·피커가 떴다 — 열린 메뉴·hover 카드가 닫힌다(LIFE-478 r2 R2B-02 · K2ⓔ 「대화」 도 위층). 대화는 다른 메뉴 알림에 닫히지 않는다. */
export function useAnnounceDialog(): void {
  const owner = useId()
  useEffect(() => announceMenuOpen(owner), [owner])
}

/**
 * 대화·피커의 Esc (LIFE-478 r2 R2B-01·07) — 포커스가 어디 있든(터미널·body) window 캡처로 받는다. 메뉴(`ContextMenu`·`RepoRowMenu`)와 같은 방식.
 * IME 조합 중 Esc 는 글자 조합 취소라 무시한다. 받은 Esc 는 전파를 끊어 터미널·단축키로 새지 않는다.
 */
export function useWindowEscape(input: { onEscape: () => void }): void {
  const onEscapeRef = useRef(input.onEscape)
  onEscapeRef.current = input.onEscape
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      onEscapeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
