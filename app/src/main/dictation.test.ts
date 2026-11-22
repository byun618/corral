// LIFE-834 — main 받아쓰기 세션: 도우미 출력·종료를 흉내 낸 가짜 자식 프로세스로 C6(미지원·이상)·정지·취소·정리(고아 없음)를 본다.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DICTATION_STOP_TIMEOUT_MS, type DictationEvent } from '../shared/dictation.js'
import { createDictationManager, dictationDisposesOnNavigation, dictationHelperPath, type DictationChild, type DictationDeps } from './dictation.js'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stdin = new PassThrough()
  signals: string[] = []
  stdinText = ''
  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.stdinText += chunk
    })
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal))
    return true
  }
  line(object: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(object)}\n`)
  }
  exit(code: number | null, signal: string | null = null): void {
    this.emit('close', code, signal)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: Partial<DictationDeps> = {}) {
  const events: DictationEvent[] = []
  const children: FakeChild[] = []
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  const spawned: string[] = []
  const deps: DictationDeps = {
    helper: '/app/helper/corral-dictation',
    platform: 'darwin',
    release: '25.4.0',
    executable: () => true,
    spawn: (file): DictationChild => {
      spawned.push(file)
      const child = new FakeChild()
      children.push(child)
      return child
    },
    send: (event) => events.push(event),
    log: () => undefined,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return { clear: () => (timer.cleared = true) }
    },
    ...overrides,
  }
  return { manager: createDictationManager(deps), events, children, timers, spawned }
}

describe('dictationHelperPath', () => {
  it('설치본은 Resources/helper, dev 는 build/helper', () => {
    expect(dictationHelperPath({ packaged: true, resourcesPath: '/A/corral.app/Contents/Resources', mainDir: '/x' })).toBe('/A/corral.app/Contents/Resources/helper/corral-dictation')
    expect(dictationHelperPath({ packaged: false, resourcesPath: '', mainDir: '/repo/app/out/main' })).toBe('/repo/app/build/helper/corral-dictation')
  })
})

describe('정상 흐름 — 줄 중계·정지', () => {
  it('ready·partial·final·level 줄을 세션 id 를 붙여 중계하고, 정지는 stdin 에 stop 을 쓰고 닫는다 → done + 종료 0 = ended done', async () => {
    const h = harness()
    expect(h.manager.start({ sessionId: 's1' })).toEqual({ ok: true })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    expect(h.manager.activePid()).toBe(4242)
    child.line({ type: 'ready' })
    child.line({ type: 'partial', text: '워크' })
    // 한 줄이 조각으로 나뉘어 와도 줄 단위로 맞춘다
    child.stdout.write('{"type":"final","te')
    child.stdout.write('xt":"워크트리 목록"}\n{"type":"level","rms":0.01}\n')
    await tick()
    expect(h.events).toEqual([
      { kind: 'ready', sessionId: 's1' },
      { kind: 'partial', sessionId: 's1', text: '워크' },
      { kind: 'final', sessionId: 's1', text: '워크트리 목록' },
      { kind: 'level', sessionId: 's1', rms: 0.01 },
    ])
    h.manager.stop({ sessionId: 's1' })
    await tick()
    expect(child.stdinText).toBe('stop\n')
    expect(h.timers[0]?.ms).toBe(DICTATION_STOP_TIMEOUT_MS)
    child.line({ type: 'final', text: '마지막' })
    child.line({ type: 'done' })
    await tick()
    child.exit(0)
    expect(h.events.slice(-2)).toEqual([
      { kind: 'final', sessionId: 's1', text: '마지막' },
      { kind: 'ended', sessionId: 's1', end: { kind: 'done' } },
    ])
    expect(h.timers[0]?.cleared).toBe(true)
    expect(h.manager.activePid()).toBeNull()
  })
  it('정지 상한을 넘으면 SIGKILL, 끝은 stop-timeout', async () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    h.manager.stop({ sessionId: 's1' })
    h.timers[0]?.callback()
    expect(child.signals).toEqual(['SIGKILL'])
    child.exit(null, 'SIGKILL')
    expect(h.events.at(-1)).toEqual({ kind: 'ended', sessionId: 's1', end: { kind: 'error', code: 'stop-timeout', message: '' } })
  })
})

describe('취소 — SIGTERM, 그 뒤 줄은 버린다', () => {
  it('취소 뒤 온 final 은 중계하지 않고 ended cancelled', async () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    h.manager.cancel({ sessionId: 's1' })
    expect(child.signals).toEqual(['SIGTERM'])
    child.line({ type: 'final', text: '버릴 글' })
    await tick()
    child.exit(null, 'SIGTERM')
    expect(h.events).toEqual([{ kind: 'ended', sessionId: 's1', end: { kind: 'cancelled' } }])
  })
  it('다른 세션 id 의 정지·취소는 무시한다', () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    h.manager.cancel({ sessionId: 'other' })
    h.manager.stop({ sessionId: 'other' })
    expect(h.children[0]?.signals).toEqual([])
    expect(h.children[0]?.stdinText).toBe('')
  })
  it('새 시작은 앞 세션을 취소한다 — 주인 잃은 도우미가 마이크를 쥔 채 남지 않는다', () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    h.manager.start({ sessionId: 's2' })
    expect(h.children[0]?.signals).toEqual(['SIGTERM'])
    expect(h.children).toHaveLength(2)
    expect(h.manager.activePid()).toBe(4242)
  })
})

describe('C6 미지원·이상', () => {
  it('macOS 26 미만(Darwin 24) → 띄우지 않고 unsupported-os', () => {
    const h = harness({ release: '24.6.0' })
    expect(h.manager.start({ sessionId: 's1' })).toEqual({ ok: false, code: 'unsupported-os', message: '' })
    expect(h.spawned).toEqual([])
  })
  it('macOS 가 아니면 unsupported-os', () => {
    const h = harness({ platform: 'linux', release: '6.1.0' })
    expect(h.manager.start({ sessionId: 's1' })).toMatchObject({ ok: false, code: 'unsupported-os' })
  })
  it('실행 파일 없음 → 띄우지 않고 helper-missing(경로)', () => {
    const h = harness({ executable: () => false })
    expect(h.manager.start({ sessionId: 's1' })).toEqual({ ok: false, code: 'helper-missing', message: '/app/helper/corral-dictation' })
    expect(h.spawned).toEqual([])
  })
  it('spawn 이 던지면 spawn-failed', () => {
    const h = harness({
      spawn: () => {
        throw new Error('EACCES')
      },
    })
    expect(h.manager.start({ sessionId: 's1' })).toEqual({ ok: false, code: 'spawn-failed', message: 'EACCES' })
  })
  it('자식 error 이벤트(실행 실패) → ended spawn-failed, 한 번만', () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    child.emit('error', new Error('spawn EACCES'))
    child.exit(-2)
    expect(h.events).toEqual([{ kind: 'ended', sessionId: 's1', end: { kind: 'error', code: 'spawn-failed', message: 'spawn EACCES' } }])
  })
  it.each([
    { code: 'locale-not-installed', message: '한국어(ko-KR) 인식 자산이 설치돼 있지 않다', status: 4 },
    { code: 'mic-denied', message: '마이크 권한이 거부됐다', status: 3 },
    { code: 'transcriber-unavailable', message: '', status: 4 },
  ])('도우미 오류 줄 $code + 종료 $status → ended error $code', async ({ code, message, status }) => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    child.line({ type: 'error', code, message })
    await tick()
    child.exit(status)
    expect(h.events).toEqual([{ kind: 'ended', sessionId: 's1', end: { kind: 'error', code, message } }])
  })
  it('오류 줄 없이 비정상 종료(신호) → helper-crashed, 이미 중계한 final 은 그대로', async () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    child.line({ type: 'ready' })
    child.line({ type: 'final', text: '넣은 글' })
    await tick()
    child.exit(null, 'SIGSEGV')
    expect(h.events.at(-1)).toEqual({ kind: 'ended', sessionId: 's1', end: { kind: 'error', code: 'helper-crashed', message: '신호 SIGSEGV' } })
    expect(h.events.filter((event) => event.kind === 'final')).toHaveLength(1)
  })
  it('done 없이 종료 0 도 비정상으로 본다(조용한 무결과 금지)', () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    h.children[0]?.exit(0)
    expect(h.events.at(-1)).toMatchObject({ kind: 'ended', end: { kind: 'error', code: 'helper-crashed' } })
  })
  it('모양이 다른 줄은 버리고 세션은 이어 간다', async () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    child.stdout.write('not json\n{"type":"final"}\n{"type":"final","text":"ok"}\n')
    await tick()
    expect(h.events).toEqual([{ kind: 'final', sessionId: 's1', text: 'ok' }])
  })
})

describe('창 닫힘·앱 종료 — 고아 프로세스 없음', () => {
  it('dispose 는 진행 중 도우미를 SIGKILL 하고 렌더러에는 알리지 않는다(fix1 F5)', () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    h.manager.dispose()
    expect(child.signals).toEqual(['SIGKILL'])
    expect(h.manager.activePid()).toBeNull()
    child.exit(null, 'SIGKILL')
    // fix1 F5 — 받을 렌더러가 없다(창 닫힘·소멸·재로드·종료) — 알리지 않는다
    expect(h.events).toEqual([])
  })
  it('세션이 없으면 dispose 는 아무것도 안 한다', () => {
    const h = harness()
    h.manager.dispose()
    expect(h.events).toEqual([])
  })
})

describe('fix1 F4 — 마무리는 close(stdio 닫힌 뒤)', () => {
  it('exit 만 오고 close 가 아직이면 끝내지 않는다 — 그 사이 온 final 도 중계된다', async () => {
    const h = harness()
    h.manager.start({ sessionId: 's1' })
    const child = h.children[0]
    if (child === undefined) throw new Error('spawn 없음')
    child.emit('exit', 0, null)
    child.line({ type: 'final', text: '늦게 읽힌 줄' })
    child.line({ type: 'done' })
    await tick()
    expect(h.events).toEqual([{ kind: 'final', sessionId: 's1', text: '늦게 읽힌 줄' }])
    child.exit(0)
    expect(h.events.at(-1)).toEqual({ kind: 'ended', sessionId: 's1', end: { kind: 'done' } })
  })
})

describe('fix1 F1·G3 — 재로드에서 세션 정리', () => {
  it.each([
    [{ isMainFrame: true, isSameDocument: false }, true],
    [{ isMainFrame: true, isSameDocument: true }, false],
    [{ isMainFrame: false, isSameDocument: false }, false],
  ])('%o → %s', (input, expected) => {
    expect(dictationDisposesOnNavigation(input)).toBe(expected)
  })
})
