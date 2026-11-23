// LIFE-834 음성 받아쓰기 — 컨트롤러(`dictation-controller.ts`)를 창에 붙인다: main 이벤트 구독, Esc 취소(캡처 단계 — pane 으로 가지 않는다), 단축키 누름·뗌.
// 누름은 단축키 길(`useKeybindings` → `press`)로 온다. 뗌·키 반복·창 포커스 잃음은 여기서 창 캡처 단계로 듣는다(fix4 F-1) — 단축키는 렌더러가 삼키므로(main 이 아니다)
// Chromium 의 keyUp 억제가 걸리지 않고, 창 캡처는 xterm·대화상자·입력칸 어디가 포커스든, IME 조합 중이든 먼저 받는다.
import { useEffect, useRef, useState } from 'react'
import { clearTerminalSelection } from '../terminal-selection.js'
import { createDictationController, dictationRelease, focusedTerminalPane, IDLE_DICTATION, type DictationController, type DictationNotice, type DictationPressKeys, type DictationView } from '../dictation-controller.js'

let sessionCounter = 0

export function useDictation(input: { paneExists: (paneId: string) => boolean; notify: (notice: DictationNotice) => void }): { view: DictationView; press: () => void } {
  const [view, setView] = useState<DictationView>(IDLE_DICTATION)
  const latest = useRef(input)
  latest.current = input
  const controllerRef = useRef<DictationController | null>(null)
  /** 창 캡처 단계가 본 마지막 keydown(반복 아님) — 단축키 길의 `press` 가 같은 이벤트 안에서 읽어 이 누름의 키로 삼는다. */
  const lastKeyDown = useRef<DictationPressKeys | null>(null)
  const pressKeys = useRef<DictationPressKeys | null>(null)
  /** 누름이 끝난(뗌) 뒤 아직 눌려 있을 수 있는 그 글쇠의 code — 그 글쇠의 keyup 이나 새 누름이 올 때까지 반복 keydown 을 삼킨다(r4 C-R4-2). */
  const swallowRepeats = useRef<string | null>(null)

  useEffect(() => {
    const controller = createDictationController({
      start: (request) => window.corral.dictationStart(request),
      stop: (request) => window.corral.dictationStop(request),
      cancel: (request) => window.corral.dictationCancel(request),
      insert: (request) => window.corral.dictationInsert(request),
      clearSelection: (paneId) => clearTerminalSelection(paneId),
      paneExists: (paneId) => latest.current.paneExists(paneId),
      notify: (notice) => latest.current.notify(notice),
      onChange: setView,
      now: () => Date.now(),
      schedule: (ms, run) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      },
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
    // 누름 기록·키 반복 — 단축키 길보다 먼저(창 캡처) 돈다. 삼키지 않는다.
    // 뗌 뒤의 반복은 여기서 삼킨다(문서 캡처의 단축키 길·xterm·메뉴로 가지 않게) — ⌘ 를 먼저 떼면 남은 M 반복이 「M」 으로, ⇧ 를 먼저 떼면 ⌘M 으로 새던 것(C-R4-2).
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.repeat) {
        swallowRepeats.current = null
        lastKeyDown.current = { code: event.code, meta: event.metaKey, shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey }
        return
      }
      if (event.code === swallowRepeats.current) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (controller.holding && event.code === pressKeys.current?.code) controller.repeat()
    }
    /** 홀드를 끝낸다 — 글쇠가 아직 눌려 있을 수 있으니(수식 키를 먼저 뗐다·blur) 그 글쇠의 반복을 삼키기 시작한다. */
    const release = (timed: boolean): void => {
      if (!controller.holding) return
      swallowRepeats.current = pressKeys.current?.code ?? null
      controller.release(timed)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === swallowRepeats.current) swallowRepeats.current = null
      const press = pressKeys.current
      if (press === null || !controller.holding) return
      const released = dictationRelease({ press, keyup: event })
      if (!released.matches) return
      release(released.timed)
      // 글쇠 자체를 뗐으면 더 올 반복이 없다
      if (event.code === press.code) swallowRepeats.current = null
    }
    const onLost = (): void => release(false)
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') release(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onLost)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onLost)
      document.removeEventListener('visibilitychange', onVisibility)
      off()
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  return {
    view,
    press: () => {
      pressKeys.current = lastKeyDown.current
      controllerRef.current?.press(focusedTerminalPane(document.activeElement))
    },
  }
}
