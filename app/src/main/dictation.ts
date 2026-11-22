// LIFE-834 음성 받아쓰기 — main 쪽. 도우미 기동·정지·취소, stdout 줄 해석, 렌더러로 이벤트, 앱 종료 때 정리.
//
// 세션은 한 번에 하나다. 새 시작이 오면 앞 세션을 취소한다(렌더러 다시 불러오기로 주인을 잃은 세션이 마이크를 쥔 채 남지 않게).
// 끝은 세션마다 정확히 한 번 `ended` 로 알린다 — 사유는 취소 > 도우미 오류 줄 > 정상(done + 종료 0) > 정지 상한 초과 > 비정상 종료 순으로 정한다.
// 정지 = stdin 에 `stop` 줄 + 닫기(도우미가 마지막 FINAL 을 확정하고 끝낸다), 상한(`DICTATION_STOP_TIMEOUT_MS`)을 넘으면 SIGKILL.
// 취소 = SIGTERM — 그 뒤에 오는 줄은 버린다. 프로세스는 spawn 이 준 ChildProcess(PID)로만 다룬다(명령줄 패턴 금지 — validation.md).
// 마무리는 `close`(stdio 가 다 닫힌 뒤)에서 한다 — `exit` 뒤에도 stdout 에 남은 줄이 올 수 있다(fix1 F4).
// 창 닫힘·렌더러 소멸·재로드·종료의 `dispose` 는 렌더러에 알리지 않는다 — 받을 렌더러가 없다(fix1 F5).
//
// 넣기(fix1 G1): 렌더러는 FINAL 을 `insert` 로 보내고 결과를 받는다. 대상 pane 이 지금 붙은 탭에 있으면(어느 연결이 쥐고 있으면) ⌘V 와 같은 길 —
// `clipboardTextPayloads`(강제 bracketed paste)를 `stream.input` 으로. 붙어 있지 않으면(같은 영역의 다른 탭·파일 탭을 보는 중) 그 길은 herdr 가 조용히
// 버리므로(S1 — `stream.input_blocked`) guard `pane.send_text` 로 보낸다. 그 경로는 날 바이트라 2004 모드를 모른다 — 줄바꿈·제어 문자를 빼고
// (`dictationTypedText` — Enter 가 될 수 없다) 글자만 보낸다. 넣기는 한 줄로 직렬이다(도착 순서). 보내지 못하면 `ok:false` — 렌더러가 멈추고 알린다.
import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import type { TerminalBackend, TerminalOperation } from './adapter/index.js'
import {
  DICTATION_STOP_TIMEOUT_MS,
  dictationOsSupported,
  dictationTypedText,
  parseHelperLine,
  type DictationEnd,
  type DictationEvent,
  type DictationInsertResult,
  type DictationStartResult,
} from '../shared/dictation.js'
import { clipboardTextPayloads } from '../shared/terminal-paste.js'

export function dictationHelperPath(input: { packaged: boolean; resourcesPath: string; mainDir: string }): string {
  return input.packaged ? path.join(input.resourcesPath, 'helper', 'corral-dictation') : path.resolve(input.mainDir, '..', '..', 'build', 'helper', 'corral-dictation')
}

/** 도우미 프로세스에서 쓰는 것만 — 시험이 가짜를 넣는다. `ChildProcess` 가 그대로 맞는다. */
export type DictationChild = {
  pid?: number | undefined
  stdout: Readable | null
  stdin: Writable | null
  kill: (signal: NodeJS.Signals) => boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type DictationDeps = {
  helper: string
  platform: string
  release: string
  /** 실행 파일이 있고 실행 비트가 있나. */
  executable: (file: string) => boolean
  spawn: (file: string) => DictationChild
  send: (event: DictationEvent) => void
  log: (event: string, fields: Record<string, unknown>) => void
  setTimer: (callback: () => void, ms: number) => { clear: () => void }
  /** 세션을 취소·정리했다(Esc·새 시작·dispose) — 넣기 큐가 그 세션의 남은 항목을 버린다(fix2 C-R2-3). */
  onDropped?: (sessionId: string) => void
}

type Session = {
  id: string
  child: DictationChild
  cancelled: boolean
  stopping: boolean
  stopTimedOut: boolean
  sawDone: boolean
  error: { code: string; message: string } | null
  ended: boolean
  stopTimer: { clear: () => void } | null
}

export function createDictationManager(deps: DictationDeps) {
  let current: Session | null = null

  const finish = (session: Session, end: DictationEnd, notify = true): void => {
    if (session.ended) return
    session.ended = true
    session.stopTimer?.clear()
    if (current === session) current = null
    deps.log('dictation.ended', { sessionId: session.id, pid: session.child.pid ?? null, end: end.kind, code: end.kind === 'error' ? end.code : null })
    if (notify) deps.send({ kind: 'ended', sessionId: session.id, end })
  }

  const onLine = (session: Session, line: string): void => {
    if (session.ended || session.cancelled || line.trim() === '') return
    const parsed = parseHelperLine(line)
    if (parsed === null) {
      deps.log('dictation.bad_line', { sessionId: session.id, line: line.slice(0, 200) })
      return
    }
    switch (parsed.type) {
      case 'ready':
        deps.send({ kind: 'ready', sessionId: session.id })
        return
      case 'partial':
      case 'final':
        deps.send({ kind: parsed.type, sessionId: session.id, text: parsed.text })
        return
      case 'level':
        deps.send({ kind: 'level', sessionId: session.id, rms: parsed.rms })
        return
      case 'error':
        session.error = { code: parsed.code, message: parsed.message }
        return
      case 'done':
        session.sawDone = true
        return
    }
  }

  const onExit = (session: Session, code: number | null, signal: string | null): void => {
    if (session.cancelled) return finish(session, { kind: 'cancelled' })
    if (session.error !== null) return finish(session, { kind: 'error', ...session.error })
    if (session.sawDone && code === 0) return finish(session, { kind: 'done' })
    if (session.stopTimedOut) return finish(session, { kind: 'error', code: 'stop-timeout', message: '' })
    finish(session, { kind: 'error', code: 'helper-crashed', message: signal !== null ? `신호 ${signal}` : `종료코드 ${code ?? '?'}` })
  }

  const cancelSession = (session: Session): void => {
    if (session.ended || session.cancelled) return
    session.cancelled = true
    deps.onDropped?.(session.id)
    session.child.kill('SIGTERM')
  }

  return {
    start(input: { sessionId: string }): DictationStartResult {
      if (current !== null) cancelSession(current)
      if (!dictationOsSupported({ platform: deps.platform, release: deps.release })) return { ok: false, code: 'unsupported-os', message: '' }
      if (!deps.executable(deps.helper)) return { ok: false, code: 'helper-missing', message: deps.helper }
      let child: DictationChild
      try {
        child = deps.spawn(deps.helper)
      } catch (error) {
        return { ok: false, code: 'spawn-failed', message: error instanceof Error ? error.message : String(error) }
      }
      const session: Session = { id: input.sessionId, child, cancelled: false, stopping: false, stopTimedOut: false, sawDone: false, error: null, ended: false, stopTimer: null }
      current = session
      deps.log('dictation.started', { sessionId: session.id, pid: child.pid ?? null })
      let buffered = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk
        let newline = buffered.indexOf('\n')
        while (newline !== -1) {
          onLine(session, buffered.slice(0, newline))
          buffered = buffered.slice(newline + 1)
          newline = buffered.indexOf('\n')
        }
      })
      // stdin 이 먼저 닫혀 쓰기가 실패해도(EPIPE) 앱이 죽지 않게 — 끝은 exit 가 알린다.
      child.stdin?.on('error', () => undefined)
      child.on('error', (error: Error) => {
        if (session.cancelled) return finish(session, { kind: 'cancelled' })
        finish(session, { kind: 'error', code: 'spawn-failed', message: error.message })
      })
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (buffered !== '') onLine(session, buffered)
        buffered = ''
        onExit(session, code, signal)
      })
      return { ok: true }
    },
    stop(input: { sessionId: string }): void {
      const session = current
      if (session === null || session.id !== input.sessionId || session.stopping || session.cancelled) return
      session.stopping = true
      session.child.stdin?.end('stop\n')
      session.stopTimer = deps.setTimer(() => {
        if (session.ended) return
        session.stopTimedOut = true
        session.child.kill('SIGKILL')
      }, DICTATION_STOP_TIMEOUT_MS)
    },
    cancel(input: { sessionId: string }): void {
      if (current !== null && current.id === input.sessionId) cancelSession(current)
    },
    /** 창 닫힘·렌더러 소멸·재로드·앱 종료 — 진행 중 도우미를 바로 끝낸다(고아 없음). 렌더러에는 알리지 않는다(받을 쪽이 없다). */
    dispose(): void {
      const session = current
      if (session === null) return
      session.cancelled = true
      deps.onDropped?.(session.id)
      session.child.kill('SIGKILL')
      finish(session, { kind: 'cancelled' }, false)
    },
    /** 진행 중 세션의 도우미 PID (관측용). */
    activePid(): number | null {
      return current?.child.pid ?? null
    },
  }
}

export type DictationManager = ReturnType<typeof createDictationManager>

/**
 * 메인 프레임 문서가 **바뀌었을 때**(재로드·Force Reload 가 커밋됨) 세션을 정리한다(fix1 F1·G3). `did-navigate` 는 메인 프레임의 커밋된 이동에만 온다 —
 * `will-navigate` 가 거부한 이동(마크다운 링크 클릭 등)·같은 문서 안 이동(`did-navigate-in-page`)에는 오지 않는다. `did-start-navigation` 은 거부될 이동에도
 * 먼저 와서 쓰지 않는다(fix2 C-R2-1 — Electron 44.3 재현 `raw/review/claude-r2/nav-probe2.txt`: 거부 단계에 did-start-navigation 뒤 will-navigate(prevented), did-navigate 없음).
 */
export function attachDictationNavigationCleanup(input: { webContents: { on: (event: 'did-navigate', listener: () => void) => unknown }; dispose: () => void }): void {
  input.webContents.on('did-navigate', () => input.dispose())
}

export type DictationInsertDeps = {
  /** 지금 어느 연결이 쥐고 있는(붙은 탭의) pane 들 — `TerminalStreams.heldPaneIds`. */
  heldPaneIds: () => readonly string[]
  /** 붙은 pane 의 입력 — `TerminalStreams.input`(⌘V 와 같은 길). */
  paste: (input: { paneId: string; data: string }) => void
  /** 붙지 않은 pane 에 날 글자 — guard `pane.send_text`. 못 보내면 던진다. */
  sendText: (input: { paneId: string; text: string; signal: AbortSignal }) => Promise<void>
  log: (event: string, fields: Record<string, unknown>) => void
}

export function createDictationInserter(deps: DictationInsertDeps) {
  let tail: Promise<unknown> = Promise.resolve()
  /** 세션마다 하나 — 취소·실패하면 끊어(abort) 남은 항목과 진행 중 왕복을 멈춘다(fix2 C-R2-3·G-R2-1). */
  const sessions = new Map<string, AbortController>()
  const controllerOf = (sessionId: string): AbortController => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created = new AbortController()
    sessions.set(sessionId, created)
    return created
  }
  const skipped: DictationInsertResult = { ok: false, code: 'skipped', message: '' }
  const insertNow = async (input: { sessionId: string; paneId: string; text: string }, signal: AbortSignal): Promise<DictationInsertResult> => {
    // 큐에서 기다리는 사이 그 세션이 취소·실패했으면 아무것도 보내지 않는다.
    if (signal.aborted) return skipped
    if (deps.heldPaneIds().includes(input.paneId)) {
      for (const data of clipboardTextPayloads(input.text)) deps.paste({ paneId: input.paneId, data })
      deps.log('dictation.insert', { paneId: input.paneId, via: 'paste', length: input.text.length })
      return { ok: true, via: 'paste' }
    }
    const typed = dictationTypedText(input.text)
    if (typed === '') return { ok: true, via: 'send-text' }
    try {
      await deps.sendText({ paneId: input.paneId, text: typed, signal })
    } catch (error) {
      // 끊어서 멈춘 왕복은 실패가 아니다(취소한 쪽이 이미 안다). guard 가 이미 썼는지는 모른다 — worklog fix2.
      if (signal.aborted) return skipped
      const message = error instanceof Error ? error.message : String(error)
      deps.log('dictation.insert_failed', { paneId: input.paneId, via: 'send-text', error: message })
      // 실패는 세션당 한 번 — 그 세션의 남은 항목은 버린다.
      controllerOf(input.sessionId).abort()
      return { ok: false, code: 'insert-failed', message }
    }
    deps.log('dictation.insert', { paneId: input.paneId, via: 'send-text', length: typed.length })
    return { ok: true, via: 'send-text' }
  }
  return {
    /** 도착 순서대로 하나씩 — 앞 넣기(날 글자 왕복)가 끝나야 다음을 보낸다. */
    insert(input: { sessionId: string; paneId: string; text: string }): Promise<DictationInsertResult> {
      const signal = controllerOf(input.sessionId).signal
      const result = tail.then(() => insertNow(input, signal))
      tail = result.catch(() => undefined)
      return result
    },
    /** 세션 취소(Esc·새 시작·dispose) — 그 세션의 남은 항목은 0바이트, 진행 중 send_text 왕복은 끊는다. */
    dropSession(sessionId: string): void {
      controllerOf(sessionId).abort()
    },
  }
}

/** guard `pane.send_text` — 지금 epoch 의 목록에서 그 pane 을 찾아 보낸다. CLI `terminal send` 와 같은 봉투. */
export async function sendTextToPane(input: { backend: Pick<TerminalBackend, 'epoch' | 'list' | 'send'>; paneId: string; text: string; deadlineMs: number; signal: AbortSignal }): Promise<void> {
  // 세션 취소 신호를 매 호출에 싣는다 — 백엔드가 호출 전에 `throwIfAborted` 로 본다(이미 떠난 쓰기 요청은 못 되돌린다).
  const ctx = (): TerminalOperation => ({ signal: input.signal, deadlineAt: Date.now() + input.deadlineMs })
  const epoch = await input.backend.epoch(ctx())
  const target = (await input.backend.list(epoch, ctx())).find((pane) => pane.paneId === input.paneId)
  if (target === undefined) throw new Error(`pane 을 찾지 못했다 (${input.paneId})`)
  await input.backend.send(target, input.text, ctx())
}

export function nodeDictationDeps(input: { helper: string; platform: string; release: string; send: DictationDeps['send']; log: DictationDeps['log']; onDropped?: DictationDeps['onDropped'] }): DictationDeps {
  return {
    ...input,
    executable: (file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK)
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    },
    spawn: (file) => spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'] }),
    setTimer: (callback, ms) => {
      const timer = setTimeout(callback, ms)
      return { clear: () => clearTimeout(timer) }
    },
  }
}
