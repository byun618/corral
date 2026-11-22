// LIFE-834 음성 받아쓰기 — main 쪽. 도우미 기동·정지·취소, stdout 줄 해석, 렌더러로 이벤트, 앱 종료 때 정리.
//
// 세션은 한 번에 하나다. 새 시작이 오면 앞 세션을 취소한다(렌더러 다시 불러오기로 주인을 잃은 세션이 마이크를 쥔 채 남지 않게).
// 끝은 세션마다 정확히 한 번 `ended` 로 알린다 — 사유는 취소 > 도우미 오류 줄 > 정상(done + 종료 0) > 정지 상한 초과 > 비정상 종료 순으로 정한다.
// 정지 = stdin 에 `stop` 줄 + 닫기(도우미가 마지막 FINAL 을 확정하고 끝낸다), 상한(`DICTATION_STOP_TIMEOUT_MS`)을 넘으면 SIGKILL.
// 취소 = SIGTERM — 그 뒤에 오는 줄은 버린다. 프로세스는 spawn 이 준 ChildProcess(PID)로만 다룬다(명령줄 패턴 금지 — validation.md).
import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import {
  DICTATION_STOP_TIMEOUT_MS,
  dictationOsSupported,
  parseHelperLine,
  type DictationEnd,
  type DictationEvent,
  type DictationStartResult,
} from '../shared/dictation.js'

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
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
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

  const finish = (session: Session, end: DictationEnd): void => {
    if (session.ended) return
    session.ended = true
    session.stopTimer?.clear()
    if (current === session) current = null
    deps.log('dictation.ended', { sessionId: session.id, pid: session.child.pid ?? null, end: end.kind, code: end.kind === 'error' ? end.code : null })
    deps.send({ kind: 'ended', sessionId: session.id, end })
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
      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
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
    /** 창 닫힘·렌더러 소멸·앱 종료 — 진행 중 도우미를 바로 끝낸다(고아 없음). */
    dispose(): void {
      const session = current
      if (session === null) return
      session.cancelled = true
      session.child.kill('SIGKILL')
      finish(session, { kind: 'cancelled' })
    },
    /** 진행 중 세션의 도우미 PID (관측용). */
    activePid(): number | null {
      return current?.child.pid ?? null
    },
  }
}

export type DictationManager = ReturnType<typeof createDictationManager>

export function nodeDictationDeps(input: { helper: string; platform: string; release: string; send: DictationDeps['send']; log: DictationDeps['log'] }): DictationDeps {
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
