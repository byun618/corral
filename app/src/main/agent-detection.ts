// 에이전트 감지 (LIFE-520 S33 · Orca 198 `agent-detection.ts`·`hydrate-shell-path.ts`).
//
// Finder·Dock 으로 뜬 앱의 PATH 는 launchd 값(`/usr/bin:/bin:/usr/sbin:/sbin`)이라 claude·codex·grok 이 없다(515 U7).
// 그래서 로그인 셸(`$SHELL -ilc`)에 PATH 를 물어 그 PATH 에서 찾고, 셸이 실패하거나 거기 없으면 사용자 설치 폴더를 본다.
//
// **감지 전용** — main `process.env`(PATH 포함)를 바꾸지 않는다(E1). 에이전트 실행 경로(pane 셸)는 이미 로그인 셸이다.
// 기존 로그인 셸 조회 세 벌(herdr `server.ts` · tailscale · CLI 설치)은 건드리지 않고 패턴(구분자·`DISABLE_AUTO_UPDATE`·10초)만 따른다(E8).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DETECTABLE_AGENTS, UNKNOWN_AGENT_DETECTION, type AgentDetectionSnapshot, type DetectableAgent, type DetectedAgent, type ShellProbeOutcome } from '../shared/agent-detection.js'

/** 로그인 셸 시한 — herdr 조회(`LOGIN_SHELL_TIMEOUT_MS`)·Orca 와 같은 10초. 넘으면 셸 프로세스 그룹을 SIGKILL 한다. */
export const AGENT_SHELL_TIMEOUT_MS = 10_000

const MARK = '__CORRAL_AGENT_PATH__'

/** 카탈로그 이름 = 실행 파일 이름(`tab-create-menu.ts` AGENT_CATALOG 의 cmd). */
const AGENT_COMMAND: Record<DetectableAgent, string> = { claude: 'claude', codex: 'codex', grok: 'grok' }

export type ShellProbe = { outcome: { ok: true }; pathValue: string } | { outcome: Exclude<ShellProbeOutcome, { ok: true }>; pathValue: null }

/** 구분자 사이 값 — 앞뒤 rc 잡음·배너는 버린다. 구분자가 없거나 하나뿐이면 null, 빈 값도 null. */
export function parseMarkedValue(stdout: string): string | null {
  const start = stdout.indexOf(MARK)
  if (start < 0) return null
  const end = stdout.indexOf(MARK, start + MARK.length)
  if (end < 0) return null
  const value = stdout.slice(start + MARK.length, end).trim()
  return value.length > 0 ? value : null
}

/**
 * `$SHELL -ilc` 로 PATH 를 받는다. stdin 은 닫고(대화형 rc 가 입력을 기다리지 않게), 셸을 새 프로세스 그룹으로 띄워
 * 시한이 넘으면 그룹째(rc 가 띄운 손주 포함) SIGKILL 한다 — Orca #5657(probe hang) 대비.
 * 셸이 끝났는데 손주가 stdout 을 쥐고 있어도 `exit` 에서 끝낸다(`close` 를 기다리지 않는다).
 * `signal` 이 끊기면(새로고침이 덮음·앱 종료) 시한을 기다리지 않고 그룹을 SIGKILL 하고 `aborted` 로 끝낸다(fix1 R1-06·R1-07).
 */
export function probeLoginShellPath(input: { shell: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<ShellProbe> {
  return new Promise((resolve) => {
    if (input.signal?.aborted === true) {
      resolve({ outcome: { ok: false, reason: 'aborted' }, pathValue: null })
      return
    }
    let stdout = ''
    let settled = false
    const finish = (probe: ShellProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      resolve(probe)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
        env: { ...input.env, DISABLE_AUTO_UPDATE: 'true' },
      })
    } catch {
      resolve({ outcome: { ok: false, reason: 'spawn-error' }, pathValue: null })
      return
    }
    const killGroup = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 그룹이 이미 없다.
      }
    }
    const timer = setTimeout(() => {
      killGroup()
      finish({ outcome: { ok: false, reason: 'timeout' }, pathValue: null })
    }, input.timeoutMs)
    const onAbort = (): void => {
      killGroup()
      finish({ outcome: { ok: false, reason: 'aborted' }, pathValue: null })
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => finish({ outcome: { ok: false, reason: 'spawn-error' }, pathValue: null }))
    child.on('exit', (code) => {
      // 마지막 조각이 `exit` 뒤에 올 수 있다 — 한 틱 미룬다.
      setImmediate(() => {
        const value = parseMarkedValue(stdout)
        if (value !== null) finish({ outcome: { ok: true }, pathValue: value })
        else finish({ outcome: { ok: false, reason: code === 0 ? 'no-marker' : 'exit' }, pathValue: null })
      })
    })
  })
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 사용자 설치 폴더 폴백(E6) — 이 순서로 본다.
 *   · `~/.grok/bin` (grok 설치 스크립트의 실물 자리 — Orca #17590). **맨 앞**: grok 만 사는 전용 폴더라 다른 에이전트 순서에 영향이 없고,
 *     `~/.local/bin/grok` 은 대개 이것을 가리키는 심링크다 — 실물 경로를 그대로 보여 준다(fix1 R1-02)
 *   · `~/.local/bin` (claude 네이티브 설치) · `~/.claude/local` (claude 로컬 설치) · `/opt/homebrew/bin`·`/usr/local/bin` (brew·npm 전역)
 *   · `~/.npm-global/bin`·`~/.bun/bin`·`~/.volta/bin` (흔한 npm 전역 prefix·bun·volta)
 *   · `~/.nvm/versions/node/<버전>/bin` (nvm npm 전역 — Orca #14077, 버전 이름 역순 = 대체로 새 버전 먼저)
 */
export function fallbackAgentDirs(input: { home: string; listDir: (dir: string) => string[] }): string[] {
  const { home } = input
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
  const nvm = input
    .listDir(nvmRoot)
    .filter((name) => name.startsWith('v'))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((name) => path.join(nvmRoot, name, 'bin'))
  return [
    path.join(home, '.grok', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    ...nvm,
  ]
}

/** 로그인 셸 PATH 의 폴더 — 절대경로만(상대경로·빈 칸은 버린다). */
export function shellPathDirs(pathValue: string): string[] {
  return pathValue.split(':').filter((dir) => dir.length > 0 && path.isAbsolute(dir))
}

/** 셸 PATH 에서 먼저, 없으면 폴백 폴더에서. 실행 가능한 일반 파일만(디렉터리·실행 불가 거름). 카탈로그 순서. */
export function resolveDetectedAgents(input: { shellDirs: readonly string[]; fallbackDirs: readonly string[]; isExecutable: (file: string) => boolean }): DetectedAgent[] {
  const found: DetectedAgent[] = []
  for (const agent of DETECTABLE_AGENTS) {
    const command = AGENT_COMMAND[agent]
    const fromShell = input.shellDirs.map((dir) => path.join(dir, command)).find(input.isExecutable)
    if (fromShell !== undefined) {
      found.push({ agent, path: fromShell, source: 'login-shell' })
      continue
    }
    const fromFallback = input.fallbackDirs.map((dir) => path.join(dir, command)).find(input.isExecutable)
    if (fromFallback !== undefined) found.push({ agent, path: fromFallback, source: 'fallback' })
  }
  return found
}

export type AgentDetectorDeps = {
  /** 실행 하나 = 셸 하나. `signal` 이 끊기면 셸 그룹을 끝내고 `aborted` 로 돌아와야 한다. */
  probe: (signal: AbortSignal) => Promise<ShellProbe>
  fallbackDirs: () => string[]
  isExecutable: (file: string) => boolean
  now: () => number
  onChange: (snapshot: AgentDetectionSnapshot) => void
  log: (event: string, data: Record<string, unknown>) => void
}

/**
 * 메모리 캐시·새로고침(K3).
 *   · `ensure` — 캐시가 있으면 그것(셸을 다시 띄우지 않는다), 진행 중이면 그 실행에 합류, 아니면 실행.
 *   · `get` — 렌더러 조회(IPC). 지금 스냅숏을 바로 돌려주고, 캐시가 없으면(셸 실패 회차 뒤 포함) `ensure` 를 건다 — 실패가 굳지 않는
 *     프로덕션의 「다음 요청」 이다(fix1 R1-01). 진행 중이면 합쳐지므로 셸은 늘지 않는다.
 *   · `refresh` — 늘 새로 실행한다. 진행 중이던 옛 실행은 셸을 끝내고(fix1 R1-07 — 겹쳐도 사는 셸은 하나) 결과도 버린다(세대 번호).
 *   · 셸이 실패한 회차(폴백 결과)는 보여 주되 **캐시하지 않는다**(E2, Orca #9011).
 *   · 예외(예상 밖)는 결과를 바꾸지 않는다 — 감지 전이면 `unknown` 그대로.
 *   · `killAll` — 앱 종료. 진행 중 셸 그룹을 끝내고 이후 실행을 받지 않는다(fix1 R1-06).
 */
export class AgentDetector {
  private snapshot: AgentDetectionSnapshot = UNKNOWN_AGENT_DETECTION
  private cached = false
  private generation = 0
  private inflight: Promise<AgentDetectionSnapshot> | null = null
  private running: AbortController | null = null
  private disposed = false

  constructor(private readonly deps: AgentDetectorDeps) {}

  current(): AgentDetectionSnapshot {
    return this.snapshot
  }

  get(): AgentDetectionSnapshot {
    if (!this.cached) void this.ensure()
    return this.snapshot
  }

  ensure(): Promise<AgentDetectionSnapshot> {
    if (this.cached || this.disposed) return Promise.resolve(this.snapshot)
    if (this.inflight !== null) return this.inflight
    return this.start()
  }

  refresh(): Promise<AgentDetectionSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot)
    return this.start()
  }

  killAll(): void {
    this.disposed = true
    this.generation += 1
    this.inflight = null
    this.running?.abort()
    this.running = null
  }

  private start(): Promise<AgentDetectionSnapshot> {
    this.running?.abort()
    const controller = new AbortController()
    this.running = controller
    this.generation += 1
    const mine = this.generation
    const startedAt = this.deps.now()
    const run = this.detect(controller.signal).then(
      ({ snapshot, cacheable }) => {
        // 새로고침에 밀린 옛 실행 — 결과를 버리고, 기다리던 쪽은 새 실행을 같이 기다린다.
        if (mine !== this.generation) return this.inflight ?? this.snapshot
        this.inflight = null
        this.running = null
        this.snapshot = snapshot
        this.cached = cacheable
        this.deps.log('agents.detect', {
          ms: this.deps.now() - startedAt,
          shell: snapshot.kind === 'detected' ? snapshot.shell : null,
          agents: snapshot.kind === 'detected' ? snapshot.agents : [],
          cached: cacheable,
        })
        this.deps.onChange(snapshot)
        return snapshot
      },
      (error: unknown) => {
        this.deps.log('agents.detect', { error: error instanceof Error ? error.message : String(error) })
        if (mine !== this.generation) return this.inflight ?? this.snapshot
        this.inflight = null
        this.running = null
        return this.snapshot
      },
    )
    this.inflight = run
    return run
  }

  private async detect(signal: AbortSignal): Promise<{ snapshot: AgentDetectionSnapshot; cacheable: boolean }> {
    const probe = await this.deps.probe(signal)
    const shellDirs = probe.pathValue === null ? [] : shellPathDirs(probe.pathValue)
    const agents = resolveDetectedAgents({ shellDirs, fallbackDirs: this.deps.fallbackDirs(), isExecutable: this.deps.isExecutable })
    return { snapshot: { kind: 'detected', agents, shell: probe.outcome, at: this.deps.now() }, cacheable: probe.outcome.ok }
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** 실제 셸·파일 시스템에 묶는다. `env` 는 읽기만 한다 — 셸 자식에 넘기는 사본을 만들 뿐 `process.env` 는 그대로(E1). */
export function realAgentDetectorDeps(input: {
  env: NodeJS.ProcessEnv
  onChange: AgentDetectorDeps['onChange']
  log: AgentDetectorDeps['log']
}): AgentDetectorDeps {
  const shell = input.env.SHELL !== undefined && path.isAbsolute(input.env.SHELL) ? input.env.SHELL : '/bin/zsh'
  return {
    probe: (signal) => probeLoginShellPath({ shell, timeoutMs: AGENT_SHELL_TIMEOUT_MS, env: input.env, signal }),
    fallbackDirs: () => fallbackAgentDirs({ home: os.homedir(), listDir }),
    isExecutable: isExecutableFile,
    now: () => Date.now(),
    onChange: input.onChange,
    log: input.log,
  }
}

/**
 * IPC 처리 함수 (fix1 R1-01 — 시험이 이 단에서 재시도 경로를 본다).
 *   · `corral:agentDetectionGet` — 지금 스냅숏(기다리지 않음). 캐시가 없으면 감지를 건다(`get`).
 *   · `corral:agentDetectionRefresh` — 강제 재실행, 끝난 스냅숏.
 * 다른 창의 요청·감지기 없음이면 null.
 */
export function registerAgentDetectionIpc<TEvent>(input: {
  handle: (channel: string, listener: (event: TEvent) => unknown) => void
  allowed: (event: TEvent) => boolean
  detector: () => AgentDetector | null
}): void {
  input.handle('corral:agentDetectionGet', (event) => {
    const detector = input.detector()
    return input.allowed(event) && detector !== null ? detector.get() : null
  })
  input.handle('corral:agentDetectionRefresh', (event) => {
    const detector = input.detector()
    return input.allowed(event) && detector !== null ? detector.refresh() : null
  })
}
