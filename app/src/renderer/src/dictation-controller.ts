// LIFE-834 음성 받아쓰기 — 렌더러 상태 규칙 한 곳 (01-criteria 「대상·상태 표」, coding.md 「적용 시점에 목적지가 아직 현재인가」).
//
// · 대상 pane 은 **시작 순간 키보드 포커스가 있던 터미널 pane** 으로 고정한다. 그 뒤 포커스 이동은 대상을 바꾸지 않는다 — 이 모듈은 포커스를 읽기만 하고
//   세우지도 지우지도 않는다. 시작 순간 포커스가 터미널이 아니면 시작하지 않고 알린다.
// · FINAL 만 넣는다(partial 은 표시만). 넣기 직전에 대상 xterm 의 선택을 풀고(⌘V 와 같은 단계, fix1 G2) main `insert` 로 보낸다 — main 이 도착 순서대로
//   붙은 탭이면 ⌘V 길(`clipboardTextPayloads` 강제 bracketed paste → `stream.input`), 아니면 guard `pane.send_text`(제어 문자 뺀 글)로 넣는다(fix1 G1 — `main/dictation.ts`).
//   Enter·CR 을 덧붙이지 않는다.
// · 적용 시점 확인은 FINAL 이 도착할 때 한 번: 대상이 아직 있으면 넣고, 없으면 넣지 않고 세션을 취소한 뒤 알린다(다른 pane 으로 보내지 않는다).
//   넣기가 실패로 돌아오면(보낼 길 없음) 조용히 버리지 않는다 — 그 세션이 아직 진행 중이면 멈추고, 언제든 알린다.
// · 지금 세션이 아닌 이벤트(취소·끝난 세션의 늦은 줄)는 버린다 — Esc 뒤 늦게 온 FINAL 이 들어가지 않는다.
// · 켜고 끄기는 orca Auto 방식(fix4 F-1 — 01-criteria 「최종 관문 보강」): 누름(idle) = 시작. 누른 시간 ≥ 300 ms(키 반복 포함)면 홀드 — 뗄 때 정지.
//   더 짧은 탭이면 켜진 채 두고 다음 누름에 정지. 탭 세션은 마지막 말소리 뒤 60초가 지나면 스스로 정지하고 알린다. 홀드 중 창 포커스를 잃으면 뗌으로 본다.
//   뗌 시각을 모르면(⌘ 를 누른 채면 macOS 가 글쇠의 keyup 을 버린다 — 수식 키 keyup·blur 로 알게 된다) 마지막 키 반복 시각으로 잰다.
//   듣기 전(starting)의 홀드 뗌은 정지 예약 — `ready` 가 오면 stop(r4 G-R4-1).
import {
  DICTATION_AUTO_STOP_SILENCE_MS,
  DICTATION_AUTO_STOPPED_MESSAGE,
  DICTATION_HOLD_THRESHOLD_MS,
  DICTATION_NOT_TERMINAL_MESSAGE,
  DICTATION_SILENCE_NOTICE_MS,
  DICTATION_SILENCE_RMS,
  DICTATION_SPEECH_RMS,
  DICTATION_TARGET_CLOSED_MESSAGE,
  dictationErrorMessage,
  type DictationEvent,
  type DictationInsertResult,
  type DictationPressKeys,
  type DictationStartResult,
} from '../../shared/dictation.js'

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
  /** FINAL 한 번을 대상 pane 에 — main 이 도착 순서대로 넣고 결과를 돌려준다. */
  insert: (input: { sessionId: string; paneId: string; text: string }) => Promise<DictationInsertResult>
  /** 대상 xterm 의 선택을 푼다(화면에 없으면 아무것도 안 한다). */
  clearSelection: (paneId: string) => void
  /** 적용 시점에 대상 pane 이 아직 있나. */
  paneExists: (paneId: string) => boolean
  notify: (notice: DictationNotice) => void
  onChange: (view: DictationView) => void
  now: () => number
  /** `ms` 뒤 `run` 을 한 번 — 취소 함수를 돌려준다(60초 자동 정지). */
  schedule: (ms: number, run: () => void) => () => void
  newSessionId: () => string
}

/** 키보드 포커스가 있는 터미널 pane 의 id — xterm 입력칸은 `[data-term-pane]` 안에 있다. 터미널이 아니면 null. */
export function focusedTerminalPane(active: Element | null): string | null {
  const host = active?.closest('[data-term-pane]') ?? null
  const paneId = host?.getAttribute('data-term-pane') ?? null
  return paneId === null || paneId === '' ? null : paneId
}

/**
 * `insertFailed` — 넣기 실패 알림은 세션당 한 번(fix2 G-R2-1).
 * 무음 알림(fix4 F-2): `heardSound` = 시작 뒤 디지털 0 이 아닌 레벨이 한 번이라도 왔나, `zeroSince` = 소리 없이 레벨이 이어진 시작, `stalledSince` = 프레임 끊김이 이어진 시작.
 * 켜고 끄기(fix4 F-1): `hold` = 이 세션을 연 누름이 아직 눌린 채(`lastDownAt` = 키 반복 포함 마지막 keydown), `tapped` = 탭으로 켜져 60초 자동 정지를 본다.
 */
type Active = {
  sessionId: string
  paneId: string
  /** 듣기 시작(`ready`) 시각 — 탭 세션 60초의 기준점(r5 C-R5-3: 권한 창 대기는 세지 않는다). 듣기 전이면 null. */
  listeningAt: number | null
  insertFailed: boolean
  heardSound: boolean
  zeroSince: number | null
  stalledSince: number | null
  lastSpeechAt: number
  hold: { pressedAt: number; lastDownAt: number } | null
  tapped: boolean
  /** 듣기 전(starting)에 홀드를 뗐다 — `ready` 가 오면 바로 정지한다(r4 G-R4-1, orca 처럼 엔진이 뜬 뒤 정지로 마무리). */
  stopPending: boolean
  cancelSilenceStop: (() => void) | null
}

export function createDictationController(deps: DictationControllerDeps) {
  let view: DictationView = IDLE_DICTATION
  let active: Active | null = null
  const insert = (session: Active, text: string): void => {
    deps.clearSelection(session.paneId)
    const failed = (code: string, message: string): void => {
      if (session.insertFailed) return
      session.insertFailed = true
      if (active === session) cancelActive()
      deps.notify({ message: dictationErrorMessage({ code, message }), openPrivacy: false })
    }
    void deps.insert({ sessionId: session.sessionId, paneId: session.paneId, text }).then(
      (result) => {
        // `skipped` = 그 세션이 이미 취소·실패해 main 이 보내지 않았다 — 알릴 일이 아니다(fix2 C-R2-3).
        if (!result.ok && result.code !== 'skipped') failed(result.code, result.message)
      },
      (error: unknown) => failed('insert-failed', error instanceof Error ? error.message : String(error)),
    )
  }

  const set = (next: DictationView): void => {
    view = next
    deps.onChange(view)
  }
  const end = (): void => {
    active?.cancelSilenceStop?.()
    active = null
    set(IDLE_DICTATION)
  }
  /** 받아쓰는 중 정지 — 듣기 전이면 확정할 글이 없어 취소와 같다. 이미 정지 중이면 아무것도 안 한다. */
  const stopActive = (): void => {
    if (active === null) return
    active.hold = null
    switch (view.phase) {
      case 'starting':
        cancelActive()
        return
      case 'listening':
        deps.stop({ sessionId: active.sessionId })
        set({ ...view, phase: 'stopping' })
        return
      case 'stopping':
      case 'idle':
        return
    }
  }
  /** 탭 세션의 60초 자동 정지 — 듣기 시작(`ready`)부터 시계 기준(레벨 줄이 끊겨도 센다). 때가 되면 마지막 말소리를 다시 보고, 그 뒤 말소리가 있었으면 다시 잰다. */
  const watchSilence = (session: Active): void => {
    const check = (): void => {
      session.cancelSilenceStop = null
      if (active !== session || !session.tapped || session.listeningAt === null) return
      const remaining = Math.max(session.listeningAt, session.lastSpeechAt) + DICTATION_AUTO_STOP_SILENCE_MS - deps.now()
      if (remaining > 0) {
        session.cancelSilenceStop = deps.schedule(remaining, check)
        return
      }
      if (view.phase === 'stopping') return
      stopActive()
      deps.notify({ message: DICTATION_AUTO_STOPPED_MESSAGE, openPrivacy: false })
    }
    check()
  }
  const cancelActive = (): void => {
    if (active === null) return
    deps.cancel({ sessionId: active.sessionId })
    end()
  }

  const begin = (paneId: string): void => {
    const now = deps.now()
    const session: Active = {
      sessionId: deps.newSessionId(),
      paneId,
      listeningAt: null,
      insertFailed: false,
      heardSound: false,
      zeroSince: null,
      stalledSince: null,
      lastSpeechAt: now,
      hold: { pressedAt: now, lastDownAt: now },
      tapped: false,
      stopPending: false,
      cancelSilenceStop: null,
    }
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
    /** 단축키 누름(keydown, 반복 아님). `focusedPaneId` = 누른 순간 키보드 포커스가 있던 터미널 pane(없으면 null). idle 이면 시작(누름이 이어지는 동안 홀드), 받아쓰는 중이면 정지. */
    press(focusedPaneId: string | null): void {
      if (view.phase !== 'idle') {
        stopActive()
        return
      }
      if (focusedPaneId === null) {
        deps.notify({ message: DICTATION_NOT_TERMINAL_MESSAGE, openPrivacy: false })
        return
      }
      begin(focusedPaneId)
    },
    /** 눌린 채 키 반복이 왔다 — 홀드 길이를 잰다. */
    repeat(): void {
      if (active?.hold != null) active.hold.lastDownAt = deps.now()
    },
    /** 이 세션을 연 누름이 끝났다. `timed` = 뗌 시각이 지금이다(글쇠 keyup). 거짓 = 모른다(⌘ keyup·창 포커스 잃음) — 마지막 키 반복 시각으로 잰다. */
    release(timed: boolean): void {
      const session = active
      if (session === null || session.hold === null) return
      const held = (timed ? deps.now() : session.hold.lastDownAt) - session.hold.pressedAt >= DICTATION_HOLD_THRESHOLD_MS
      session.hold = null
      if (held && view.phase === 'starting') {
        // 듣기 전 — 취소(도우미 SIGTERM)하지 않고 정지를 예약한다. 표시는 「마지막 글 확정 중」, Esc 는 그대로 취소.
        session.stopPending = true
        set({ phase: 'stopping', paneId: session.paneId, partial: '', silent: false })
        return
      }
      if (held) {
        stopActive()
        return
      }
      session.tapped = true
      watchSilence(session)
    },
    /** 홀드 중인가 — 창이 뗌을 들어야 하는 동안 참. */
    get holding(): boolean {
      return active?.hold != null
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
          if (session.stopPending) {
            session.stopPending = false
            deps.stop({ sessionId: session.sessionId })
            return
          }
          session.listeningAt = deps.now()
          if (view.phase === 'starting') set({ phase: 'listening', paneId: session.paneId, partial: '', silent: false })
          // 듣기 전에 탭으로 뗐으면 60초는 지금부터 잰다
          if (session.tapped) watchSilence(session)
          return
        case 'partial':
          if (event.text !== '') session.lastSpeechAt = deps.now()
          if (view.phase === 'listening' || view.phase === 'stopping') set({ ...view, partial: event.text })
          return
        case 'final': {
          if (!deps.paneExists(session.paneId)) {
            cancelActive()
            deps.notify({ message: DICTATION_TARGET_CLOSED_MESSAGE, openPrivacy: false })
            return
          }
          if (event.text !== '') {
            session.lastSpeechAt = deps.now()
            insert(session, event.text)
          }
          if (view.phase === 'listening' || view.phase === 'stopping') set({ ...view, partial: '' })
          return
        }
        case 'level': {
          if (view.phase !== 'listening' && view.phase !== 'stopping') return
          const now = deps.now()
          if (event.rms >= DICTATION_SPEECH_RMS) session.lastSpeechAt = now
          if (event.stalled) {
            session.stalledSince ??= now
          } else {
            session.stalledSince = null
            if (event.rms > DICTATION_SILENCE_RMS) session.heardSound = true
            else if (!session.heardSound) session.zeroSince ??= now
          }
          const silent =
            (session.stalledSince !== null && now - session.stalledSince >= DICTATION_SILENCE_NOTICE_MS) ||
            (!session.heardSound && session.zeroSince !== null && now - session.zeroSince >= DICTATION_SILENCE_NOTICE_MS)
          if (silent !== view.silent) set({ ...view, silent })
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

export type { DictationPressKeys }

const MODIFIER_OF_KEY: Partial<Record<string, keyof Omit<DictationPressKeys, 'code'>>> = { Meta: 'meta', OS: 'meta', Shift: 'shift', Control: 'control', Alt: 'alt', AltGraph: 'alt' }

/**
 * keyup 이 이 누름의 뗌인가 — 누를 때 잡고 있던 수식 키 하나를 떼거나 같은 글쇠를 떼면 뗌(orca `createHoldDictationReleaseMatcher` 와 같은 규칙).
 * `timed` = 뗌 시각이 지금인가: ⌘ 를 누른 채면 macOS 가 글쇠 keyup 을 버려 수식 키 keyup 이 늦게 온다 — 그때는 거짓(마지막 키 반복 시각으로 잰다).
 */
export function dictationRelease(input: { press: DictationPressKeys; keyup: { key: string; code: string; metaKey: boolean } }): { matches: boolean; timed: boolean } {
  const modifier = MODIFIER_OF_KEY[input.keyup.key]
  const matches = modifier !== undefined ? input.press[modifier] : input.keyup.code !== '' && input.keyup.code === input.press.code
  return { matches, timed: !(input.keyup.metaKey || modifier === 'meta') }
}
