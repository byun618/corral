// LIFE-834 — main 받아쓰기 세션: 도우미 출력·종료를 흉내 낸 가짜 자식 프로세스로 C6(미지원·이상)·정지·취소·정리(고아 없음)를 본다.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DICTATION_PRESS_KEYS_CHANNEL, DICTATION_STOP_TIMEOUT_MS, type DictationEvent } from '../shared/dictation.js'
import { attachDictationNavigationCleanup, createDictationInserter, createDictationRepeatGuard, createDictationManager, createDictationService, dictationHelperPath, type DictationChild, type DictationDeps } from './dictation.js'

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
  return { manager: createDictationManager(deps), deps, events, children, timers, spawned }
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
    child.stdout.write('xt":"워크트리 목록"}\n{"type":"level","rms":0.01}\n{"type":"level","rms":0,"stalled":true}\n')
    await tick()
    expect(h.events).toEqual([
      { kind: 'ready', sessionId: 's1' },
      { kind: 'partial', sessionId: 's1', text: '워크' },
      { kind: 'final', sessionId: 's1', text: '워크트리 목록' },
      { kind: 'level', sessionId: 's1', rms: 0.01, stalled: false },
      { kind: 'level', sessionId: 's1', rms: 0, stalled: true },
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

describe('fix2 C-R2-1 — 재로드 정리 배선: 커밋된 메인 프레임 이동에만', () => {
  // 가짜 webContents — Electron 44.3 이 실제로 내는 순서를 흘린다(raw/review/claude-r2/nav-probe2.txt).
  function wired() {
    const webContents = new EventEmitter()
    let disposed = 0
    attachDictationNavigationCleanup({ webContents, dispose: () => (disposed += 1) })
    return { webContents, disposed: () => disposed }
  }
  it('거부된 이동(마크다운 링크 클릭 — did-start-navigation 뒤 will-navigate 거부, did-navigate 없음)은 세션을 건드리지 않는다', () => {
    const h = wired()
    h.webContents.emit('did-start-loading')
    h.webContents.emit('did-start-navigation', { url: 'https://example.invalid/x', isMainFrame: true, isSameDocument: false })
    h.webContents.emit('will-navigate', { preventDefault: () => undefined }, 'https://example.invalid/x')
    expect(h.disposed()).toBe(0)
  })
  it('같은 문서 안 이동(해시 — did-navigate-in-page)도 건드리지 않는다', () => {
    const h = wired()
    h.webContents.emit('did-start-navigation', { url: 'file:///a.html#x', isMainFrame: true, isSameDocument: true })
    h.webContents.emit('did-navigate-in-page', {}, 'file:///a.html#x')
    expect(h.disposed()).toBe(0)
  })
  it('재로드(커밋 — did-start-navigation 뒤 did-navigate)는 한 번 정리한다', () => {
    const h = wired()
    h.webContents.emit('did-start-navigation', { url: 'file:///a.html', isMainFrame: true, isSameDocument: false })
    h.webContents.emit('did-navigate', {}, 'file:///a.html')
    expect(h.disposed()).toBe(1)
  })
  it('index.ts 가 창 webContents 에 이 배선을 건다(배선 줄 존재)', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
    expect(source).toContain('attachDictationNavigationCleanup({ webContents: window.webContents, dispose: () => dictation?.dispose() })')
    expect(source).not.toContain("on('did-start-navigation'")
  })
})

describe('fix2 C-R2-3·fix3 R3-1 — 세션 취소가 넣기 큐의 남은 항목을 버린다(production 조립 `createDictationService`)', () => {
  it('index.ts 는 manager·inserter 를 createDictationService 로만 조립한다', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
    expect(source).toContain('= createDictationService({')
    expect(source).not.toMatch(/createDictation(Manager|Inserter)\(/)
  })
  it('send_text 왕복 중 Esc(취소) → 진행 중 왕복은 끊기고 뒤 FINAL 은 0바이트', async () => {
    const sent: string[] = []
    const pasted: string[] = []
    let releaseFirst: () => void = () => undefined
    const signals: AbortSignal[] = []
    const h = harness()
    const { manager, inserter } = createDictationService({ manager: h.deps, inserter: {
      heldPaneIds: () => [],
      paste: (input) => pasted.push(input.data),
      sendText: (input) =>
        new Promise<void>((resolve, reject) => {
          signals.push(input.signal)
          sent.push(input.text)
          input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          releaseFirst = resolve
        }),
      log: () => undefined,
    } })
    manager.start({ sessionId: 's1' })
    const first = inserter.insert({ sessionId: 's1', paneId: 'p1', text: '앞 글' })
    const second = inserter.insert({ sessionId: 's1', paneId: 'p1', text: '뒤 글' })
    await tick()
    expect(sent).toEqual(['앞 글'])
    manager.cancel({ sessionId: 's1' }) // Esc
    expect(signals[0]?.aborted).toBe(true)
    releaseFirst()
    expect(await first).toEqual({ ok: false, code: 'skipped', message: '' })
    expect(await second).toEqual({ ok: false, code: 'skipped', message: '' })
    expect(sent).toEqual(['앞 글'])
    expect(pasted).toEqual([])
  })
  it('dispose·새 시작도 앞 세션을 버린다', () => {
    const dropped: string[] = []
    const h = harness({ onDropped: (sessionId) => dropped.push(sessionId) })
    h.manager.start({ sessionId: 's1' })
    h.manager.start({ sessionId: 's2' })
    h.manager.dispose()
    expect(dropped).toEqual(['s1', 's2'])
  })
  it('다른 세션의 항목은 버리지 않는다', async () => {
    const pasted: string[] = []
    const inserter = createDictationInserter({ heldPaneIds: () => ['p1'], paste: (input) => pasted.push(input.data), sendText: async () => undefined, log: () => undefined })
    inserter.dropSession('s1')
    expect(await inserter.insert({ sessionId: 's2', paneId: 'p1', text: '새 세션' })).toEqual({ ok: true, via: 'paste' })
    expect(await inserter.insert({ sessionId: 's1', paneId: 'p1', text: '옛 세션' })).toEqual({ ok: false, code: 'skipped', message: '' })
    expect(pasted).toHaveLength(1)
  })
  it('실패는 세션당 한 번 — 첫 실패 뒤 그 세션의 남은 항목은 보내지 않고 skipped', async () => {
    let calls = 0
    const inserter = createDictationInserter({
      heldPaneIds: () => [],
      paste: () => undefined,
      sendText: async () => {
        calls += 1
        throw new Error('pane 을 찾지 못했다 (p1)')
      },
      log: () => undefined,
    })
    const results = await Promise.all([1, 2, 3].map((index) => inserter.insert({ sessionId: 's1', paneId: 'p1', text: `글 ${index}` })))
    expect(results.map((result) => (result.ok ? 'ok' : result.code))).toEqual(['insert-failed', 'skipped', 'skipped'])
    expect(calls).toBe(1)
  })
})

describe('fix3 R3-3 — 끝난 세션의 넣기 큐 표지를 지운다', () => {
  const quietInserter = () => {
    const pasted: string[] = []
    const inserter = createDictationInserter({ heldPaneIds: () => ['p1'], paste: (input) => pasted.push(input.data), sendText: async () => undefined, log: () => undefined })
    return { inserter, pasted }
  }
  it('정상 끝(done) — 항목이 다 빠지면 표지 0, 끝난 뒤 늦게 온 FINAL 도 넣고 다시 0', async () => {
    const h = harness()
    const { manager, inserter } = createDictationService({ manager: h.deps, inserter: { heldPaneIds: () => ['p1'], paste: () => undefined, sendText: async () => undefined, log: () => undefined } })
    manager.start({ sessionId: 's1' })
    const pending = inserter.insert({ sessionId: 's1', paneId: 'p1', text: '글' })
    h.children[0]?.exit(0)
    expect(inserter.trackedSessions()).toBe(1)
    expect(await pending).toEqual({ ok: true, via: 'paste' })
    expect(inserter.trackedSessions()).toBe(0)
    expect(await inserter.insert({ sessionId: 's1', paneId: 'p1', text: '늦은 글' })).toEqual({ ok: true, via: 'paste' })
    expect(inserter.trackedSessions()).toBe(0)
  })
  it('취소로 끝난 세션 — 표지를 지운 뒤 늦게 온 항목도 0바이트', async () => {
    const { inserter, pasted } = quietInserter()
    inserter.dropSession('s1')
    inserter.endSession('s1')
    expect(inserter.trackedSessions()).toBe(0)
    expect(await inserter.insert({ sessionId: 's1', paneId: 'p1', text: '늦은 글' })).toEqual({ ok: false, code: 'skipped', message: '' })
    expect(pasted).toEqual([])
    expect(inserter.trackedSessions()).toBe(0)
  })
  it('세션 수십 번 — 표지는 쌓이지 않는다', async () => {
    const { inserter } = quietInserter()
    for (let index = 0; index < 40; index += 1) {
      const id = `s${index}`
      await inserter.insert({ sessionId: id, paneId: 'p1', text: '글' })
      if (index % 2 === 0) inserter.dropSession(id)
      inserter.endSession(id)
    }
    expect(inserter.trackedSessions()).toBe(0)
  })
})

describe('fix7 R6-1 — ⌘M 가드 배선(production 조립 `createDictationRepeatGuard`): 알림 → 뗀 뒤 반복 막기 → 새 누름 풀림 → 로드 시작 해제', () => {
  type Ipc = { sender: string }
  function wired(input: { recording?: boolean } = {}) {
    const ipc = new EventEmitter()
    const webContents = new EventEmitter()
    const logs: string[] = []
    const guard = createDictationRepeatGuard({ log: (event) => logs.push(event) })
    guard.registerIpc<Ipc>({ ipc: { on: (channel, listener) => ipc.on(channel, listener) }, fromOurWindow: (event) => event.sender === 'ours' })
    guard.attach({
      onDidStartLoading: (listener) => webContents.on('did-start-loading', listener),
      onBeforeInput: (listener) => webContents.on('before-input-event', listener),
      recording: () => input.recording === true,
    })
    const pressKeys = { code: 'KeyM', meta: true, shift: true, control: false, alt: false }
    /** keyDown 하나를 흘리고 막혔나(preventDefault)를 돌려준다. */
    const keyDown = (keys: { code?: string; isAutoRepeat: boolean; meta: boolean; shift: boolean; alt?: boolean; type?: string }): boolean => {
      let prevented = false
      webContents.emit('before-input-event', { preventDefault: () => (prevented = true) }, { type: keys.type ?? 'keyDown', code: keys.code ?? 'KeyM', isAutoRepeat: keys.isAutoRepeat, meta: keys.meta, shift: keys.shift, control: false, alt: keys.alt ?? false })
      return prevented
    }
    return { ipc, webContents, logs, pressKeys, keyDown, press: (sender = 'ours') => ipc.emit(DICTATION_PRESS_KEYS_CHANNEL, { sender }, pressKeys) }
  }
  it('렌더러가 알린 누름 뒤 ⇧ 를 먼저 뗀 ⌘M 반복은 막는다(계속) — 로그를 남긴다', () => {
    const h = wired()
    h.press()
    expect([h.keyDown({ isAutoRepeat: true, meta: true, shift: false }), h.keyDown({ isAutoRepeat: true, meta: true, shift: false })]).toEqual([true, true])
    expect(h.logs).toEqual(['dictation.repeat.swallowed', 'dictation.repeat.swallowed'])
  })
  it('알림이 없으면(받아쓰기 아님) 평소 ⌘M — 첫 누름도 반복도 막지 않는다', () => {
    const h = wired()
    expect([h.keyDown({ isAutoRepeat: false, meta: true, shift: false }), h.keyDown({ isAutoRepeat: true, meta: true, shift: false })]).toEqual([false, false])
  })
  it('다른 창(fromOurWindow 거짓)의 알림은 받지 않는다', () => {
    const h = wired()
    h.press('other')
    expect(h.keyDown({ isAutoRepeat: true, meta: true, shift: false })).toBe(false)
  })
  it('그 글쇠의 새 누름(반복 아님)이 오면 풀린다 — 그 뒤 ⌘M 반복은 평소대로', () => {
    const h = wired()
    h.press()
    expect(h.keyDown({ isAutoRepeat: false, meta: true, shift: false })).toBe(false)
    expect(h.keyDown({ isAutoRepeat: true, meta: true, shift: false })).toBe(false)
  })
  it('새 문서를 싣기 시작하면(did-start-loading) 놓는다', () => {
    const h = wired()
    h.press()
    h.webContents.emit('did-start-loading')
    expect(h.keyDown({ isAutoRepeat: true, meta: true, shift: false })).toBe(false)
  })
  it('단축키 녹화 중·keyUp 은 손대지 않는다', () => {
    const recording = wired({ recording: true })
    recording.press()
    expect(recording.keyDown({ isAutoRepeat: true, meta: true, shift: false })).toBe(false)
    const keyUp = wired()
    keyUp.press()
    expect(keyUp.keyDown({ type: 'keyUp', isAutoRepeat: false, meta: true, shift: false })).toBe(false)
  })
  it('R6-2 — 수식 키를 더한 반복(⌘⇧M 홀드 중 ⌥)은 막지 않는다(홀드가 살아 있다 — 막으면 keyUp 이 사라진다)', () => {
    const h = wired()
    h.press()
    expect(h.keyDown({ isAutoRepeat: true, meta: true, shift: true, alt: true })).toBe(false)
  })
  it('index.ts 가 이 조립을 쓴다 — IPC 한 번·창마다 attach(배선 줄 존재), 옛 직접 배선 없음', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
    expect(source).toContain('const dictationRepeatGuard = createDictationRepeatGuard({')
    expect(source).toContain('dictationRepeatGuard.registerIpc({ ipc: ipcMain, fromOurWindow })')
    expect(source).toContain("onDidStartLoading: (listener) => window?.webContents.on('did-start-loading', listener),")
    expect(source).toContain("onBeforeInput: (listener) => window?.webContents.on('before-input-event', listener),")
    expect(source).toContain('recording: () => shortcutRecording,')
    expect(source).not.toContain('dictationHeld')
    expect(source).not.toContain("'corral:dictationPressKeys'")
  })
})
