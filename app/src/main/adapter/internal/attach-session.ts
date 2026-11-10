// `claude attach` pane 의 세션 해소 (LIFE-769).
//
// `/bg` 뒤 같은 pane 에서 `claude attach <ref>`(또는 실행 중인 bg 세션을 `claude --resume`)로 붙으면 herdr 는 agent 를 잡지만
// `agent.list` 항목에 `agent_session` **키를 주지 않는다** — 참조는 통합 훅(`SessionStart`)으로만 들어오는데 attach 클라이언트는 훅을 돌리지 않는다.
// 그래서 corral 이 그 pane 의 foreground argv(herdr `pane.process_info`)를 보고, `claude attach <ref>` 면
// 공식 스크립트 출력 `claude agents --json --all` 의 background 행으로 `<ref>` → `sessionId` 를 푼다. **herdr 상태는 쓰지 않는다.**
//
// 해소 규칙 (01-criteria C1):
//   · argv: foreground 프로세스 중 argv[0] 기본이름 `claude` 인 것이 **모두** `claude attach <ref>` 꼴이고 `<ref>` 가 하나일 때만.
//     foreground 에는 MCP 자식(node 등)도 같이 실린다(워커 사전 실측 `raw/claude/pre/snap-1-after-prompt.txt`) — 첫 프로세스로 고르지 않는다
//   · `<ref>` 가 background 행의 `id` 와 같으면 그 행, 아니면 `name` 에 (대소문자 무시) 포함되는 background 행이 **하나일 때만**.
//     둘 이상·0 이면 없음(이름은 유일하지 않다 — 00-analysis-grok §5). `--cwd` 필터는 쓰지 않는다(background 행이 빠졌다 — 00-analysis P3)
//   · `sessionId` 가 UUID 모양이 아니거나, 명령 실패·시간 초과·JSON 아님·배열 아님이면 없음
//   · 못 풀면 **없음**이다 — store 에 남은 `/bg` 전 참조로 떨어지지 않는다(게이트 ⓪ 갈래 (가), store.ts `effectiveSession`)
//
// **문서에 없는 관측에 기댄다** (Claude Code 2.1.296 · herdr 0.9.0, corral-specs LIFE-769 `raw/coordinator/probe1/`):
//   · 실행 중인 bg 세션을 `claude --resume <UUID>` 로 열면 프로세스 argv 가 `claude attach <짧은 id>` 로 바뀐다(P9)
//   · attach 클라이언트에서 `←` 로 agent view 에 들어가면 argv 가 `claude agents` 로 바뀌고, Enter 로 같은 세션에 돌아와도 그대로다(P6·P7) —
//     그때는 이 해소가 없음을 낸다(같은 세션으로 돌아왔어도). agent view 에서 argv 를 **바꾸지 않는** 버전이 나오면 다른 세션을 가리킬 수 있다 — 남는 위험
//   · `claude agents --json --all` 의 background 행 모양 `{id, kind:"background", sessionId, name, pid}` (P3)
// 남는 한계는 `mobile/SURFACE.md` 「attach pane 의 세션 해소」.

import path from 'node:path'
import { execFile } from 'node:child_process'
import { isRecord, readRecord, readString } from '../../../shared/json.js'

/** `claude agents --json --all` 한 번의 시한 — 실측 0.10~0.13 s(`probe1/agents-json-timing.txt`). */
export const ATTACH_AGENTS_TIMEOUT_MS = 3_000
/** 출력 상한 — 행 수십 개면 수 KB 다. */
export const ATTACH_AGENTS_MAX_BYTES = 1024 * 1024
/**
 * 못 푼 (pane, argv) 를 다시 풀어 보는 최소 간격. 푼 것은 argv 가 바뀌기 전까지 다시 부르지 않는다
 * (짧은 id 는 그 세션 UUID 의 앞자리라 argv 가 같으면 답이 같다).
 */
export const ATTACH_RETRY_MS = 5_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AttachArgv =
  | { kind: 'attach'; ref: string; argv0: string }
  | { kind: 'none'; reason: string }

/** herdr `pane.process_info` 의 result(`{process_info:{foreground_processes:[…]}}`)에서 `claude attach <ref>` 를 읽는다. */
export function readAttachArgv(result: unknown): AttachArgv {
  const info = isRecord(result) ? readRecord(result, 'process_info') : null
  const list = info === null ? null : info['foreground_processes']
  if (!Array.isArray(list)) return { kind: 'none', reason: 'process_info 모양 아님' }
  const claude: string[][] = []
  for (const item of list) {
    const argv = isRecord(item) ? item['argv'] : null
    if (!Array.isArray(argv) || !argv.every((part): part is string => typeof part === 'string')) continue
    const [argv0] = argv
    if (argv0 !== undefined && path.basename(argv0) === 'claude') claude.push(argv)
  }
  if (claude.length === 0) return { kind: 'none', reason: 'claude 프로세스 없음' }
  const refs = new Set<string>()
  for (const argv of claude) {
    const ref = argv[2]
    if (argv.length !== 3 || argv[1] !== 'attach' || ref === undefined || ref.length === 0 || ref.startsWith('-')) {
      return { kind: 'none', reason: `claude attach <ref> 아님: ${argv.slice(1, 3).join(' ')}` }
    }
    refs.add(ref)
  }
  const [ref] = [...refs]
  if (refs.size !== 1 || ref === undefined) return { kind: 'none', reason: 'attach ref 가 여럿' }
  return { kind: 'attach', ref, argv0: claude[0]?.[0] ?? 'claude' }
}

export type AttachResolution = { ok: true; sessionId: string } | { ok: false; reason: string }

/** `claude agents --json --all` 출력(파싱한 값)에서 `<ref>` → `sessionId`. background 행만 본다. */
export function resolveAttachRef(input: { ref: string; agents: unknown }): AttachResolution {
  if (!Array.isArray(input.agents)) return { ok: false, reason: 'agents 출력이 배열 아님' }
  const rows = input.agents.filter((row): row is Record<string, unknown> => isRecord(row) && row['kind'] === 'background')
  const byId = rows.filter((row) => readString(row, 'id') === input.ref)
  const needle = input.ref.toLowerCase()
  const matched = byId.length > 0 ? byId : rows.filter((row) => (readString(row, 'name') ?? '').toLowerCase().includes(needle))
  if (matched.length !== 1) return { ok: false, reason: matched.length === 0 ? 'ref 에 맞는 행 없음' : `ref 에 맞는 행 ${matched.length}개` }
  const sessionId = readString(matched[0] ?? {}, 'sessionId')
  if (sessionId === null || !UUID.test(sessionId)) return { ok: false, reason: 'sessionId 가 UUID 모양 아님' }
  return { ok: true, sessionId }
}

export type AgentsRunOutcome = { ok: true; stdout: string } | { ok: false; reason: string }
export type AgentsRun = (input: { executable: string }) => Promise<AgentsRunOutcome>

/** 실제 실행기 — 셸 없이 인자 배열, 시한·출력 상한. 던지지 않는다. */
export const makeRunClaudeAgents = (input: { timeoutMs?: number; maxBytes?: number } = {}): AgentsRun => ({ executable }) => new Promise((resolve) => {
  try {
    execFile(executable, ['agents', '--json', '--all'], {
      shell: false,
      timeout: input.timeoutMs ?? ATTACH_AGENTS_TIMEOUT_MS,
      maxBuffer: input.maxBytes ?? ATTACH_AGENTS_MAX_BYTES,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout) => {
      if (error === null) resolve({ ok: true, stdout })
      else resolve({ ok: false, reason: error.killed === true || error.signal != null ? 'timeout' : String(error.code ?? error.message).slice(0, 200) })
    })
  } catch (error) {
    resolve({ ok: false, reason: String(error).slice(0, 200) })
  }
})

export type AttachResolverDeps = {
  /** herdr `pane.process_info` 의 result. 실패면 던진다. */
  processInfo: (paneId: string) => Promise<unknown>
  runAgents: AgentsRun
  /** argv[0] 가 절대경로가 아닐 때 쓸 claude 실행 파일(로그인 셸 PATH·설치 폴더 감지 결과). 모르면 null → 없음. */
  claudeExecutable: () => string | null
  now: () => number
}

export type AttachRoundResult = { paneId: string; sessionId: string | null; reason: string | null }

type Cached = { argvKey: string; resolution: AttachResolution; at: number }

/**
 * 한 판 = 후보 pane 마다 `pane.process_info` 한 건 + (필요할 때만) 실행 파일마다 `claude agents --json --all` 한 건.
 * 겹쳐 돌지 않는다(진행 중이면 그 판은 건너뛴다 — null). 후보가 없으면 아무것도 부르지 않는다.
 */
export class AttachSessionResolver {
  private readonly deps: AttachResolverDeps
  private readonly cache = new Map<string, Cached>()
  private running = false
  /** 계측·시험용 — `claude agents` 를 띄운 횟수. */
  agentsCalls = 0

  constructor(deps: AttachResolverDeps) {
    this.deps = deps
  }

  async round(paneIds: readonly string[]): Promise<AttachRoundResult[] | null> {
    for (const key of [...this.cache.keys()]) if (!paneIds.includes(key)) this.cache.delete(key)
    if (paneIds.length === 0) return []
    if (this.running) return null
    this.running = true
    try {
      const argvs = await Promise.all(paneIds.map(async (paneId) => {
        try {
          return { paneId, argv: readAttachArgv(await this.deps.processInfo(paneId)) }
        } catch (error) {
          return { paneId, argv: { kind: 'none', reason: `process_info 실패: ${String(error).slice(0, 120)}` } satisfies AttachArgv }
        }
      }))
      const now = this.deps.now()
      const pending: Array<{ paneId: string; ref: string; executable: string | null; argvKey: string }> = []
      for (const { paneId, argv } of argvs) {
        if (argv.kind === 'none') {
          this.cache.delete(paneId)
          continue
        }
        const argvKey = `${argv.argv0}\u0000${argv.ref}`
        const cached = this.cache.get(paneId)
        if (cached !== undefined && cached.argvKey === argvKey && (cached.resolution.ok || now - cached.at < ATTACH_RETRY_MS)) continue
        const executable = path.isAbsolute(argv.argv0) ? argv.argv0 : this.deps.claudeExecutable()
        pending.push({ paneId, ref: argv.ref, executable, argvKey })
      }
      const outputs = new Map<string, Promise<AgentsRunOutcome>>()
      for (const item of pending) {
        if (item.executable === null || outputs.has(item.executable)) continue
        this.agentsCalls += 1
        outputs.set(item.executable, this.deps.runAgents({ executable: item.executable }))
      }
      for (const item of pending) {
        const resolution: AttachResolution = item.executable === null
          ? { ok: false, reason: 'claude 실행 파일 없음' }
          : resolveOutcome({ ref: item.ref, outcome: await outputs.get(item.executable) })
        this.cache.set(item.paneId, { argvKey: item.argvKey, resolution, at: now })
      }
      return argvs.map(({ paneId, argv }) => {
        const cached = argv.kind === 'none' ? undefined : this.cache.get(paneId)
        if (cached === undefined) return { paneId, sessionId: null, reason: argv.kind === 'none' ? argv.reason : '해소 없음' }
        return cached.resolution.ok ? { paneId, sessionId: cached.resolution.sessionId, reason: null } : { paneId, sessionId: null, reason: cached.resolution.reason }
      })
    } finally {
      this.running = false
    }
  }
}

function resolveOutcome(input: { ref: string; outcome: AgentsRunOutcome | undefined }): AttachResolution {
  const { outcome } = input
  if (outcome === undefined) return { ok: false, reason: '실행 결과 없음' }
  if (!outcome.ok) return { ok: false, reason: `claude agents 실패: ${outcome.reason}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(outcome.stdout)
  } catch {
    return { ok: false, reason: 'claude agents 출력이 JSON 아님' }
  }
  return resolveAttachRef({ ref: input.ref, agents: parsed })
}
