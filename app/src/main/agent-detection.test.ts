// LIFE-520 K1ⓓ·K3 — 감지 단위 시험. 파싱·거름·폴백 순서는 실제 임시 파일, 시간 초과는 실제 셸 스크립트(손주 포함 kill),
// 캐시·새로고침·합치기·옛 실행 무시는 가짜 probe(spawn 횟수를 센다).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAgentDetection, type AgentDetectionSnapshot } from '../shared/agent-detection.js'
import {
  AgentDetector,
  fallbackAgentDirs,
  isExecutableFile,
  parseMarkedValue,
  probeLoginShellPath,
  registerAgentDetectionIpc,
  resolveDetectedAgents,
  shellPathDirs,
  type ShellProbe,
} from './agent-detection.js'

const MARK = '__CORRAL_AGENT_PATH__'

let tmp = ''
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l520-')))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const exe = (file: string, body = '#!/bin/sh\nexit 0\n'): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

describe('구분자 파싱 (K1ⓓ)', () => {
  it('앞뒤 rc 잡음·배너는 버린다', () => {
    expect(parseMarkedValue(`Last login: Thu\n\u001b[1mwelcome\u001b[0m\n${MARK}/a:/b${MARK}\nbye from .zlogout\n`)).toBe('/a:/b')
  })
  it('구분자가 없거나 하나뿐이면 null', () => {
    expect(parseMarkedValue('/usr/bin:/bin')).toBeNull()
    expect(parseMarkedValue(`${MARK}/usr/bin`)).toBeNull()
  })
  it('빈 값(공백만)은 null', () => {
    expect(parseMarkedValue(`${MARK}${MARK}`)).toBeNull()
    expect(parseMarkedValue(`${MARK}  \n${MARK}`)).toBeNull()
  })
  it('PATH 폴더 — 상대경로·빈 칸은 버린다', () => {
    expect(shellPathDirs('/a::bin:./x:/b/c:')).toEqual(['/a', '/b/c'])
  })
})

describe('실행 파일 거름·폴백 순서 (K1ⓓ)', () => {
  it('실행 불가 파일·디렉터리는 거른다, 실행 가능한 일반 파일만', () => {
    const plain = path.join(tmp, 'plain', 'claude')
    fs.mkdirSync(path.dirname(plain), { recursive: true })
    fs.writeFileSync(plain, 'x', { mode: 0o644 })
    fs.mkdirSync(path.join(tmp, 'dir', 'claude'), { recursive: true })
    const ok = exe(path.join(tmp, 'ok', 'claude'))
    expect(isExecutableFile(plain)).toBe(false)
    expect(isExecutableFile(path.join(tmp, 'dir', 'claude'))).toBe(false)
    expect(isExecutableFile(ok)).toBe(true)
    const found = resolveDetectedAgents({ shellDirs: [path.join(tmp, 'plain'), path.join(tmp, 'dir'), path.join(tmp, 'ok')], fallbackDirs: [], isExecutable: isExecutableFile })
    expect(found).toEqual([{ agent: 'claude', path: ok, source: 'login-shell' }])
  })
  it('셸 PATH 가 먼저, 거기 없는 에이전트만 폴백 — 출처가 갈린다', () => {
    const shellDir = path.join(tmp, 'shell')
    exe(path.join(shellDir, 'claude'))
    exe(path.join(tmp, 'fb1', 'claude'))
    exe(path.join(tmp, 'fb2', 'grok'))
    exe(path.join(tmp, 'fb1', 'grok'))
    const found = resolveDetectedAgents({ shellDirs: [shellDir], fallbackDirs: [path.join(tmp, 'fb1'), path.join(tmp, 'fb2')], isExecutable: isExecutableFile })
    expect(found).toEqual([
      { agent: 'claude', path: path.join(shellDir, 'claude'), source: 'login-shell' },
      { agent: 'grok', path: path.join(tmp, 'fb1', 'grok'), source: 'fallback' },
    ])
  })
  it('폴백 폴더 순서 — ~/.grok/bin(fix1 R1-02) · ~/.local/bin · ~/.claude/local · brew · /usr/local · npm-global · bun · volta · nvm(새 버전 먼저)', () => {
    const home = '/h'
    const dirs = fallbackAgentDirs({ home, listDir: (dir) => (dir === '/h/.nvm/versions/node' ? ['v9.0.0', 'v24.14.1', 'v20.1.0', '.DS_Store'] : []) })
    expect(dirs).toEqual([
      '/h/.grok/bin',
      '/h/.local/bin',
      '/h/.claude/local',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/h/.npm-global/bin',
      '/h/.bun/bin',
      '/h/.volta/bin',
      '/h/.nvm/versions/node/v24.14.1/bin',
      '/h/.nvm/versions/node/v20.1.0/bin',
      '/h/.nvm/versions/node/v9.0.0/bin',
    ])
  })
  it('결과는 카탈로그 순서(claude → codex → grok)', () => {
    const dir = path.join(tmp, 'all')
    for (const name of ['grok', 'codex', 'claude']) exe(path.join(dir, name))
    expect(resolveDetectedAgents({ shellDirs: [], fallbackDirs: [dir], isExecutable: isExecutableFile }).map((found) => found.agent)).toEqual(['claude', 'codex', 'grok'])
  })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitDead = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

describe('로그인 셸 실행 (K1ⓓ 시간 초과 · 실제 프로세스)', () => {
  it('정상 — 구분자 사이 PATH, stdin 은 닫혀 있다(read 가 바로 EOF)', async () => {
    const shell = exe(path.join(tmp, 'shell-ok'), `#!/bin/sh\nread line\necho "banner"\nprintf '${MARK}%s${MARK}' "/p1:/p2"\necho trailing\n`)
    const probe = await probeLoginShellPath({ shell, timeoutMs: 5_000, env: {} })
    expect(probe).toEqual({ outcome: { ok: true }, pathValue: '/p1:/p2' })
  })
  it('즉시 실패 — exit, 구분자 없이 exit 0 — no-marker', async () => {
    const failing = exe(path.join(tmp, 'shell-fail'), '#!/bin/sh\nexit 3\n')
    expect(await probeLoginShellPath({ shell: failing, timeoutMs: 5_000, env: {} })).toEqual({ outcome: { ok: false, reason: 'exit' }, pathValue: null })
    const silent = exe(path.join(tmp, 'shell-silent'), '#!/bin/sh\necho hello\n')
    expect(await probeLoginShellPath({ shell: silent, timeoutMs: 5_000, env: {} })).toEqual({ outcome: { ok: false, reason: 'no-marker' }, pathValue: null })
  })
  it('없는 셸 — spawn-error', async () => {
    expect(await probeLoginShellPath({ shell: path.join(tmp, 'nope'), timeoutMs: 5_000, env: {} })).toEqual({ outcome: { ok: false, reason: 'spawn-error' }, pathValue: null })
  })
  it('시간 초과 — 시한 + 2초 안에 끝나고 셸과 손주가 둘 다 죽는다', async () => {
    const pids = path.join(tmp, 'pids')
    const shell = exe(path.join(tmp, 'shell-hang'), `#!/bin/sh\nsleep 60 &\necho "$$ $!" > '${pids}'\nwait\n`)
    const started = Date.now()
    // 시한 3초 — 전량 실행 부하에서 500ms 는 sh 가 pid 파일을 쓰기도 전에 끝났다(w-3). 손주까지 뜬 뒤에 시한이 오게 넉넉히.
    const timeoutMs = 3_000
    const probe = await probeLoginShellPath({ shell, timeoutMs, env: {} })
    const elapsed = Date.now() - started
    expect(probe).toEqual({ outcome: { ok: false, reason: 'timeout' }, pathValue: null })
    expect(elapsed).toBeLessThan(timeoutMs + 2_000)
    const [shellPid, grandchildPid] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number)
    expect(shellPid).toBeGreaterThan(0)
    expect(grandchildPid).toBeGreaterThan(0)
    expect(await waitDead(shellPid ?? 0)).toBe(true)
    expect(await waitDead(grandchildPid ?? 0)).toBe(true)
  }, 15_000)
  it('env 에 DISABLE_AUTO_UPDATE 를 얹지만 넘긴 env 객체는 바꾸지 않는다', async () => {
    const shell = exe(path.join(tmp, 'shell-env'), `#!/bin/sh\nprintf '${MARK}%s${MARK}' "$DISABLE_AUTO_UPDATE"\n`)
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
    expect(await probeLoginShellPath({ shell, timeoutMs: 5_000, env })).toEqual({ outcome: { ok: true }, pathValue: 'true' })
    expect(env).toEqual({ PATH: '/usr/bin:/bin' })
  })
})

// ── K3 캐시·새로고침 — 가짜 probe 가 spawn 횟수를 센다 ──

type Deferred = { resolve: (probe: ShellProbe) => void; signal: AbortSignal }
/**
 * 가짜 probe — spawn 횟수와 「지금 살아 있는 셸」 수를 센다. 실제 probe 처럼 signal 이 끊기면 그 자리에서 `aborted` 로 끝난다(셸 그룹 kill).
 */
function harness(): { detector: AgentDetector; spawns: () => number; live: () => number; maxLive: () => number; pending: Deferred[]; changes: AgentDetectionSnapshot[] } {
  const pending: Deferred[] = []
  const changes: AgentDetectionSnapshot[] = []
  let count = 0
  let live = 0
  let maxLive = 0
  const detector = new AgentDetector({
    probe: (signal) => {
      count += 1
      live += 1
      maxLive = Math.max(maxLive, live)
      return new Promise((resolve) => {
        let done = false
        const end = (probe: ShellProbe): void => {
          if (done) return
          done = true
          live -= 1
          resolve(probe)
        }
        signal.addEventListener('abort', () => end({ outcome: { ok: false, reason: 'aborted' }, pathValue: null }), { once: true })
        pending.push({ resolve: end, signal })
      })
    },
    fallbackDirs: () => ['/fb'],
    isExecutable: (file) => file === '/sh/claude' || file === '/fb/grok' || file === '/new/codex',
    now: () => 0,
    onChange: (snapshot) => changes.push(snapshot),
    log: () => {},
  })
  return { detector, spawns: () => count, live: () => live, maxLive: () => maxLive, pending, changes }
}
const okProbe = (pathValue: string): ShellProbe => ({ outcome: { ok: true }, pathValue })
const timeoutProbe: ShellProbe = { outcome: { ok: false, reason: 'timeout' }, pathValue: null }
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const agentsOf = (snapshot: AgentDetectionSnapshot): string[] => (snapshot.kind === 'detected' ? snapshot.agents.map((found) => `${found.agent}:${found.source}`) : ['unknown'])

describe('캐시·새로고침·실패 비고정 (K3)', () => {
  it('감지 전은 unknown(Ⓟ)', () => {
    expect(harness().detector.current()).toEqual({ kind: 'unknown' })
  })
  it('ⓐ 성공 결과 재요청은 셸을 다시 띄우지 않는다', async () => {
    const h = harness()
    const first = h.detector.ensure()
    h.pending[0]?.resolve(okProbe('/sh'))
    expect(agentsOf(await first)).toEqual(['claude:login-shell', 'grok:fallback'])
    await h.detector.ensure()
    await h.detector.ensure()
    expect(h.spawns()).toBe(1)
  })
  it('ⓑ 새로고침은 다시 띄운다', async () => {
    const h = harness()
    const first = h.detector.ensure()
    h.pending[0]?.resolve(okProbe('/sh'))
    await first
    const again = h.detector.refresh()
    expect(h.spawns()).toBe(2)
    h.pending[1]?.resolve(okProbe('/new'))
    expect(agentsOf(await again)).toEqual(['codex:login-shell', 'grok:fallback'])
    expect(agentsOf(h.detector.current())).toEqual(['codex:login-shell', 'grok:fallback'])
  })
  it('ⓒ 실패(시간 초과)는 결과(폴백)를 보이되 캐시하지 않는다 — 다음 요청이 다시 돈다', async () => {
    const h = harness()
    const first = h.detector.ensure()
    h.pending[0]?.resolve(timeoutProbe)
    const snapshot = await first
    expect(snapshot.kind === 'detected' ? snapshot.shell : null).toEqual({ ok: false, reason: 'timeout' })
    expect(agentsOf(snapshot)).toEqual(['grok:fallback'])
    const second = h.detector.ensure()
    expect(h.spawns()).toBe(2)
    h.pending[1]?.resolve(okProbe('/sh'))
    expect(agentsOf(await second)).toEqual(['claude:login-shell', 'grok:fallback'])
    await h.detector.ensure()
    expect(h.spawns()).toBe(2)
  })
  it('ⓒ 예외(예상 밖 오류)도 캐시하지 않고 결과를 바꾸지 않는다 — 감지 전이면 unknown 그대로', async () => {
    let count = 0
    const detector = new AgentDetector({
      probe: () => {
        count += 1
        return Promise.reject(new Error('boom'))
      },
      fallbackDirs: () => [],
      isExecutable: () => false,
      now: () => 0,
      onChange: () => {},
      log: () => {},
    })
    expect(await detector.ensure()).toEqual({ kind: 'unknown' })
    expect(await detector.ensure()).toEqual({ kind: 'unknown' })
    expect(count).toBe(2)
  })
  it('ⓓ 동시 요청은 실행 하나로 합쳐진다', async () => {
    const h = harness()
    const calls = [h.detector.ensure(), h.detector.ensure(), h.detector.ensure()]
    expect(h.spawns()).toBe(1)
    h.pending[0]?.resolve(okProbe('/sh'))
    const results = await Promise.all(calls)
    expect(results.map(agentsOf)).toEqual([0, 1, 2].map(() => ['claude:login-shell', 'grok:fallback']))
    expect(h.changes).toHaveLength(1)
  })
  it('ⓔ 늦게 끝난 옛 실행이 새로고침 결과를 덮지 않는다', async () => {
    const h = harness()
    const old = h.detector.ensure()
    const fresh = h.detector.refresh()
    expect(h.spawns()).toBe(2)
    h.pending[1]?.resolve(okProbe('/new'))
    expect(agentsOf(await fresh)).toEqual(['codex:login-shell', 'grok:fallback'])
    h.pending[0]?.resolve(okProbe('/sh'))
    await flush()
    // 옛 실행을 기다리던 쪽도 새 결과를 받는다.
    expect(agentsOf(await old)).toEqual(['codex:login-shell', 'grok:fallback'])
    expect(agentsOf(h.detector.current())).toEqual(['codex:login-shell', 'grok:fallback'])
    expect(h.changes.map(agentsOf)).toEqual([['codex:login-shell', 'grok:fallback']])
  })
  it('0개 완료(Ⓩ)는 unknown(Ⓟ)과 다른 값이다', async () => {
    const detector = new AgentDetector({
      probe: () => Promise.resolve(timeoutProbe),
      fallbackDirs: () => [],
      isExecutable: () => false,
      now: () => 7,
      onChange: () => {},
      log: () => {},
    })
    const snapshot = await detector.ensure()
    expect(snapshot).toEqual({ kind: 'detected', agents: [], shell: { ok: false, reason: 'timeout' }, at: 7 })
    expect(snapshot).not.toEqual({ kind: 'unknown' })
  })
})

// ── fix1 — K3ⓕ 프로덕션 재시도(IPC 처리 함수 단) · ⓖ 중첩 새로고침 · ⓗ 종료 정리 ──

/** 가짜 ipcMain.handle — 등록된 처리 함수를 채널로 꺼내 부른다. */
function fakeIpc(detector: AgentDetector, allowed = true): { invoke: (channel: string) => unknown } {
  const handlers = new Map<string, (event: { from: string }) => unknown>()
  registerAgentDetectionIpc<{ from: string }>({
    handle: (channel, listener) => handlers.set(channel, listener),
    allowed: () => allowed,
    detector: () => detector,
  })
  return {
    invoke: (channel) => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`처리 함수 없음 ${channel}`)
      return handler({ from: 'test' })
    },
  }
}

describe('fix1 — 재시도·중첩·종료 (K3ⓕⓖⓗ)', () => {
  it('ⓕ 기동 감지가 셸 실패면, 렌더러 조회(IPC get)가 셸을 다시 띄운다 — 성공 뒤 조회는 다시 안 띄운다', async () => {
    const h = harness()
    const ipc = fakeIpc(h.detector)
    const boot = h.detector.ensure()
    h.pending[0]?.resolve(timeoutProbe)
    await boot
    expect(h.spawns()).toBe(1)
    // 렌더러가 조회 — 지금 스냅숏(폴백 결과)을 바로 받고, 뒤에서 셸이 다시 뜬다.
    expect(agentsOf(readAgentDetection(ipc.invoke('corral:agentDetectionGet')))).toEqual(['grok:fallback'])
    expect(h.spawns()).toBe(2)
    // 진행 중 조회가 겹쳐도 셸은 늘지 않는다(합치기).
    ipc.invoke('corral:agentDetectionGet')
    expect(h.spawns()).toBe(2)
    h.pending[1]?.resolve(okProbe('/sh'))
    await flush()
    expect(agentsOf(readAgentDetection(ipc.invoke('corral:agentDetectionGet')))).toEqual(['claude:login-shell', 'grok:fallback'])
    expect(h.spawns()).toBe(2)
  })
  it('ⓕ 감지 전(Ⓟ) 조회도 감지를 건다 · 다른 창 요청은 null 이고 셸을 띄우지 않는다', async () => {
    const h = harness()
    expect(fakeIpc(h.detector, false).invoke('corral:agentDetectionGet')).toBeNull()
    expect(fakeIpc(h.detector, false).invoke('corral:agentDetectionRefresh')).toBeNull()
    expect(h.spawns()).toBe(0)
    expect(fakeIpc(h.detector).invoke('corral:agentDetectionGet')).toEqual({ kind: 'unknown' })
    expect(h.spawns()).toBe(1)
  })
  it('ⓕ IPC refresh 는 끝난 스냅숏을 돌려준다', async () => {
    const h = harness()
    const pending = fakeIpc(h.detector).invoke('corral:agentDetectionRefresh')
    h.pending[0]?.resolve(okProbe('/new'))
    expect(agentsOf(readAgentDetection(await Promise.resolve(pending)))).toEqual(['codex:login-shell', 'grok:fallback'])
  })
  it('ⓖ 진행 중에 새로고침이 겹쳐도 동시에 사는 셸은 하나 — 옛 셸은 끊긴다(aborted)', async () => {
    const h = harness()
    void h.detector.ensure()
    void h.detector.refresh()
    void h.detector.refresh()
    const last = h.detector.refresh()
    expect(h.spawns()).toBe(4)
    expect(h.live()).toBe(1)
    expect(h.maxLive()).toBe(1) // 옛 셸을 먼저 끊고 새 셸을 띄운다 — 한순간도 둘이 아니다
    expect(h.pending.slice(0, 3).map((entry) => entry.signal.aborted)).toEqual([true, true, true])
    h.pending[3]?.resolve(okProbe('/sh'))
    expect(agentsOf(await last)).toEqual(['claude:login-shell', 'grok:fallback'])
    expect(h.live()).toBe(0)
  })
  it('ⓗ 앱 종료(killAll) — 진행 중 셸을 끊고, 이후 조회·새로고침은 셸을 띄우지 않는다', async () => {
    const h = harness()
    void h.detector.ensure()
    expect(h.live()).toBe(1)
    h.detector.killAll()
    expect(h.live()).toBe(0)
    expect(h.pending[0]?.signal.aborted).toBe(true)
    await flush()
    expect(h.detector.current()).toEqual({ kind: 'unknown' })
    h.detector.get()
    await h.detector.refresh()
    await h.detector.ensure()
    expect(h.spawns()).toBe(1)
    expect(h.changes).toEqual([])
  })
})

describe('fix1 — 실제 셸 abort (K3ⓖⓗ 의 셸 단)', () => {
  it('signal 이 끊기면 시한 전이라도 셸과 손주가 둘 다 죽고 aborted', async () => {
    const pids = path.join(tmp, 'pids-abort')
    const shell = exe(path.join(tmp, 'shell-abort'), `#!/bin/sh\nsleep 60 &\necho "$$ $!" > '${pids}'\nwait\n`)
    const controller = new AbortController()
    const pending = probeLoginShellPath({ shell, timeoutMs: 30_000, env: {}, signal: controller.signal })
    for (let i = 0; i < 100 && !fs.existsSync(pids); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    controller.abort()
    expect(await pending).toEqual({ outcome: { ok: false, reason: 'aborted' }, pathValue: null })
    expect(Date.now() - started).toBeLessThan(2_000)
    const [shellPid, grandchildPid] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number)
    expect(await waitDead(shellPid ?? 0)).toBe(true)
    expect(await waitDead(grandchildPid ?? 0)).toBe(true)
  }, 15_000)
  it('이미 끊긴 signal 이면 셸을 띄우지 않는다', async () => {
    const marker = path.join(tmp, 'spawned')
    const shell = exe(path.join(tmp, 'shell-never'), `#!/bin/sh\ntouch '${marker}'\n`)
    const controller = new AbortController()
    controller.abort()
    expect(await probeLoginShellPath({ shell, timeoutMs: 5_000, env: {}, signal: controller.signal })).toEqual({ outcome: { ok: false, reason: 'aborted' }, pathValue: null })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe('fix1 — 폴백에서 grok 은 실물 ~/.grok/bin (R1-02)', () => {
  it('~/.local/bin/grok 심링크와 ~/.grok/bin/grok 실물이 둘 다 있으면 ~/.grok/bin/grok', () => {
    const home = path.join(tmp, 'home')
    const real = exe(path.join(home, '.grok', 'bin', 'grok'))
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
    fs.symlinkSync(real, path.join(home, '.local', 'bin', 'grok'))
    const found = resolveDetectedAgents({ shellDirs: [], fallbackDirs: fallbackAgentDirs({ home, listDir: () => [] }), isExecutable: isExecutableFile })
    expect(found).toEqual([{ agent: 'grok', path: real, source: 'fallback' }])
  })
})
