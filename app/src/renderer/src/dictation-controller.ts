// LIFE-834 음성 받아쓰기 — 렌더러 상태 규칙 한 곳 (01-criteria 「대상·상태 표」, coding.md 「적용 시점에 목적지가 아직 현재인가」).
//
// · 대상 pane 은 **시작 순간 키보드 포커스가 있던 터미널 pane** 으로 고정한다. 그 뒤 포커스 이동은 대상을 바꾸지 않는다 — 이 모듈은 포커스를 읽기만 하고
//   세우지도 지우지도 않는다. 시작 순간 포커스가 터미널이 아니면 시작하지 않고 알린다.
// · FINAL 만 넣는다(partial 은 표시만). 넣기는 ⌘V 와 같은 길 — `clipboardTextPayloads`(강제 bracketed paste) + `createOrderedSender`(도착 순서)
//   → `termInput`. Enter·CR 을 덧붙이지 않는다.
// · 적용 시점 확인은 FINAL 이 도착할 때 한 번: 대상이 아직 있으면 넣고, 없으면 넣지 않고 세션을 취소한 뒤 알린다(다른 pane 으로 보내지 않는다).
// · 지금 세션이 아닌 이벤트(취소·끝난 세션의 늦은 줄)는 버린다 — Esc 뒤 늦게 온 FINAL 이 들어가지 않는다.
import {
  DICTATION_NOT_TERMINAL_MESSAGE,
  DICTATION_SILENCE_NOTICE_MS,
  DICTATION_SILENCE_RMS,
  DICTATION_TARGET_CLOSED_MESSAGE,
  dictationErrorMessage,
  type DictationEvent,
  type DictationStartResult,
} from '../../shared/dictation.js'
import { clipboardTextPayloads, createOrderedSender } from '../../shared/terminal-paste.js'

export type DictationView =
  | { phase: 'idle' }
  /** 도우미를 띄웠고 `ready` 를 기다린다(권한 창이 떠 있을 수 있다). */
  | { phase: 'starting'; paneId: string }
  | { phase: 'listening'; paneId: string; partial: string; silent: boolean }
  /** 정지를 눌렀고 마지막 FINAL 을 기다린다. */
  | { phase: 'stopping'; paneId: string; partial: string; silent: boolean }

export const IDLE_DICTATION: DictationView = { phase: 'idle' }

export type DictationNotice = { message: string; openPrivacy: boolean }

export type DictationControllerDeps = {
  start: (input: { sessionId: string }) => Promise<DictationStartResult>
  stop: (input: { sessionId: string }) => void
  cancel: (input: { sessionId: string }) => void
  termInput: (input: { paneId: string; data: string }) => void
  /** 적용 시점에 대상 pane 이 아직 있나. */
  paneExists: (paneId: string) => boolean
  notify: (notice: DictationNotice) => void
  onChange: (view: DictationView) => void
  now: () => number
  newSessionId: () => string
}

/** 키보드 포커스가 있는 터미널 pane 의 id — xterm 입력칸은 `[data-term-pane]` 안에 있다. 터미널이 아니면 null. */
export function focusedTerminalPane(active: Element | null): string | null {
  const host = active?.closest('[data-term-pane]') ?? null
  const paneId = host?.getAttribute('data-term-pane') ?? null
  return paneId === null || paneId === '' ? null : paneId
}

type Active = { sessionId: string; paneId: string; silentSince: number | null }

export function createDictationController(deps: DictationControllerDeps) {
  let view: DictationView = IDLE_DICTATION
  let active: Active | null = null
  const enqueue = createOrderedSender<{ paneId: string; data: string }>((item) => deps.termInput(item))

  const set = (next: DictationView): void => {
    view = next
    deps.onChange(view)
  }
  const end = (): void => {
    active = null
    set(IDLE_DICTATION)
  }
  const cancelActive = (): void => {
    if (active === null) return
    deps.cancel({ sessionId: active.sessionId })
    end()
  }

  const begin = (paneId: string): void => {
    const session: Active = { sessionId: deps.newSessionId(), paneId, silentSince: null }
    active = session
    set({ phase: 'starting', paneId })
    void deps.start({ sessionId: session.sessionId }).then(
      (result) => {
        if (result.ok || active !== session) return
        end()
        deps.notify({ message: dictationErrorMessage(result), openPrivacy: false })
      },
      (error: unknown) => {
        if (active !== session) return
        end()
        deps.notify({ message: dictationErrorMessage({ code: 'spawn-failed', message: error instanceof Error ? error.message : String(error) }), openPrivacy: false })
      },
    )
  }

  return {
    get view(): DictationView {
      return view
    },
    /** 단축키. `focusedPaneId` = 누른 순간 키보드 포커스가 있던 터미널 pane(없으면 null). */
    toggle(focusedPaneId: string | null): void {
      switch (view.phase) {
        case 'idle':
          if (focusedPaneId === null) {
            deps.notify({ message: DICTATION_NOT_TERMINAL_MESSAGE, openPrivacy: false })
            return
          }
          begin(focusedPaneId)
          return
        // 아직 듣기 전이면 확정할 글이 없다 — 취소와 같다.
        case 'starting':
          cancelActive()
          return
        case 'listening':
          if (active === null) return
          deps.stop({ sessionId: active.sessionId })
          set({ ...view, phase: 'stopping' })
          return
        case 'stopping':
          return
      }
    },
    /** Esc — 받아쓰는 중이면 취소하고 참(키를 삼킨다). 아니면 거짓(키는 원래 자리로). */
    cancel(): boolean {
      if (active === null) return false
      cancelActive()
      return true
    },
    onEvent(event: DictationEvent): void {
      const session = active
      if (session === null || event.sessionId !== session.sessionId) return
      switch (event.kind) {
        case 'ready':
          if (view.phase === 'starting') set({ phase: 'listening', paneId: session.paneId, partial: '', silent: false })
          return
        case 'partial':
          if (view.phase === 'listening' || view.phase === 'stopping') set({ ...view, partial: event.text })
          return
        case 'final': {
          if (!deps.paneExists(session.paneId)) {
            cancelActive()
            deps.notify({ message: DICTATION_TARGET_CLOSED_MESSAGE, openPrivacy: false })
            return
          }
          if (event.text !== '') void enqueue(clipboardTextPayloads(event.text).map((data) => ({ paneId: session.paneId, data })))
          if (view.phase === 'listening' || view.phase === 'stopping') set({ ...view, partial: '' })
          return
        }
        case 'level': {
          if (view.phase !== 'listening' && view.phase !== 'stopping') return
          if (event.rms > DICTATION_SILENCE_RMS) {
            session.silentSince = null
            if (view.silent) set({ ...view, silent: false })
            return
          }
          const now = deps.now()
          session.silentSince ??= now
          if (!view.silent && now - session.silentSince >= DICTATION_SILENCE_NOTICE_MS) set({ ...view, silent: true })
          return
        }
        case 'ended':
          end()
          if (event.end.kind === 'error') deps.notify({ message: dictationErrorMessage(event.end), openPrivacy: event.end.code === 'mic-denied' })
          return
      }
    },
    /** 화면이 내려갈 때 — 진행 중이면 취소한다. */
    dispose(): void {
      cancelActive()
    },
  }
}

export type DictationController = ReturnType<typeof createDictationController>
