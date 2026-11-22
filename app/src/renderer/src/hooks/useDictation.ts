// LIFE-834 음성 받아쓰기 — 컨트롤러(`dictation-controller.ts`)를 창에 붙인다: main 이벤트 구독, Esc 취소(캡처 단계 — pane 으로 가지 않는다), 단축키 토글.
import { useEffect, useRef, useState } from 'react'
import { createDictationController, focusedTerminalPane, IDLE_DICTATION, type DictationController, type DictationNotice, type DictationView } from '../dictation-controller.js'

let sessionCounter = 0

export function useDictation(input: { paneExists: (paneId: string) => boolean; notify: (notice: DictationNotice) => void }): { view: DictationView; toggle: () => void } {
  const [view, setView] = useState<DictationView>(IDLE_DICTATION)
  const latest = useRef(input)
  latest.current = input
  const controllerRef = useRef<DictationController | null>(null)

  useEffect(() => {
    const controller = createDictationController({
      start: (request) => window.corral.dictationStart(request),
      stop: (request) => window.corral.dictationStop(request),
      cancel: (request) => window.corral.dictationCancel(request),
      termInput: (request) => window.corral.termInput(request),
      paneExists: (paneId) => latest.current.paneExists(paneId),
      notify: (notice) => latest.current.notify(notice),
      onChange: setView,
      now: () => Date.now(),
      newSessionId: () => `dictation-${Date.now()}-${++sessionCounter}`,
    })
    controllerRef.current = controller
    const off = window.corral.onDictationEvent((event) => controller.onEvent(event))
    // Esc — 받아쓰는 중일 때만 삼킨다. 캡처 단계라 xterm 입력칸·다른 처리기보다 먼저 받는다.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      if (!controller.cancel()) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      off()
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  return { view, toggle: () => controllerRef.current?.toggle(focusedTerminalPane(document.activeElement)) }
}
