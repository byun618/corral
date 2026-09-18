import { useEffect, useRef, useState } from 'react'
import { bindingFromEvent, matchBinding, type ActionId, type Keybindings, type ShortcutMatch } from '../../../shared/keybindings.js'

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
    const dispatch = (match: ShortcutMatch): void => latest.current.handlers[match.id](match.variant)
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || latest.current.blocked || event.isComposing) return
      const binding = bindingFromEvent(event)
      const match = binding === null ? null : matchBinding(binding, latest.current.overrides)
      if (match === null) return
      // Coordinator clarification: every keyboard action yields to tab renaming, including MRU.
      if (event.target instanceof Element && event.target.closest('.main-tab-rename')) return
      event.preventDefault()
      event.stopPropagation()
      dispatch(match)
    }
    document.addEventListener('keydown', onKey, true)
    const unsubscribe = window.corral.onShortcut((match) => {
      if (latest.current.blocked || latest.current.onInterceptDuringHold()) return
      if (document.activeElement instanceof Element && document.activeElement.closest('.main-tab-rename')) return
      dispatch(match)
    })
    return () => { document.removeEventListener('keydown', onKey, true); unsubscribe() }
  }, [])
  return { overrides, setOverrides, ready }
}
