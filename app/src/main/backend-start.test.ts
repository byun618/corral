// LIFE-485 K3 — 기동 결정 표 ①~⑩ 전부 + 띄우는 손의 동시 트리거·시한·즉시 종료 (K4ⓕⓖⓗ 의 로직 쪽).
import { describe, expect, it } from 'vitest'
import type { RestoreSummary } from '../shared/types.js'
import { type RunningProbe, BackendStarter, boundSessionName, decideBackend, needsRestoreCount, type BackendInput, type StarterDeps } from './backend-start.js'

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
    scan: 'ok',
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
    isRunning: async () => ((patch.running?.() ?? false) ? { kind: 'running' } : { kind: 'stopped' }),
    spawn: () => ({ ok: true, pid: 4242, logPath: '/log' }),
    logTail: () => 'tail',
    stopChild: async () => true,
    refresh: async () => undefined,
    ownsChild: async () => ({ ours: true, detail: 'ours' }),
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

describe('조회 전·조회 실패 (r2 R2-02)', () => {
  it('첫 조회 전에는 확인 카드도 자동 기동도 없다', () => {
    expect(decideBackend(input({ scan: 'pending', sessions: [] }))).toEqual({ status: { kind: 'ok' }, autostart: false })
    expect(decideBackend(input({ scan: 'pending', restore: three }))).toEqual({ status: { kind: 'ok' }, autostart: false })
  })
  it('조회가 실패해 폴백했으면 멈춤으로 읽지 않는다', () => {
    expect(decideBackend(input({ scan: 'error', sessions: [] }))).toEqual({ status: { kind: 'ok' }, autostart: false })
    expect(decideBackend(input({ scan: 'error', sessions: [], selected: 'default', link: { phase: 'reconnecting', attempt: 3 } }))).toEqual({ status: { kind: 'reconnecting', session: 'default', attempt: 3 }, autostart: false })
  })
  it('실행 파일을 못 찾아 폴백한 것은 그대로 없음 상태', () => {
    expect(decideBackend(input({ scan: 'error', sessions: [], binary: { kind: 'missing', searched: ['a'] } })).status.kind).toBe('missing')
  })
})

describe('낡은 실패 정리 · 시한 초과 자식 (r2 R2-01, grok M1 재현)', () => {
  it('실패 → 늦게 뜬 서버 관측 → 그 서버가 멈춤 → 실패 카드가 아니라 확인(exited)·재개 요약', async () => {
    const starter = new BackendStarter(deps({}))
    await starter.start('auto')
    expect(starter.phase().phase).toBe('failed')
    // ① 실패 상태로 확인 후보를 보면 지금은 실패 카드(옛 동작이 남는 자리)
    expect(decideBackend(input({ starter: starter.phase(), autoStartUsed: true, restore: three })).status.kind).toBe('failed')
    // ② 늦게 뜬 서버에 붙었다 — 관측하면 실패를 걷는다
    expect(decideBackend(input({ starter: starter.phase(), sessions: [runningDefault], selected: 'default', link: { phase: 'live', attempt: 0 } })).status.kind).toBe('ok')
    starter.observeRunning()
    expect(starter.phase()).toEqual({ phase: 'idle' })
    // ③ 그 서버가 멈춤 → 확인(exited) + 재개 3
    expect(decideBackend(input({ starter: starter.phase(), sessions: [stoppedDefault], selected: 'default', link: { phase: 'reconnecting', attempt: 1 }, restore: three, autoStartUsed: true }))).toEqual({
      status: { kind: 'confirm', reason: 'exited', session: 'default', restore: three },
      autostart: false,
    })
    // ④ 아직 안 붙은 상태에서 멈춰도 확인(stopped)·재개 요약 유지
    expect(decideBackend(input({ starter: starter.phase(), restore: three, autoStartUsed: true }))).toEqual({ status: { kind: 'confirm', reason: 'stopped', session: 'default', restore: three }, autostart: false })
  })
  it('observeRunning 은 실패가 아니면 아무것도 바꾸지 않는다', () => {
    const starter = new BackendStarter(deps({}))
    starter.observeRunning()
    expect(starter.phase()).toEqual({ phase: 'idle' })
  })
  it('시한 초과 → 자식 그룹을 끝낸다 · 다시 시도해도 살아 남은 자식이 쌓이지 않는다', async () => {
    const live = new Set<number>()
    let next = 100
    const stopped: number[] = []
    const starter = new BackendStarter(deps({
      spawn: () => { next += 1; live.add(next); return { ok: true, pid: next, logPath: '/l' } },
      stopChild: async (pid) => { stopped.push(pid); live.delete(pid); return true },
    }))
    await starter.start('auto')
    await starter.start('button')
    await starter.start('button')
    expect(starter.spawns()).toBe(3)
    expect(stopped).toEqual([101, 102, 103])
    expect(live.size).toBe(0)
    expect(starter.phase().phase).toBe('failed')
  })
  it('자식을 끝내지 못하면 실패 원문에 적는다', async () => {
    const starter = new BackendStarter(deps({ stopChild: async () => false }))
    await starter.start('auto')
    const phase = starter.phase()
    expect(phase.phase === 'failed' && phase.error).toContain('끝내지 못했다')
  })
})

describe('바인딩 + 조회 전·조회 실패 (r3 R3-01, grok M1)', () => {
  const bound = { bound: 'l485r3bound', sessions: [] }
  it('조회 전에는 지정 세션이 멈췄다고 그리지 않는다', () => {
    expect(decideBackend(input({ ...bound, scan: 'pending' }))).toEqual({ status: { kind: 'ok' }, autostart: false })
  })
  it('조회 실패도 같다 · 재연결 중이면 배너', () => {
    expect(decideBackend(input({ ...bound, scan: 'error' }))).toEqual({ status: { kind: 'ok' }, autostart: false })
    expect(decideBackend(input({ ...bound, scan: 'pending', link: { phase: 'reconnecting', attempt: 2 } }))).toEqual({
      status: { kind: 'reconnecting', session: 'l485r3bound', attempt: 2 },
      autostart: false,
    })
  })
  it('조회 뒤 멈춤이면 그때 지정 세션 카드', () => {
    expect(decideBackend(input({ ...bound, scan: 'ok' })).status).toEqual({ kind: 'bound-stopped', session: 'l485r3bound', reason: 'bound' })
  })
})

describe('조회 오류는 안 돎이 아니다 (r3 R3-02)', () => {
  const probes = (list: Array<RunningProbe | Error>): (() => Promise<RunningProbe>) => {
    let i = 0
    return async () => {
      const next = list[Math.min(i, list.length - 1)]
      i += 1
      if (next === undefined) return { kind: 'stopped' }
      if (next instanceof Error) throw next
      return next
    }
  }
  it('띄우기 직전 조회가 모름이면 띄우지 않고 실패 원문에 오류를 적는다', async () => {
    const starter = new BackendStarter(deps({ isRunning: probes([{ kind: 'unknown', error: 'session list 시한 초과' }]) }))
    await starter.start('button')
    expect(starter.spawns()).toBe(0)
    const phase = starter.phase()
    expect(phase.phase === 'failed' && phase.error).toContain('session list 시한 초과')
  })
  it('조회가 throw 해도 모름으로 읽는다', async () => {
    const starter = new BackendStarter(deps({ isRunning: probes([new Error('boom')]) }))
    await starter.start('button')
    expect(starter.spawns()).toBe(0)
    expect(starter.phase().phase).toBe('failed')
  })
  it('시한 끝 마지막 재조회가 돎이면 ready — 그룹을 끝내지 않는다', async () => {
    const stopped: number[] = []
    // 직전 조회 stopped, 루프 10회 stopped, 마지막 재조회 running
    const list: RunningProbe[] = [{ kind: 'stopped' }, ...Array.from({ length: 10 }, (): RunningProbe => ({ kind: 'stopped' })), { kind: 'running' }]
    const starter = new BackendStarter(deps({ isRunning: probes(list), stopChild: async (pid) => { stopped.push(pid); return true } }))
    await starter.start('auto')
    expect(starter.phase()).toEqual({ phase: 'idle' })
    expect(stopped).toEqual([])
  })
  it('시한 끝 마지막 재조회가 모름이면 죽이지 않고 pid 와 오류를 남긴다', async () => {
    const stopped: number[] = []
    const list: RunningProbe[] = [{ kind: 'stopped' }, ...Array.from({ length: 10 }, (): RunningProbe => ({ kind: 'stopped' })), { kind: 'unknown', error: 'ECONNRESET' }]
    const starter = new BackendStarter(deps({ isRunning: probes(list), stopChild: async (pid) => { stopped.push(pid); return true } }))
    await starter.start('auto')
    expect(stopped).toEqual([])
    const phase = starter.phase()
    expect(phase.phase === 'failed' && phase.error).toContain('pid 4242')
    expect(phase.phase === 'failed' && phase.error).toContain('ECONNRESET')
  })
  it('루프 중 조회 오류는 준비 아님으로 기다리고, 끝에 안 돎이 확인되면 그때만 끝낸다', async () => {
    const stopped: number[] = []
    const list: Array<RunningProbe> = [{ kind: 'stopped' }, { kind: 'unknown', error: 'x' }, { kind: 'stopped' }]
    const starter = new BackendStarter(deps({ isRunning: probes(list), stopChild: async (pid) => { stopped.push(pid); return true } }))
    await starter.start('auto')
    expect(stopped).toEqual([4242])
    expect(starter.phase().phase).toBe('failed')
  })
})

describe('조회 오류 중 실패 카드 · 남긴 자식 · ready 순서 (r4 R4-01·R4-02·R4-05)', () => {
  const starterFailed = { phase: 'failed' as const, error: '서버가 15초 안에 준비되지 않았다\n…프로세스(pid 7000)를 끝내지 않았다', logPath: '/l' }
  it('조회 오류여도 실패 카드(원문·다시 시도)를 낸다', () => {
    expect(decideBackend(input({ scan: 'error', sessions: [], starter: starterFailed })).status).toEqual({ kind: 'failed', session: 'default', error: starterFailed.error, logPath: '/l' })
  })
  it('조회 전이어도 같다', () => {
    expect(decideBackend(input({ scan: 'pending', sessions: [], starter: starterFailed })).status.kind).toBe('failed')
  })
  it('default running 이 관측되면(조회 ok) 기존 규칙대로 실패가 걷힌다', () => {
    expect(decideBackend(input({ scan: 'ok', sessions: [runningDefault], starter: starterFailed })).status.kind).toBe('ok')
  })
  it('grok 재현 순서 — 모름으로 남긴 pid 를 다음 기동이 안 돎 확인 뒤 먼저 끝낸다 · 새 spawn 1', async () => {
    let pid = 6999
    const stopped: number[] = []
    const spawned: number[] = []
    let phase: 'first' | 'second' = 'first'
    let calls = 0
    const starter = new BackendStarter(deps({
      // 1차: 직전 stopped → 루프 stopped… → 마지막 unknown. 2차: 직전 stopped → 바로 running(ready)
      isRunning: async () => {
        calls += 1
        if (phase === 'first') return calls === 1 ? { kind: 'stopped' } : calls <= 11 ? { kind: 'stopped' } : { kind: 'unknown', error: '조회 실패' }
        return calls === 1 ? { kind: 'stopped' } : { kind: 'running' }
      },
      spawn: () => { pid += 1; spawned.push(pid); return { ok: true, pid, logPath: '/l' } },
      stopChild: async (p) => { stopped.push(p); return true },
    }))
    await starter.start('auto')
    expect(stopped).toEqual([])
    expect(starter.phase().phase).toBe('failed')
    phase = 'second'
    calls = 0
    await starter.start('button')
    expect(spawned).toEqual([7000, 7001])
    expect(stopped).toEqual([7000])
    expect(starter.phase()).toEqual({ phase: 'idle' })
  })
  it('다음 기동 직전 조회가 돎이면 남긴 pid 를 끝내지 않는다(그게 뜬 서버일 수 있다)', async () => {
    let calls = 0
    let first = true
    const stopped: number[] = []
    const starter = new BackendStarter(deps({
      isRunning: async () => {
        calls += 1
        if (first) return calls <= 11 ? { kind: 'stopped' } : { kind: 'unknown', error: 'x' }
        return { kind: 'running' }
      },
      stopChild: async (p) => { stopped.push(p); return true },
    }))
    await starter.start('auto')
    first = false
    await starter.start('button')
    expect(stopped).toEqual([])
    expect(starter.spawns()).toBe(1)
  })
  it('ready 는 세션 목록을 먼저 갱신하고 idle 로 간다', async () => {
    const order: string[] = []
    let up = false
    const starter = new BackendStarter(deps({
      running: () => up,
      spawn: () => { up = true; return { ok: true, pid: 1, logPath: '/l' } },
      refresh: async () => { order.push(`refresh:${starter.phase().phase}`) },
      onChange: () => order.push(`change:${starter.phase().phase}`),
    }))
    await starter.start('auto')
    expect(order).toEqual(['change:starting', 'refresh:starting', 'change:idle'])
  })
})

describe('남긴 자식의 생명주기·신원 · 링크 live 우선 (r5 R5-01·R5-02, grok M1·L1 재현)', () => {
  // 1차: 직전 stopped → 루프 10회 stopped → 마지막(12번째) unknown. 2차: 직전 stopped → ready.
  function twoRuns(hooks: { onFinalProbe?: () => void } = {}) {
    let calls = 0
    let second = false
    let exit: ((detail: string) => void) | null = null
    let pid = 4241
    const stopped: number[] = []
    const logs: string[] = []
    const starter = new BackendStarter(deps({
      isRunning: async () => {
        calls += 1
        if (second) return calls === 1 ? { kind: 'stopped' } : { kind: 'running' }
        if (calls === 12) {
          hooks.onFinalProbe?.()
          return { kind: 'unknown', error: '조회 실패' }
        }
        return { kind: 'stopped' }
      },
      spawn: (onExit) => {
        exit = onExit
        pid += 1
        return { ok: true, pid, logPath: '/l' }
      },
      stopChild: async (p) => { stopped.push(p); return true },
      log: (event) => logs.push(event),
    }))
    return {
      starter,
      stopped,
      logs,
      exit: (detail: string) => exit?.(detail),
      second: () => { second = true; calls = 0 },
    }
  }
  it('late-exit — 남긴 자식이 끝나면 잊는다 · 다음 기동이 그 번호를 끝내지 않는다', async () => {
    const run = twoRuns()
    await run.starter.start('auto')
    expect(run.starter.phase().phase).toBe('failed')
    run.exit('code 0 signal null')
    expect(run.logs).toContain('backend.start.leftover_exited')
    run.second()
    await run.starter.start('button')
    expect(run.stopped).toEqual([])
    expect(run.logs).not.toContain('backend.start.leftover_stopped')
  })
  it('exit-during-final-probe — 마지막 조회 도중 끝났으면 남기지 않는다', async () => {
    let fire: () => void = () => undefined
    const run = twoRuns({ onFinalProbe: () => fire() })
    fire = () => run.exit('code 1 signal null')
    await run.starter.start('auto')
    run.second()
    await run.starter.start('button')
    expect(run.stopped).toEqual([])
  })
  it('신원이 다르면(번호 재사용) 끝내지 않고 skip 로그', async () => {
    let calls = 0
    let second = false
    const stopped: number[] = []
    const logs: Array<{ event: string; data: Record<string, unknown> }> = []
    const starter = new BackendStarter(deps({
      isRunning: async () => {
        calls += 1
        if (second) return calls === 1 ? { kind: 'stopped' } : { kind: 'running' }
        return calls === 12 ? { kind: 'unknown', error: 'x' } : { kind: 'stopped' }
      },
      ownsChild: async () => ({ ours: false, detail: '명령 불일치: /usr/bin/other' }),
      stopChild: async (p) => { stopped.push(p); return true },
      log: (event, data) => logs.push({ event, data }),
    }))
    await starter.start('auto')
    second = true
    calls = 0
    await starter.start('button')
    expect(stopped).toEqual([])
    expect(logs.find((entry) => entry.event === 'backend.start.leftover_skipped')?.data).toMatchObject({ pid: 4242, detail: '명령 불일치: /usr/bin/other' })
  })
  it('신원이 맞고 살아 있으면 기존대로 끝낸다(F13 유지)', async () => {
    const run = twoRuns()
    await run.starter.start('auto')
    run.second()
    await run.starter.start('button')
    expect(run.stopped).toEqual([4242])
  })
  it('조회 오류여도 링크가 live 면 실패 카드보다 ok', () => {
    const starterFailed = { phase: 'failed' as const, error: 'e', logPath: null }
    expect(decideBackend(input({ scan: 'error', sessions: [runningDefault], selected: 'default', link: { phase: 'live', attempt: 0 }, starter: starterFailed })).status).toEqual({ kind: 'ok' })
    expect(decideBackend(input({ scan: 'error', sessions: [runningDefault], selected: 'default', link: { phase: 'reconnecting', attempt: 1 }, starter: starterFailed })).status.kind).toBe('failed')
  })
})

describe('시한 끝 안 돎 분기의 exited 가드 (r6 R6-01)', () => {
  it('마지막 조회 도중 자식이 끝났으면 stopChild 를 부르지 않는다', async () => {
    let calls = 0
    let exit: ((detail: string) => void) | null = null
    const stopped: number[] = []
    const starter = new BackendStarter(deps({
      // 직전 1 + 루프 10 = stopped, 마지막(12번째) 조회 도중 exit → stopped
      isRunning: async () => {
        calls += 1
        if (calls === 12) exit?.('code 1 signal null')
        return { kind: 'stopped' }
      },
      spawn: (onExit) => {
        exit = onExit
        return { ok: true, pid: 4242, logPath: '/l' }
      },
      stopChild: async (pid) => { stopped.push(pid); return true },
    }))
    await starter.start('auto')
    expect(stopped).toEqual([])
    const phase = starter.phase()
    expect(phase.phase).toBe('failed')
    expect(phase.phase === 'failed' && phase.error).not.toContain('끝내지 못했다')
  })
})
