import { useEffect, useRef, useState } from 'react'
import { bindingFromEvent, EDITOR_YIELD_ACTIONS, matchBinding, NON_REPEATING_ACTIONS, yieldsOutsideMarkdown, type ActionId, type Keybindings, type ShortcutMatch } from '../../../shared/keybindings.js'
import { EDITOR_KEYS } from '../markdown.js'

export type ShortcutHandlers = Record<ActionId, (variant: number) => void>
/** LIFE-629 — 키가 Markdown 보기(`FileView` 의 `data-markdown-view`) 안에서 났는가. */
const inMarkdownView = (target: EventTarget | null): boolean => target instanceof Element && target.closest('[data-markdown-view]') !== null
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
          const match = binding === null ? null : matchBinding(binding, latest.current.overrides)
          // LIFE-629 — 대화상자 입력칸의 ⇧⌘V(서식 없이 붙여넣기 등)는 삼키지 않는다.
          if (match !== null && !yieldsOutsideMarkdown({ id: match.id, inMarkdownView: inMarkdownView(event.target) })) { event.preventDefault(); event.stopPropagation() }
        }
        return
      }
      const binding = bindingFromEvent(event)
      // LIFE-602 수정 1 R1-F: 편집 칸(본문 편집기·코멘트 입력)이 쓰는 조합은 그 칸에 양보한다 — 칸 밖에서는 그대로 전역 동작.
      if (binding !== null && EDITOR_KEYS.includes(binding) && event.target instanceof Element && event.target.closest('[data-editor-keys]')) return
      // LIFE-592 — 탐색기 트리 자체가 키를 받았으면 탐색기 범위 액션(⌘⌫·⌘Z·⌘⇧Z)을 먼저 본다. 트리 안 입력 행(새 이름·이름 변경)은 트리가 아니라 입력이다.
      const scope = event.target instanceof Element && event.target.matches('[data-explorer-tree]') ? 'explorer' : 'global'
      const match = binding === null ? null : matchBinding(binding, latest.current.overrides, scope)
      if (match === null) return
      // Coordinator clarification: every keyboard action yields to tab renaming, including MRU.
      // LIFE-478: 카드 인라인 rename 입력(`data-inline-rename`)에도 양보한다(K3ⓐ).
      if (event.target instanceof Element && event.target.closest('.main-tab-rename, [data-inline-rename]')) return
      // LIFE-591 — 파일 탭 편집기 안이면 터미널 pane 대상 단축키(파일 탭에서 무동작)를 편집기에 넘긴다(⌘⇧Z 다시 실행 등 — `EDITOR_YIELD_ACTIONS`).
      if (EDITOR_YIELD_ACTIONS.includes(match.id) && event.target instanceof Element && event.target.closest('[data-file-editor]')) return
      // LIFE-629 — ⇧⌘V 는 Markdown 보기 안에서만 가져간다(터미널·다른 파일 탭·입력칸이면 그 자리의 키로 그대로 간다).
      if (yieldsOutsideMarkdown({ id: match.id, inMarkdownView: inMarkdownView(event.target) })) return
      event.preventDefault()
      event.stopPropagation()
      // 누르고 있어도 한 번만 도는 액션(LIFE-495 K6ⓔ) — 반복 keydown 은 삼킨다. main 메뉴 키 길(`menuKeyShortcut`)과 같은 목록(fix1 R1-06).
      if (event.repeat && NON_REPEATING_ACTIONS.includes(match.id)) return
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
