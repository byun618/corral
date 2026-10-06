// LIFE-485 K3 — 기동 결정 표 ①~⑩ 전부 + 띄우는 손의 동시 트리거·시한·즉시 종료 (K4ⓕⓖⓗ 의 로직 쪽).
import { describe, expect, it } from 'vitest'
import type { RestoreSummary } from '../shared/types.js'
import { BackendStarter, boundSessionName, decideBackend, needsRestoreCount, type BackendInput, type StarterDeps } from './backend-start.js'

const zero: RestoreSummary = { known: true, total: 0, agents: [] }
const three: RestoreSummary = { known: true, total: 3, agents: [{ kind: 'claude', count: 1 }, { kind: 'grok', count: 2 }] }
const unknown: RestoreSummary = { known: false, reason: 'workspace 0 구조를 모른다' }

const stoppedDefault = { name: 'default', isDefault: true, running: false }
const runningDefault = { name: 'default', isDefault: true, running: true }

function input(patch: Partial<BackendInput>): BackendInput {
  return {
    bound: null,
    binary: { kind: 'found' },
    sessions: [stoppedDefault],
    selected: null,
    link: { phase: 'idle', attempt: 0 },
    restore: zero,
    starter: { phase: 'idle' },
    autoStartUsed: false,
    ...patch,
  }
}

describe('decideBackend (K3)', () => {
  it('① 바인딩 세션이 멈춤 → 띄우지 않음 + 지정 세션 꺼짐', () => {
    const decision = decideBackend(input({ bound: 'life417-native', sessions: [stoppedDefault, { name: 'life417-native', isDefault: false, running: false }] }))
    expect(decision).toEqual({ status: { kind: 'bound-stopped', session: 'life417-native', reason: 'bound' }, autostart: false })
  })
  it('① 바인딩 세션이 목록에 없음 → 띄우지 않음', () => {
    expect(decideBackend(input({ bound: 'x' })).autostart).toBe(false)
    expect(decideBackend(input({ bound: 'x' })).status.kind).toBe('bound-stopped')
  })
  it('① 바인딩 + default 멈춤 + 재개 0 이어도 default 를 띄우지 않는다', () => {
    expect(decideBackend(input({ bound: 's', sessions: [stoppedDefault, { name: 's', isDefault: false, running: false }], restore: zero })).autostart).toBe(false)
  })
  it('② default 돌아감 → 붙음(기동 없음)', () => {
    expect(decideBackend(input({ sessions: [runningDefault] }))).toEqual({ status: { kind: 'ok' }, autostart: false })
  })
  it('③ default 멈춤 + 다른 세션 돌아감 → 기존 규칙(기동 없음)', () => {
    expect(decideBackend(input({ sessions: [stoppedDefault, { name: 'other', isDefault: false, running: true }] }))).toEqual({ status: { kind: 'ok' }, autostart: false })
  })
  it('④ 전부 멈춤 · 재개 0 → 자동 기동', () => {
    expect(decideBackend(input({}))).toEqual({ status: { kind: 'starting', session: 'default' }, autostart: true })
  })
  it('④ 세션이 하나도 없어도(새 설치) 재개 0 이면 자동 기동', () => {
    expect(decideBackend(input({ sessions: [] })).autostart).toBe(true)
  })
  it('⑤ 재개 ≥1 → 확인', () => {
    expect(decideBackend(input({ restore: three }))).toEqual({ status: { kind: 'confirm', reason: 'stopped', session: 'default', restore: three }, autostart: false })
  })
  it('⑥ 계수 모름 → 확인', () => {
    expect(decideBackend(input({ restore: unknown }))).toEqual({ status: { kind: 'confirm', reason: 'stopped', session: 'default', restore: unknown }, autostart: false })
  })
  it('⑥ 계수를 하지 않았으면(null) 모름으로 → 확인', () => {
    const decision = decideBackend(input({ restore: null }))
    expect(decision.autostart).toBe(false)
    expect(decision.status.kind).toBe('confirm')
  })
  it('⑦ herdr 해소 실패 → 없음 상태', () => {
    expect(decideBackend(input({ binary: { kind: 'missing', searched: ['a', 'b'] } }))).toEqual({ status: { kind: 'missing', searched: ['a', 'b'] }, autostart: false })
  })
  it('⑦ 해소 실패여도 돌고 있는 세션(파일시스템 폴백)이 있으면 붙는다', () => {
    expect(decideBackend(input({ binary: { kind: 'missing', searched: [] }, sessions: [runningDefault] })).status.kind).toBe('ok')
  })
  it('⑧ 연결 도중 멈춤 → 자동 재기동 없음(확인)', () => {
    const decision = decideBackend(input({ selected: 'default', link: { phase: 'reconnecting', attempt: 4 }, restore: zero }))
    expect(decision).toEqual({ status: { kind: 'confirm', reason: 'exited', session: 'default', restore: zero }, autostart: false })
  })
  it('⑧ 연결 도중 멈춘 세션이 default 가 아니면 안내만', () => {
    const decision = decideBackend(input({ selected: 'other', sessions: [stoppedDefault, { name: 'other', isDefault: false, running: false }], link: { phase: 'reconnecting', attempt: 1 } }))
    expect(decision).toEqual({ status: { kind: 'bound-stopped', session: 'other', reason: 'attached' }, autostart: false })
  })
  it('⑨ 자동 기동은 앱 수명에서 1회 — 이미 했으면 확인', () => {
    expect(decideBackend(input({ autoStartUsed: true }))).toEqual({ status: { kind: 'confirm', reason: 'stopped', session: 'default', restore: zero }, autostart: false })
  })
  it('⑩ 측정 하네스(CORRAL_BACKEND_SOCKET+CORRAL_SESSION) → 어떤 경우에도 띄우지 않는다', () => {
    for (const restore of [zero, three, unknown, null]) {
      for (const sessions of [[], [stoppedDefault], [{ name: 'l485', isDefault: false, running: false }]]) {
        expect(decideBackend(input({ bound: 'l485', restore, sessions, autoStartUsed: false })).autostart).toBe(false)
      }
    }
  })
  it('재연결 중 — 서버는 돌고 링크만 재시도', () => {
    expect(decideBackend(input({ selected: 'default', sessions: [runningDefault], link: { phase: 'reconnecting', attempt: 2 } }))).toEqual({ status: { kind: 'reconnecting', session: 'default', attempt: 2 }, autostart: false })
  })
  it('시작 중·시작 실패', () => {
    expect(decideBackend(input({ starter: { phase: 'starting' } }))).toEqual({ status: { kind: 'starting', session: 'default' }, autostart: false })
    expect(decideBackend(input({ starter: { phase: 'failed', error: 'boom', logPath: '/l' }, autoStartUsed: true }))).toEqual({ status: { kind: 'failed', session: 'default', error: 'boom', logPath: '/l' }, autostart: false })
  })
  it('실패 뒤 사용자가 직접 띄워 세션이 돌면 카드가 사라진다', () => {
    expect(decideBackend(input({ starter: { phase: 'failed', error: 'boom', logPath: null }, sessions: [runningDefault] })).status.kind).toBe('ok')
  })
  it('해소 중에는 아무것도 하지 않는다', () => {
    expect(decideBackend(input({ binary: { kind: 'resolving' } }))).toEqual({ status: { kind: 'ok' }, autostart: false })
  })
})

function deps(patch: Partial<StarterDeps> & { running?: () => boolean }): StarterDeps {
  let clock = 0
  const base: StarterDeps = {
    isRunning: async () => patch.running?.() ?? false,
    spawn: () => ({ ok: true, pid: 4242, logPath: '/log' }),
    logTail: () => 'tail',
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    readyTimeoutMs: 1000,
    pollMs: 100,
    onChange: () => undefined,
    log: () => undefined,
  }
  return { ...base, ...patch }
}

describe('boundSessionName·needsRestoreCount (r1 R1-06·R1-05)', () => {
  it('바인딩은 세션 이름 기준 — 소켓만으로는 이름을 만들지 않는다', () => {
    expect(boundSessionName({ CORRAL_SESSION: 'l485' })).toBe('l485')
    expect(boundSessionName({ CORRAL_SESSION: '' })).toBe(null)
    expect(boundSessionName({})).toBe(null)
  })
  it('default 에 붙어 live 인 평시에는 세지 않는다', () => {
    expect(needsRestoreCount({ bound: null, sessions: [runningDefault], selected: 'default' })).toBe(false)
  })
  it('default 멈춤 + 붙어 있던 것이 default → 센다(도중 종료 카드)', () => {
    expect(needsRestoreCount({ bound: null, sessions: [stoppedDefault], selected: 'default' })).toBe(true)
  })
  it('default 멈춤 + 돌고 있는 다른 세션에 붙음 → 세지 않는다', () => {
    expect(needsRestoreCount({ bound: null, sessions: [stoppedDefault, { name: 'o', isDefault: false, running: true }], selected: 'o' })).toBe(false)
  })
  it('아무것도 안 돌고 아직 안 붙음 → 센다', () => {
    expect(needsRestoreCount({ bound: null, sessions: [stoppedDefault], selected: null })).toBe(true)
    expect(needsRestoreCount({ bound: null, sessions: [], selected: null })).toBe(true)
  })
  it('바인딩이면 세지 않는다', () => {
    expect(needsRestoreCount({ bound: 's', sessions: [stoppedDefault], selected: null })).toBe(false)
  })
})

describe('BackendStarter (K4ⓕⓖⓗ 로직)', () => {
  it('즉시 종료했지만 그새 서버가 돌고 있으면(경합에 짐) 실패가 아니다 (r1 R1-10)', async () => {
    let checks = 0
    const starter = new BackendStarter(deps({
      // 띄우기 직전 조회는 멈춤, 종료 뒤 재조회는 돎
      running: () => { checks += 1; return checks > 1 },
      spawn: (onExit) => { onExit('code 1 signal null'); return { ok: true, pid: 1, logPath: '/l' } },
      logTail: () => 'error: herdr server is already running',
    }))
    await starter.start('auto')
    expect(starter.phase()).toEqual({ phase: 'idle' })
  })
  it('동시 트리거(자동 + 버튼 + 연타) → spawn 1회', async () => {
    let up = false
    let spawned = 0
    const starter = new BackendStarter(deps({
      running: () => up,
      spawn: () => {
        spawned += 1
        up = true
        return { ok: true, pid: 1, logPath: '/log' }
      },
    }))
    await Promise.all([starter.start('auto'), starter.start('button'), starter.start('button'), starter.start('button')])
    expect(spawned).toBe(1)
    expect(starter.spawns()).toBe(1)
    expect(starter.phase()).toEqual({ phase: 'idle' })
    expect(starter.autoStartUsed()).toBe(true)
  })
  it('이미 돌고 있으면 띄우지 않는다', async () => {
    let spawned = 0
    const starter = new BackendStarter(deps({ running: () => true, spawn: () => { spawned += 1; return { ok: true, pid: 1, logPath: '/l' } } }))
    await starter.start('button')
    expect(spawned).toBe(0)
  })
  it('spawn 실패 → failed + 원문', async () => {
    const starter = new BackendStarter(deps({ spawn: () => ({ ok: false, error: 'ENOENT', logPath: '/l' }) }))
    await starter.start('auto')
    expect(starter.phase()).toEqual({ phase: 'failed', error: 'ENOENT', logPath: '/l' })
  })
  it('즉시 종료 → failed + 로그 끝부분', async () => {
    const starter = new BackendStarter(deps({ spawn: (onExit) => { onExit('code 1 signal null'); return { ok: true, pid: 1, logPath: '/l' } }, logTail: () => 'error: herdr server is already running' }))
    await starter.start('button')
    const phase = starter.phase()
    expect(phase.phase).toBe('failed')
    if (phase.phase === 'failed') expect(phase.error).toContain('already running')
  })
  it('시한 초과 → failed (상수 시한)', async () => {
    const starter = new BackendStarter(deps({}))
    await starter.start('auto')
    const phase = starter.phase()
    expect(phase.phase).toBe('failed')
    if (phase.phase === 'failed') expect(phase.error).toContain('1초')
  })
  it('실패 뒤 다시 시도 → 새 spawn', async () => {
    let up = false
    let calls = 0
    const starter = new BackendStarter(deps({
      running: () => up,
      spawn: () => {
        calls += 1
        if (calls === 1) return { ok: false, error: 'first', logPath: null }
        up = true
        return { ok: true, pid: 2, logPath: '/l' }
      },
    }))
    await starter.start('auto')
    expect(starter.phase().phase).toBe('failed')
    await starter.start('button')
    expect(starter.phase()).toEqual({ phase: 'idle' })
    expect(calls).toBe(2)
  })
})
