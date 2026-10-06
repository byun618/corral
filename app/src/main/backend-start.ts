// herdr 서버를 corral 이 띄울지 정한다 (LIFE-485 D1·D3).
//
// **결정은 순수 함수다** (`decideBackend`) — 멈춘 서버·재개 대상을 실제로 만들지 않고도 표 전부를
// 재생으로 잴 수 있어야 한다(K3). 띄우는 손(`BackendStarter`)은 동시 트리거를 한 번으로 뭉치고
// 준비를 시한 안에서 기다린다 — 실제 spawn·조회는 주입받는다.
//
// 대상은 「기본 경로」 하나다: 바인딩(프로필·CORRAL_SESSION·CORRAL_BACKEND_SOCKET)이 없을 때 붙는 `default`.

import type { BackendStatus, LinkPhase, RestoreSummary } from '../shared/types.js'

export const DEFAULT_SESSION = 'default'

type Candidate = { name: string; isDefault: boolean; running: boolean }

export type StarterPhase =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'failed'; error: string; logPath: string | null }

export type BackendInput = {
  /** 지정된 세션 — 프로필 바인딩·`CORRAL_SESSION`(·측정 하네스의 `CORRAL_BACKEND_SOCKET`). 있으면 어떤 경우에도 띄우지 않는다. */
  bound: string | null
  binary: { kind: 'resolving' } | { kind: 'found' } | { kind: 'missing'; searched: string[] }
  sessions: readonly Candidate[]
  /** 지금 붙어 있는(붙었던) 세션. 연결 도중 멈춤을 가른다. */
  selected: string | null
  link: { phase: LinkPhase; attempt: number }
  /** default 의 재개 대상. 셀 필요가 없을 때(돌고 있는 세션이 있을 때)는 null 이어도 된다. */
  restore: RestoreSummary | null
  starter: StarterPhase
  /** 이 앱 수명에서 자동 기동을 이미 했나 (K3⑨ — 최대 1회). */
  autoStartUsed: boolean
}

export type BackendDecision = { status: BackendStatus; autostart: boolean }

/**
 * 지정된 세션 이름 — 프로필 바인딩(`restoreBackend` 가 `CORRAL_SESSION`·`CORRAL_BACKEND_SOCKET` 둘 다로 옮긴다)·`CORRAL_SESSION`.
 * 바인딩 정의는 `listSessions` 의 지름길과 같다(r1 R1-06): 세션 이름이 기준이다. 소켓만 주는 조합은 런타임이
 * `invalid_backend` 로 시작을 거절해 여기까지 오지 않는다 — 소켓 경로를 세션 이름으로 쓰지 않는다.
 */
export function boundSessionName(env: { CORRAL_SESSION?: string | undefined }): string | null {
  const session = env.CORRAL_SESSION
  return session !== undefined && session.length > 0 ? session : null
}

/** 재개 대상을 셀 필요가 있나 — default 가 멈춰 있고, 확인·자동 기동 후보일 때만(r1 R1-05). */
export function needsRestoreCount(input: { bound: string | null; sessions: readonly Candidate[]; selected: string | null }): boolean {
  if (input.bound !== null) return false
  if (input.sessions.some((session) => session.isDefault && session.running)) return false
  return input.selected === DEFAULT_SESSION || !input.sessions.some((session) => session.running)
}

export function decideBackend(input: BackendInput): BackendDecision {
  const none = (status: BackendStatus): BackendDecision => ({ status, autostart: false })
  const { link } = input

  // ⑩·① 지정된 세션 — 띄우지 않는다. 어느 바이너리·설정 루트로 떠야 하는지 corral 이 모른다.
  if (input.bound !== null) {
    const named = input.sessions.find((session) => session.name === input.bound)
    if (link.phase === 'live') return none({ kind: 'ok' })
    if (named === undefined || !named.running) return none({ kind: 'bound-stopped', session: input.bound, reason: 'bound' })
    if (link.phase === 'reconnecting') return none({ kind: 'reconnecting', session: input.bound, attempt: link.attempt })
    return none({ kind: 'ok' })
  }

  if (input.starter.phase === 'starting') return none({ kind: 'starting', session: DEFAULT_SESSION })

  // ⑧ 연결 도중 멈춤 — 자동으로 다시 띄우지 않는다. 의도한 종료를 되돌리지 않고 크래시 반복을 키우지 않는다.
  if (input.selected !== null) {
    const current = input.sessions.find((session) => session.name === input.selected)
    if (current !== undefined && current.running) {
      if (link.phase === 'reconnecting') return none({ kind: 'reconnecting', session: input.selected, attempt: link.attempt })
      return none({ kind: 'ok' })
    }
    if (link.phase === 'live') return none({ kind: 'ok' })
    // default 가 아닌 세션(기존 규칙으로 붙었던 이름 세션)은 띄우지 않는다 — 안내만.
    if (input.selected !== DEFAULT_SESSION) return none({ kind: 'bound-stopped', session: input.selected, reason: 'attached' })
    if (input.starter.phase === 'failed') return none(failed(input.starter))
    if (input.binary.kind === 'missing') return none({ kind: 'missing', searched: input.binary.searched })
    return none({ kind: 'confirm', reason: 'exited', session: DEFAULT_SESSION, restore: input.restore ?? unknownRestore })
  }

  // ②·③ 돌고 있는 세션이 있으면 기존 규칙(pick-session)대로 붙는다 — 기동 없음.
  if (input.sessions.some((session) => session.running)) return none({ kind: 'ok' })

  if (input.binary.kind === 'resolving') return none({ kind: 'ok' })
  // ⑦ 바이너리 해소 실패.
  if (input.binary.kind === 'missing') return none({ kind: 'missing', searched: input.binary.searched })
  if (input.starter.phase === 'failed') return none(failed(input.starter))

  const restore = input.restore ?? unknownRestore
  // ④ 재개 0 이면 자동 기동 — 앱 수명에서 한 번만(⑨). ⑤·⑥ 재개 ≥1·모름은 확인.
  if (restore.known && restore.total === 0 && !input.autoStartUsed) {
    return { status: { kind: 'starting', session: DEFAULT_SESSION }, autostart: true }
  }
  return none({ kind: 'confirm', reason: 'stopped', session: DEFAULT_SESSION, restore })
}

const unknownRestore: RestoreSummary = { known: false, reason: '재개 대상을 세지 않았다' }

function failed(starter: { error: string; logPath: string | null }): BackendStatus {
  return { kind: 'failed', session: DEFAULT_SESSION, error: starter.error, logPath: starter.logPath }
}

export type StarterDeps = {
  /** default 가 지금 돌고 있나 — `herdr session list` 기준. */
  isRunning: () => Promise<boolean>
  /** 서버를 분리해 띄운다. 즉시 종료하면 `onExit` 가 불린다. */
  spawn: (onExit: (detail: string) => void) => { ok: true; pid: number; logPath: string } | { ok: false; error: string; logPath: string | null }
  logTail: (logPath: string) => string
  sleep: (ms: number) => Promise<void>
  now: () => number
  readyTimeoutMs: number
  pollMs: number
  onChange: () => void
  log: (event: string, data: Record<string, unknown>) => void
}

/**
 * 띄우는 손. **동시 트리거(자동 기동 + 버튼, 버튼 연타)는 진행 중인 한 번으로 합친다** (K4ⓕ).
 * 띄우기 직전에 한 번 더 조회해서 이미 돌고 있으면 띄우지 않는다 — herdr 도 두 번째 `server` 를 exit 1 로
 * 거절하지만(살아 있는 소켓이 락) 그건 마지막 방어선이다.
 */
export class BackendStarter {
  private current: StarterPhase = { phase: 'idle' }
  private inflight: Promise<void> | null = null
  private autoUsed = false
  private spawnCount = 0

  constructor(private readonly deps: StarterDeps) {}

  phase(): StarterPhase {
    return this.current
  }

  autoStartUsed(): boolean {
    return this.autoUsed
  }

  /** 이 앱 수명에서 spawn 을 몇 번 했나 — 계측·테스트용. */
  spawns(): number {
    return this.spawnCount
  }

  start(trigger: 'auto' | 'button'): Promise<void> {
    if (trigger === 'auto') this.autoUsed = true
    if (this.inflight !== null) {
      this.deps.log('backend.start.joined', { trigger })
      return this.inflight
    }
    this.inflight = this.run(trigger).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private set(next: StarterPhase): void {
    this.current = next
    this.deps.onChange()
  }

  private async run(trigger: 'auto' | 'button'): Promise<void> {
    this.set({ phase: 'starting' })
    this.deps.log('backend.start', { trigger })
    if (await this.deps.isRunning().catch(() => false)) {
      this.deps.log('backend.start.already_running', { trigger })
      this.set({ phase: 'idle' })
      return
    }
    let exited: string | null = null
    const spawned = this.deps.spawn((detail) => {
      exited = detail
    })
    if (!spawned.ok) {
      this.deps.log('backend.start.failed', { trigger, error: spawned.error })
      this.set({ phase: 'failed', error: spawned.error, logPath: spawned.logPath })
      return
    }
    this.spawnCount += 1
    const deadline = this.deps.now() + this.deps.readyTimeoutMs
    while (this.deps.now() < deadline) {
      if (exited !== null) {
        // 바로 끝났어도 그새 다른 손(사용자·다른 corral)이 띄운 서버가 돌고 있으면 실패가 아니다 — 두 번째 `server` 는
        // 살아 있는 소켓 락에 exit 1 로 진다(r1 R1-10). 실패 카드를 잠깐 띄우지 않는다.
        if (await this.deps.isRunning().catch(() => false)) {
          this.deps.log('backend.start.lost_race', { trigger, pid: spawned.pid, exited })
          this.set({ phase: 'idle' })
          return
        }
        const tail = this.deps.logTail(spawned.logPath)
        const error = `서버가 바로 종료됐다 (${exited})${tail.length > 0 ? `\n${tail}` : ''}`
        this.deps.log('backend.start.failed', { trigger, pid: spawned.pid, exited })
        this.set({ phase: 'failed', error, logPath: spawned.logPath })
        return
      }
      if (await this.deps.isRunning().catch(() => false)) {
        this.deps.log('backend.start.ready', { trigger, pid: spawned.pid })
        this.set({ phase: 'idle' })
        return
      }
      await this.deps.sleep(this.deps.pollMs)
    }
    this.deps.log('backend.start.failed', { trigger, pid: spawned.pid, timeoutMs: this.deps.readyTimeoutMs })
    this.set({ phase: 'failed', error: `서버가 ${Math.round(this.deps.readyTimeoutMs / 1000)}초 안에 준비되지 않았다`, logPath: spawned.logPath })
  }
}
