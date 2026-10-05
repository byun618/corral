import { useEffect, useRef, useState } from 'react'
import { bindingFromEvent, matchBinding, type ActionId, type Keybindings, type ShortcutMatch } from '../../../shared/keybindings.js'

export type ShortcutHandlers = Record<ActionId, (variant: number) => void>
/** 누르고 있어도 한 번만 도는 액션 (LIFE-495 K6ⓔ — ⌘⇧T 를 누르고 있으면 닫은 탭이 줄줄이 열리면 안 된다). 반복 keydown 은 삼킨다. */
const NON_REPEATING: readonly ActionId[] = ['tab.reopenClosed', 'tab.rename']
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
    const dispatch = (match: ShortcutMatch): void => latest.current.handlers[match.id](match.variant)
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
      if (event.repeat && NON_REPEATING.includes(match.id)) return
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
