import { useEffect, useRef, useState } from 'react'
import { bindingFromEvent, matchBinding, type ActionId, type Keybindings, type ShortcutMatch } from '../../../shared/keybindings.js'
import { announceMenuOpen } from '../menu-bus.js'

/** 전역 단축키를 실행하는 순간 열린 메뉴를 닫는다 — menu-bus 에 이 이름으로 알린다(LIFE-496 fix1 R1-01). */
const SHORTCUT_MENU_OWNER = 'corral:shortcut'

export type ShortcutHandlers = Record<ActionId, (variant: number) => void>
export function useKeybindings(handlers: ShortcutHandlers, blocked: boolean, onInterceptDuringHold: () => boolean) {
  const [overrides, setOverrides] = useState<Keybindings>({})
  const [ready, setReady] = useState(false)
  const latest = useRef({ handlers, overrides, blocked, onInterceptDuringHold })
  latest.current = { handlers, overrides, blocked, onInterceptDuringHold }
  useEffect(() => {
    let active = true
    void window.corral.getKeybindings().then((value) => { if (active) setOverrides(value) }).catch(() => { /* IPC unavailable: keep catalog defaults. */ }).finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    // 단축키가 실행되면 열린 메뉴(`+` 드롭다운·우클릭 메뉴 등)를 먼저 닫는다. 단축키는 document 캡처라 메뉴의 키 처리보다 먼저 돌고,
    // 그 결과 포커스가 옮겨 가도 창이 시스템 포커스를 잃은 동안에는 focusin 이 오지 않는다(fix1 격리 실측) — 포커스 이벤트에 기대지 않는다.
    const dispatch = (match: ShortcutMatch): void => {
      announceMenuOpen(SHORTCUT_MENU_OWNER)
      latest.current.handlers[match.id](match.variant)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (latest.current.blocked) {
        // Yield to the modal's own editing/navigation keys. No background dispatch.
        if (event.metaKey || event.ctrlKey || event.altKey) {
          const binding = bindingFromEvent(event)
          if (binding && matchBinding(binding, latest.current.overrides)) { event.preventDefault(); event.stopPropagation() }
        }
        return
      }
      const binding = bindingFromEvent(event)
      const match = binding === null ? null : matchBinding(binding, latest.current.overrides)
      if (match === null) return
      // Coordinator clarification: every keyboard action yields to tab renaming, including MRU.
      // LIFE-478: 카드 인라인 rename 입력(`data-inline-rename`)에도 양보한다(K3ⓐ).
      if (event.target instanceof Element && event.target.closest('.main-tab-rename, [data-inline-rename]')) return
      event.preventDefault()
      event.stopPropagation()
      dispatch(match)
    }
    document.addEventListener('keydown', onKey, true)
    const unsubscribe = window.corral.onShortcut((match) => {
      if (latest.current.blocked || latest.current.onInterceptDuringHold()) return
      if (document.activeElement instanceof Element && document.activeElement.closest('.main-tab-rename, [data-inline-rename]')) return
      dispatch(match)
    })
    return () => { document.removeEventListener('keydown', onKey, true); unsubscribe() }
  }, [])
  return { overrides, setOverrides, ready }
}
