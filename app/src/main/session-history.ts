// 세션 히스토리 스캐너 (LIFE-808) — 디스크에 남은 Claude·Codex 대화 기록을 **읽기만** 해 목록·상세·재개 계획을 만든다.
//
// 열린 pane 의 지문(`transcript.ts`, 1.5 초 폴링)과 다른 층이다 — 이 파일은 **열려 있지 않은 세션까지** 훑는다. 다만
// 같은 형식을 두 번 파싱하지 않는다: 줄 판정은 전부 기존 판독기(`transcript-parse.ts` 의 사람 발화·모델·최근 발화,
// `chat-parse.ts` 의 말풍선 조립)를 부른다. 여기서 새로 읽는 칸은 목록에만 필요한 것(cwd·브랜치·entrypoint·제목 줄·
// Codex `session_meta`) 뿐이다.
//
// 대상(C1·결정 6 — 대화형만):
//   claude : <CLAUDE_CONFIG_DIR 또는 ~/.claude>/projects/<폴더>/<id>.jsonl  — 첫 `entrypoint` 가 cli·claude-desktop 이거나
//            **없는** 파일(메타 줄만 남은 빈 세션 — C17 이 숨긴다). sdk-cli(`-p`) 등 그 밖의 entrypoint 는 뺀다.
//            subagent 기록(`<id>/subagents/`)은 한 단계 아래라 훑지 않는다.
//   codex  : <CODEX_HOME 또는 ~/.codex>/sessions/**/rollout-*.jsonl — 첫 줄 `session_meta` 의 originator 가 codex-tui 인 것만
//            (codex_exec 은 뺀다). 첫 줄이 session_meta 가 아니면 「읽기 실패」 로 센다.
//   C13 독립 셈도 이 규칙 그대로다(entrypoint 없는 Claude 파일 = 대화형으로 센다).
//
// 비용(C6·C11·C13): 목록 스캔은 파일마다 **앞 64KB·뒤 64KB** 만 읽는다(00-analysis §3 — 1.3k 세션 < 0.2 s). path·size·mtime 이
// 같은 파일은 다시 파싱하지 않는다(메모리 캐시). 메시지 수는 상세를 열 때만 전체를 스트리밍으로 읽는다.
//
// 읽기 전용(C3): 이 파일은 기록 디렉터리에 쓰는 API 를 부르지 않는다 — open(읽기)·read·stat·readdir·realpath·access 뿐.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRecord, readString } from '../shared/json.js'
import {
  PREVIEW_MAX,
  RECENT_TURNS,
  TURN_TEXT_MAX,
  isPathWithin,
  isSessionId,
  openPaneOf,
  readSessionKey,
  resumeArgv,
  resumeCommandText,
  type HistoryProvider,
  type PaneSession,
  type ResumePlan,
  type SessionHistoryDetailResult,
  type SessionHistoryListResult,
  type SessionHistoryResumeResult,
  type SessionHistoryRevealResult,
  type SessionHistoryRow,
  type SessionHistoryTurn,
  type SessionKey,
} from '../shared/session-history.js'
import { ChatBuilder } from './chat-parse.js'
import {
  CLAUDE_NON_HUMAN_TEXT_MARKERS,
  claudeHumanText,
  claudeLastPrompt,
  claudeModel,
  cleanFirstPrompt,
  cleanPromptLine,
  codexHumanText,
  codexLastPrompt,
  codexModel,
  readTimestamp,
  tailRecords,
} from './transcript-parse.js'

/** 목록 스캔의 앞 창 — Codex 첫 줄(`session_meta`, 실측 최대 22.8KB)과 Claude 첫 cwd 줄(190/200)이 들어온다. */
export const SCAN_HEAD_BYTES = 64 * 1024
/** 목록 스캔의 뒤 창 — Claude `ai-title` 은 꼬리에 다시 써진다(끝 64KB 184/200). */
export const SCAN_TAIL_BYTES = 64 * 1024
/** 동시에 여는 파일 수. */
const SCAN_CONCURRENCY = 32

/** Claude 대화형 entrypoint (결정 6). 없는 파일도 대화형으로 센다(위 머리 주석). */
const CLAUDE_INTERACTIVE = new Set(['cli', 'claude-desktop'])
const CODEX_INTERACTIVE = 'codex-tui'

export type HistoryRoots = { claudeDir: string; codexDir: string }

/**
 * 기록 루트 — `CLAUDE_CONFIG_DIR`·`CODEX_HOME` 를 존중한다(C1).
 * 제한(R1-11): 보는 것은 **Electron main 프로세스의 env** 뿐이다. 설치본을 Finder·Dock 으로 띄우면 셸 rc 에서 export 한 값이 main 에 없어,
 * 셸에서만 그 변수를 쓰는 사용자는 pane 안의 에이전트가 쓰는 기록 위치와 여기서 읽는 위치가 다를 수 있다(그때는 기본 `~/.claude`·`~/.codex`).
 */
export function historyRoots(input: { env: NodeJS.ProcessEnv; home: string }): HistoryRoots {
  const claude = input.env['CLAUDE_CONFIG_DIR']
  const codex = input.env['CODEX_HOME']
  return {
    claudeDir: claude !== undefined && claude.length > 0 ? claude : path.join(input.home, '.claude'),
    codexDir: codex !== undefined && codex.length > 0 ? codex : path.join(input.home, '.codex'),
  }
}

/** 스캔 한 행의 원재료 — cwd 존재·비교 키·Codex 이름은 스캔마다 다시 붙인다(폴더가 지워지고 이름이 바뀐다). */
type Parsed = Omit<SessionHistoryRow, 'cwdKey' | 'cwdExists'>
/** `excluded` = 비대화형(목록 대상 아님) · `unreadable` = 깨진·빈 파일. */
type ParseOutcome = { kind: 'row'; row: Parsed } | { kind: 'excluded' } | { kind: 'unreadable' }
type CacheEntry = { size: number; mtimeMs: number; outcome: ParseOutcome }

/** `headCut` = 앞 창이 파일 중간에서 끝났을 때 마지막(잘린) 줄의 보이는 앞부분. 통째로 읽었으면 null. */
type Windows = { head: string; tail: string; tailPartial: boolean; headCut: string | null }

/**
 * 앞 창 끝에서 잘린 줄이 사람 프롬프트로 보이나 — 한 줄이 64KB 를 넘는 프롬프트(이미지 붙여넣기 등)는 JSON 으로 못 읽는다.
 * 실측(2026-11-19 진단, `raw/claude/worklog.md`): 그런 줄은 `"type":"user"` 가 앞에 보이고 `sessionId` 는 본문 뒤라 안 보인다.
 * 보이는 앞부분에 user 레코드 표지가 있고 사람 발화가 아닌 표지(도구 결과·메타·압축 요약·명령 봉투·작업 통지)가 없으면
 * 「앞 창에 사람 프롬프트가 있다」 로 센다(C17) — 글은 못 읽으므로 미리보기·제목에는 쓰지 않는다.
 */
export function looksLikeCutHumanLine(cut: string): boolean {
  if (!cut.includes('"type":"user"')) return false
  // 레코드 칸 표지는 `claudeHumanText` 의 세 줄을 원문 부분 문자열로 복제한다(잘린 줄은 JSON 으로 못 읽는다):
  //   `record['isMeta'] === true` → `"isMeta":true` · `record['isCompactSummary'] === true` → `"isCompactSummary":true` · `hasToolResult(message)` → `tool_result`.
  // 텍스트 봉투는 같은 목록(`CLAUDE_NON_HUMAN_TEXT_MARKERS`)을 쓴다. 판독기 규칙이 바뀌면 이 줄도 같이 본다.
  // 복제하지 않은 것: `type` 이 user 가 아님(위 줄의 `"type":"user"` 가 대신) · sessionId 일치(본문 뒤라 안 보인다) · 중단 표지(텍스트 전체 비교라 잘린 줄에서 못 본다).
  return !['tool_result', '"isMeta":true', '"isCompactSummary":true', ...CLAUDE_NON_HUMAN_TEXT_MARKERS].some((marker) => cut.includes(marker))
}

const errorCode = (error: unknown): unknown => (isRecord(error) ? error['code'] : undefined)
const isMissing = (error: unknown): boolean => errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR'

/** 미리보기 한 줄 — `cleanPromptLine`(기존 최근 발화 규칙) 뒤 `PREVIEW_MAX` 자. */
function preview(text: string | null): string | null {
  if (text === null) return null
  const line = cleanPromptLine(text)
  return line === null ? null : line.slice(0, PREVIEW_MAX)
}

/** 레코드 목록에서 뒤에서 처음 만나는 값. */
function lastOf<T>(records: readonly Record<string, unknown>[], pick: (record: Record<string, unknown>) => T | null): T | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]
    if (record === undefined) continue
    const value = pick(record)
    if (value !== null) return value
  }
  return null
}
function firstOf<T>(records: readonly Record<string, unknown>[], pick: (record: Record<string, unknown>) => T | null): T | null {
  for (const record of records) {
    const value = pick(record)
    if (value !== null) return value
  }
  return null
}
/** 꼬리 우선, 없으면 머리의 마지막. */
const latest = <T>(input: { head: Record<string, unknown>[]; tail: Record<string, unknown>[]; pick: (record: Record<string, unknown>) => T | null }): T | null =>
  lastOf(input.tail, input.pick) ?? lastOf(input.head, input.pick)

const nonEmpty = (value: string | null): string | null => (value !== null && value.trim().length > 0 ? value.trim() : null)
const timestampOf = (record: Record<string, unknown>): number | null => readTimestamp(record['timestamp'])

/** 줄 type 이 `type` 인 레코드의 문자열 칸. */
const typedField = (type: string, field: string) => (record: Record<string, unknown>): string | null =>
  readString(record, 'type') === type ? nonEmpty(readString(record, field)) : null

/**
 * Claude 한 파일 → 행. 빈 세션(C17) = 앞뒤 창 어디에도 **사람 프롬프트**(`claudeHumanText` — 지문·말풍선과 같은 규칙)가 없는 세션.
 * 앞 창에 사람 프롬프트가 있으면 빈 세션이 아니다.
 */
export function parseClaudeSession(input: { id: string; file: string; windows: Windows; mtimeMs: number }): ParseOutcome {
  const head = tailRecords({ chunk: input.windows.head, partial: false })
  const tail = input.windows.tailPartial ? tailRecords({ chunk: input.windows.tail, partial: true }) : head
  if (head.length === 0 && tail.length === 0) return { kind: 'unreadable' }
  const entrypoint = firstOf(head, (record) => readString(record, 'entrypoint')) ?? firstOf(tail, (record) => readString(record, 'entrypoint'))
  if (entrypoint !== null && !CLAUDE_INTERACTIVE.has(entrypoint)) return { kind: 'excluded' }
  const human = (record: Record<string, unknown>): string | null => claudeHumanText({ record, sessionId: input.id })
  const first = firstOf(head, human) ?? (input.windows.tailPartial ? firstOf(tail, human) : null)
  const last = claudeLastPrompt({ records: tail, sessionId: input.id }) ?? (input.windows.tailPartial ? claudeLastPrompt({ records: head, sessionId: input.id }) : null)
  const title =
    latest({ head, tail, pick: typedField('custom-title', 'customTitle') }) ??
    latest({ head, tail, pick: typedField('ai-title', 'aiTitle') }) ??
    (first === null ? null : cleanFirstPrompt(first))
  return {
    kind: 'row',
    row: {
      provider: 'claude',
      id: input.id,
      file: input.file,
      title,
      cwd: latest({ head, tail, pick: (record) => nonEmpty(readString(record, 'cwd')) }),
      branch: latest({ head, tail, pick: (record) => nonEmpty(readString(record, 'gitBranch')) }),
      model: claudeModel(tail) ?? claudeModel(head),
      firstPrompt: preview(first),
      lastPrompt: last === null ? null : last.slice(0, PREVIEW_MAX),
      lastActivityAt: latest({ head, tail, pick: timestampOf }) ?? input.mtimeMs,
      empty: first === null && last === null && !(input.windows.headCut !== null && looksLikeCutHumanLine(input.windows.headCut)),
    },
  }
}

/** codex `event_msg` 의 payload type. */
const codexEventType = (record: Record<string, unknown>): string | null => {
  if (readString(record, 'type') !== 'event_msg') return null
  const payload = record['payload']
  return isRecord(payload) ? readString(payload, 'type') : null
}

/**
 * Codex 한 파일 → 행. 빈 세션(C17) = 앞뒤 창에 턴 시작(`event_msg/task_started`)도 사람 발화(`codexHumanText`)도 없는 세션
 * (코디 실측 a11 의 「턴 시작 0」 과 같은 규칙에 사람 발화를 더했다 — 사람 발화는 실측상 늘 task_started 뒤에 온다).
 */
export function parseCodexSession(input: { fileId: string | null; file: string; windows: Windows; mtimeMs: number }): ParseOutcome {
  const head = tailRecords({ chunk: input.windows.head, partial: false })
  const tail = input.windows.tailPartial ? tailRecords({ chunk: input.windows.tail, partial: true }) : head
  const meta = head[0]
  if (meta === undefined || readString(meta, 'type') !== 'session_meta' || !isRecord(meta['payload'])) return { kind: 'unreadable' }
  const payload = meta['payload']
  if (readString(payload, 'originator') !== CODEX_INTERACTIVE) return { kind: 'excluded' }
  const id = readString(payload, 'id') ?? input.fileId
  if (id === null) return { kind: 'unreadable' }
  // R2-8 — UUID 꼴이 아닌 id 는 상세·재개·Finder 가 받지 못하므로 Claude(R1-3)와 같이 제외로 센다.
  if (!isSessionId(id)) return { kind: 'excluded' }
  const first = firstOf(head, codexHumanText) ?? (input.windows.tailPartial ? firstOf(tail, codexHumanText) : null)
  const last = codexLastPrompt(tail) ?? (input.windows.tailPartial ? codexLastPrompt(head) : null)
  const started = [...head, ...tail].some((record) => codexEventType(record) === 'task_started')
  const contextCwd = (record: Record<string, unknown>): string | null => {
    if (readString(record, 'type') !== 'turn_context' || !isRecord(record['payload'])) return null
    return nonEmpty(readString(record['payload'], 'cwd'))
  }
  const git = payload['git']
  return {
    kind: 'row',
    row: {
      provider: 'codex',
      id,
      file: input.file,
      // 이름(`session_index.jsonl` thread_name)은 스캔마다 `SessionHistory.list` 가 앞에 얹는다.
      title: first === null ? null : cleanFirstPrompt(first),
      cwd: latest({ head, tail, pick: contextCwd }) ?? nonEmpty(readString(payload, 'cwd')),
      // codex 기록의 git 칸에는 브랜치가 없다(commit_hash·repository_url) — 있을 때만 쓴다.
      branch: isRecord(git) ? nonEmpty(readString(git, 'branch')) : null,
      model: codexModel(tail) ?? codexModel(head),
      firstPrompt: preview(first),
      lastPrompt: last === null ? null : last.slice(0, PREVIEW_MAX),
      lastActivityAt: latest({ head, tail, pick: timestampOf }) ?? input.mtimeMs,
      empty: !started && first === null && last === null,
    },
  }
}

/** `rollout-<시각>-<uuid>.jsonl` 의 uuid — 없으면 null. */
function codexFileId(file: string): string | null {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.basename(file))
  return match?.[1] ?? null
}

/** 같은 세션 id 의 두 기록 중 무엇을 남기나(R4-1·R5-2) — 마지막 활동 → mtime → 크기가 큰 쪽, 모두 같으면 경로가 앞선 쪽(`readdir` 순서와 무관). */
export type RecordChoice = { row: { lastActivityAt: number; file: string }; mtimeMs: number; size: number }
export function preferRecord({ candidate, current }: { candidate: RecordChoice; current: RecordChoice }): boolean {
  const order = [candidate.row.lastActivityAt - current.row.lastActivityAt, candidate.mtimeMs - current.mtimeMs, candidate.size - current.size].find((diff) => diff !== 0)
  return order === undefined ? candidate.row.file < current.row.file : order > 0
}

type ResumeFlight = { until: number; paneId: string | null; paneSeen: boolean; agentSeen: boolean }

export type ResumeContext = {
  /** 등록 레포 — 원래 cwd 가 없을 때 그 세션이 속한 레포 root 에서 재개한다(C7). */
  repos: readonly { root: string; worktrees: readonly string[] }[]
  home: string
}

export type SessionHistoryDeps = {
  roots: () => HistoryRoots
  /**
   * Codex 가 원래 cwd 가 없을 때도 재개되나(C7 Codex 분기). false 면 그 세션은 재개 비활성 + 사유(복사만).
   * 값은 C12 ⓑ 실측이 정했다 — `main/index.ts` 는 true(원래 cwd 없이도 재개된다 — 근거 주석은 그 자리). false 는 끄는 길로만 남긴다.
   */
  codexResumesWithoutCwd: boolean
}

/** 목록·상세·재개 계획. 마지막 스캔 결과를 쥐고, IPC 가 렌더러의 경로가 아니라 **이 결과에서** 파일을 찾는다(C19). */
export class SessionHistory {
  private readonly deps: SessionHistoryDeps
  private readonly cache = new Map<string, CacheEntry>()
  private codexIndex: { size: number; mtimeMs: number; names: Map<string, string> } | null = null
  /** provider 별 마지막 스캔 행(R3-4) — 스캔은 자기가 훑은 provider 만 바꾼다. 겹친 스캔이 어떤 순서로 끝나도 다른 provider 의 행을 지우지 않는다. */
  private readonly rows = new Map<HistoryProvider, Map<string, SessionHistoryRow>>()
  /** 진행 중 재개(R1-2·R2-3) — `provider:id` → 그 재개가 만든 pane 과 관측. 규칙은 `resumeFlight`. */
  private readonly resuming = new Map<string, ResumeFlight>()
  /** 시험용 계측 — 목록 스캔이 읽은 바이트·파싱한 파일 수, 상세가 읽은 바이트. */
  stats = { scanBytes: 0, parsed: 0, detailBytes: 0, scans: 0, duplicates: 0 }

  constructor(deps: SessionHistoryDeps) {
    this.deps = deps
  }

  /** 마지막 스캔에서 본 행. 목록에 없으면 null(거절 근거 — C19). */
  findRow(key: SessionKey): SessionHistoryRow | null {
    return this.rows.get(key.provider)?.get(key.id) ?? null
  }

  /**
   * 진행 중 재개 표지(R1-2·R2-3) — 재개가 만든 pane 에 묶는다.
   * · 기동 중(pane 모름) · 만든 pane 이 아직 안 보이거나 에이전트가 아직 안 뜸 → `until` 까지 pending(상한은 끝내 안 나타날 때만 쓰인다)
   * · 만든 pane 이 있고 그 provider 에이전트가 감지됨 → open(그 pane) — 세션 참조가 다른 id 여도 중복 재개하지 않는다
   * · 한 번 보인 pane 이 사라졌거나, 감지됐던 에이전트가 끝남 → 바로 푼다(none)
   */
  resumeFlight(input: { key: string; provider: HistoryProvider; panes: readonly PaneSession[]; now: number }): { kind: 'none' } | { kind: 'pending' } | { kind: 'open'; paneId: string } {
    const flight = this.resuming.get(input.key)
    if (flight === undefined) return { kind: 'none' }
    const pane = flight.paneId === null ? undefined : input.panes.find((entry) => entry.paneId === flight.paneId)
    if (pane !== undefined) flight.paneSeen = true
    if (pane !== undefined && pane.agent === input.provider) {
      flight.agentSeen = true
      return { kind: 'open', paneId: pane.paneId }
    }
    const gone = flight.paneSeen && (pane === undefined || flight.agentSeen)
    if (!gone && flight.until > input.now) return { kind: 'pending' }
    this.resuming.delete(input.key)
    return { kind: 'none' }
  }
  /**
   * R7 — 요청과 무관하게 만든 pane 을 관측한다(main 이 상태를 발행할 때마다). 재개한 탭의 에이전트가 떴다가 다음 요청 전에 끝나도
   * `agentSeen` 이 남아, 다음 `resumeFlight` 가 상한을 기다리지 않고 바로 푼다.
   */
  observeResumes(panes: readonly PaneSession[]): void {
    for (const [key, flight] of this.resuming) {
      const pane = flight.paneId === null ? undefined : panes.find((entry) => entry.paneId === flight.paneId)
      if (pane === undefined) continue
      flight.paneSeen = true
      if (pane.agent !== null && key.startsWith(`${pane.agent}:`)) flight.agentSeen = true // key = `provider:id`
    }
  }
  beginResume(input: { key: string; until: number }): void {
    this.resuming.set(input.key, { until: input.until, paneId: null, paneSeen: false, agentSeen: false })
  }
  /** 기동이 pane 을 돌려줬다 — 표지를 그 pane 에 묶는다. */
  attachResume(input: { key: string; paneId: string }): void {
    const flight = this.resuming.get(input.key)
    if (flight !== undefined) flight.paneId = input.paneId
  }
  endResume(key: string): void {
    this.resuming.delete(key)
  }

  async list(input: unknown, context: ResumeContext = { repos: [], home: os.homedir() }): Promise<SessionHistoryListResult> {
    const providers = readProviders(input)
    if (providers === null) return { kind: 'error', message: '잘못된 요청' }
    this.stats.scans += 1
    const roots = this.deps.roots()
    try {
      const rows: SessionHistoryRow[] = []
      let unreadable = 0
      const seen = new Set<string>()
      const realMemo = new Map<string, Promise<{ key: string; exists: boolean }>>()
      for (const provider of providers) {
        // Claude 파일 이름 = 세션 id. UUID 꼴이 아닌 이름(`<uuid>.orphaned-<n>.jsonl` 등)은 재개·상세가 받지 못하므로 제외로 센다(R1-3) — 읽지도 않는다.
        const files = provider === 'claude' ? (await claudeFiles(roots.claudeDir)).filter((file) => isSessionId(path.basename(file, '.jsonl'))) : await codexFiles(roots.codexDir)
        const names = provider === 'codex' ? await this.readCodexIndex(roots.codexDir) : new Map<string, string>()
        const outcomes = await mapLimit(files, SCAN_CONCURRENCY, (file) => this.scanFile({ provider, file }))
        // R4-1 — 같은 세션 id 의 기록이 여러 파일(두 프로젝트 폴더 등)이면 행 하나만: 마지막 활동 → mtime → 크기가 큰 쪽. 나머지는 제외로 센다.
        const kept = new Map<string, { row: SessionHistoryRow; mtimeMs: number; size: number }>()
        for (const [index, outcome] of outcomes.entries()) {
          const file = files[index]
          if (file !== undefined) seen.add(file)
          if (outcome === null || outcome.kind === 'excluded') continue
          if (outcome.kind === 'unreadable') {
            unreadable += 1
            continue
          }
          const parsed = outcome.row
          const cwd = parsed.cwd === null ? null : await memo(realMemo, parsed.cwd, cwdIdentity)
          const stat = file === undefined ? undefined : this.cache.get(file)
          const candidate = {
            row: { ...parsed, title: (provider === 'codex' ? names.get(parsed.id) : undefined) ?? parsed.title, cwdKey: cwd?.key ?? null, cwdExists: cwd?.exists ?? false },
            mtimeMs: stat?.mtimeMs ?? 0,
            size: stat?.size ?? 0,
          }
          const current = kept.get(parsed.id)
          if (current !== undefined) {
            this.stats.duplicates += 1
            if (!preferRecord({ candidate, current })) continue
          }
          kept.set(parsed.id, candidate)
        }
        for (const entry of kept.values()) rows.push(entry.row)
      }
      // 사라진 파일의 캐시는 버린다 — 끈 provider 의 캐시는 남겨 둔다(다시 켜면 다시 쓴다).
      for (const file of [...this.cache.keys()]) if (!seen.has(file) && providers.some((provider) => file.startsWith(rootOf(roots, provider)))) this.cache.delete(file)
      rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      for (const provider of providers) this.rows.set(provider, new Map(rows.filter((row) => row.provider === provider).map((row) => [row.id, row])))
      const realpaths: Record<string, string> = {}
      for (const repo of context.repos)
        for (const dir of [repo.root, ...repo.worktrees]) {
          const identity = await memo(realMemo, dir, cwdIdentity)
          if (identity.exists) realpaths[dir] = identity.key
        }
      return { kind: 'ok', rows, unreadable, realpaths }
    } catch (error) {
      return { kind: 'error', message: String(error instanceof Error ? error.message : error).slice(0, 300) }
    }
  }

  /** 파일 하나 — stat 이 캐시와 같으면 파싱하지 않는다(C11). 그 사이 사라진 파일은 null. */
  private async scanFile(input: { provider: HistoryProvider; file: string }): Promise<ParseOutcome | null> {
    let handle: fs.promises.FileHandle
    try {
      handle = await fs.promises.open(input.file, 'r')
    } catch (error) {
      if (isMissing(error)) return null
      return { kind: 'unreadable' }
    }
    try {
      const stat = await handle.stat()
      const cached = this.cache.get(input.file)
      if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.outcome
      const windows = await readWindows({ handle, size: stat.size, onRead: (bytes) => { this.stats.scanBytes += bytes } })
      this.stats.parsed += 1
      const outcome =
        input.provider === 'claude'
          ? parseClaudeSession({ id: path.basename(input.file, '.jsonl'), file: input.file, windows, mtimeMs: stat.mtimeMs })
          : parseCodexSession({ fileId: codexFileId(input.file), file: input.file, windows, mtimeMs: stat.mtimeMs })
      this.cache.set(input.file, { size: stat.size, mtimeMs: stat.mtimeMs, outcome })
      return outcome
    } catch {
      return { kind: 'unreadable' }
    } finally {
      await handle.close()
    }
  }

  /** `session_index.jsonl` id → thread_name (같은 id 가 여럿이면 뒤의 것). 파일이 없으면 빈 표. */
  private async readCodexIndex(codexDir: string): Promise<Map<string, string>> {
    const file = path.join(codexDir, 'session_index.jsonl')
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(file)
    } catch {
      return new Map()
    }
    if (this.codexIndex !== null && this.codexIndex.size === stat.size && this.codexIndex.mtimeMs === stat.mtimeMs) return this.codexIndex.names
    const names = new Map<string, string>()
    try {
      const text = await fs.promises.readFile(file, 'utf8')
      for (const record of tailRecords({ chunk: text, partial: false })) {
        const id = readString(record, 'id')
        const name = nonEmpty(readString(record, 'thread_name'))
        if (id !== null && name !== null) names.set(id, name)
      }
    } catch {
      return new Map()
    }
    this.codexIndex = { size: stat.size, mtimeMs: stat.mtimeMs, names }
    return names
  }

  /**
   * 상세(C6) — 기록 전체를 스트리밍으로 읽어 기존 말풍선 조립기(`ChatBuilder`)에 먹인다.
   *
   * 메시지 수 = 조립된 말풍선 중 **사람 발화(prompt) + 응답(reply)** 의 개수. 도구 묶음·질문 카드·표지(중단·압축)는 세지 않는다.
   * 응답은 조립기 규칙대로 같은 `message.id`(Claude) 의 연속 조각을 한 말풍선으로 센다. 첫 프롬프트 = 첫 prompt 말풍선의 원문 전문.
   */
  async detail(input: unknown, context: ResumeContext): Promise<SessionHistoryDetailResult> {
    const key = readSessionKey(input)
    if (key === null) return { kind: 'error', message: '잘못된 세션 식별자' }
    const row = this.findRow(key)
    if (row === null) return { kind: 'error', message: '목록에 없는 세션입니다 — 새로고침하세요' }
    const builder = new ChatBuilder({ agent: row.provider, sessionId: row.provider === 'claude' ? row.id : null })
    try {
      await streamLines({ file: row.file, onRead: (bytes) => { this.stats.detailBytes += bytes }, onLine: (line) => builder.feed(line) })
    } catch (error) {
      return { kind: 'error', message: isMissing(error) ? '기록 파일이 사라졌습니다' : `기록을 읽지 못했습니다 — ${String(error).slice(0, 200)}` }
    }
    const turns: SessionHistoryTurn[] = []
    let firstPrompt: string | null = null
    for (const item of builder.items) {
      if (item.kind !== 'prompt' && item.kind !== 'reply') continue
      if (item.kind === 'prompt' && firstPrompt === null) firstPrompt = item.text
      turns.push({ role: item.kind, text: item.text, at: item.at })
    }
    const resume = this.resumePlan({ row, context })
    return {
      kind: 'ok',
      detail: {
        provider: row.provider,
        id: row.id,
        file: row.file,
        firstPrompt,
        recent: turns.slice(-RECENT_TURNS).map((turn) => ({ ...turn, text: turn.text.slice(0, TURN_TEXT_MAX) })),
        messageCount: turns.length,
        cwd: row.cwd,
        cwdExists: row.cwdExists,
        resume,
        command: resumeCommandText(resume),
      },
    }
  }

  /**
   * 재개 계획(C7): 원래 cwd 가 있으면 거기 · 없으면 그 세션이 속한 등록 레포 root · 그것도 없으면 가장 가까운 존재하는 조상(최후 = 홈).
   * Codex 는 `codexResumesWithoutCwd` 가 false 면 대체 cwd 재개를 막는다.
   */
  resumePlan(input: { row: SessionHistoryRow; context: ResumeContext }): ResumePlan {
    const { row, context } = input
    const argv = resumeArgv(row)
    // R3-1 — 스캔 때의 `cwdExists` 가 아니라 **지금** 디스크를 본다(목록 뒤 지운 worktree 를 원래 cwd 로 내보내지 않게).
    if (row.cwd !== null && isDirectory(row.cwd)) return { argv, cwd: row.cwd, fallback: false, disabled: null }
    const cwd = fallbackCwd({ cwd: row.cwdKey ?? row.cwd, context })
    const disabled = row.provider === 'codex' && !this.deps.codexResumesWithoutCwd ? CODEX_RESUME_DISABLED : null
    return { argv, cwd, fallback: true, disabled }
  }
}

/** `codexResumesWithoutCwd=false` 일 때의 사유 — 끈 것이지 「안 된다」 가 아니다(C12 ⓑ 실측상 된다). */
export const CODEX_RESUME_DISABLED = 'Codex 의 다른 폴더 재개를 꺼 두었습니다 — 명령만 복사하세요'

/** 있는 경로면 realpath, 아니면 그대로(R2-6 — 행 `cwdKey` 와 같은 눈). */
function realOrSelf(dir: string): string {
  try {
    return fs.realpathSync.native(dir)
  } catch {
    return dir
  }
}

/** 원래 폴더가 없을 때의 재개 자리. 등록 root·worktree 는 realpath 로도 비교한다(R2-6). */
function fallbackCwd(input: { cwd: string | null; context: ResumeContext }): string {
  const { cwd, context } = input
  if (cwd === null) return context.home
  for (const repo of context.repos) {
    const bases = [repo.root, ...repo.worktrees].flatMap((dir) => [dir, realOrSelf(dir)])
    if (bases.some((parent) => isPathWithin({ child: cwd, parent })) && isDirectory(repo.root)) return repo.root
  }
  let probe = path.dirname(cwd)
  while (probe !== path.dirname(probe)) {
    if (isDirectory(probe)) return probe
    probe = path.dirname(probe)
  }
  return isDirectory(probe) ? probe : context.home
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function rootOf(roots: HistoryRoots, provider: HistoryProvider): string {
  return provider === 'claude' ? roots.claudeDir : roots.codexDir
}

function readProviders(input: unknown): HistoryProvider[] | null {
  if (!isRecord(input) || !Array.isArray(input['providers'])) return null
  const out: HistoryProvider[] = []
  for (const value of input['providers']) {
    if (value !== 'claude' && value !== 'codex') return null
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** cwd 의 비교 키 — 있으면 realpath, 없으면 문자열 정규화(C4). */
async function cwdIdentity(cwd: string): Promise<{ key: string; exists: boolean }> {
  try {
    const real = await fs.promises.realpath(cwd)
    const stat = await fs.promises.stat(real)
    return { key: real, exists: stat.isDirectory() }
  } catch {
    return { key: path.resolve(cwd), exists: false }
  }
}

function memo<T>(table: Map<string, Promise<T>>, key: string, make: (key: string) => Promise<T>): Promise<T> {
  const existing = table.get(key)
  if (existing !== undefined) return existing
  const created = make(key)
  table.set(key, created)
  return created
}

/** `<claudeDir>/projects/<폴더>/*.jsonl` — 폴더가 없으면 빈 목록, 그 밖의 오류는 던진다(스캔 실패 화면). */
async function claudeFiles(claudeDir: string): Promise<string[]> {
  const projects = path.join(claudeDir, 'projects')
  let dirs: fs.Dirent[]
  try {
    dirs = await fs.promises.readdir(projects, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const lists = await mapLimit(dirs.filter((dir) => dir.isDirectory()), SCAN_CONCURRENCY, async (dir) => {
    const folder = path.join(projects, dir.name)
    try {
      const entries = await fs.promises.readdir(folder, { withFileTypes: true })
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => path.join(folder, entry.name))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  })
  return lists.flat()
}

/** `<codexDir>/sessions/**\/rollout-*.jsonl`. */
async function codexFiles(codexDir: string): Promise<string[]> {
  const sessions = path.join(codexDir, 'sessions')
  let entries: string[]
  try {
    entries = await fs.promises.readdir(sessions, { recursive: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return entries.filter((entry) => path.basename(entry).startsWith('rollout-') && entry.endsWith('.jsonl')).map((entry) => path.join(sessions, entry))
}

/** 앞뒤 창. 파일이 두 창보다 작으면 통째로 한 번 읽는다(같은 바이트를 두 번 읽지 않는다). */
async function readWindows(input: { handle: fs.promises.FileHandle; size: number; onRead: (bytes: number) => void }): Promise<Windows> {
  const read = async (position: number, length: number): Promise<string> => {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await input.handle.read(buffer, 0, length, position)
    input.onRead(bytesRead)
    return buffer.subarray(0, bytesRead).toString('utf8')
  }
  if (input.size <= SCAN_HEAD_BYTES + SCAN_TAIL_BYTES) {
    const whole = await read(0, input.size)
    return { head: whole, tail: whole, tailPartial: false, headCut: null }
  }
  const head = await read(0, SCAN_HEAD_BYTES)
  const tail = await read(input.size - SCAN_TAIL_BYTES, SCAN_TAIL_BYTES)
  return { head, tail, tailPartial: true, headCut: head.slice(head.lastIndexOf('\n') + 1) }
}

/** 파일을 줄 단위로 끝까지 — 줄의 바이트 위치를 함께 준다(말풍선 id). 개행으로 끝나지 않은 마지막 줄도 준다. */
async function streamLines(input: { file: string; onRead: (bytes: number) => void; onLine: (line: { offset: number; line: string }) => void }): Promise<void> {
  const stream = fs.createReadStream(input.file)
  let pending: Buffer = Buffer.alloc(0)
  let offset = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    input.onRead(bytes.length)
    let data = pending.length === 0 ? bytes : Buffer.concat([pending, bytes])
    let newline = data.indexOf(0x0a)
    while (newline >= 0) {
      input.onLine({ offset, line: data.subarray(0, newline).toString('utf8') })
      offset += newline + 1
      data = data.subarray(newline + 1)
      newline = data.indexOf(0x0a)
    }
    pending = data
  }
  if (pending.length > 0) input.onLine({ offset, line: pending.toString('utf8') })
}

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item !== undefined) out[index] = await work(item)
    }
  })
  await Promise.all(lanes)
  return out
}

// --- 재개·Finder (C7·C8·C19) — IPC 처리부가 부르는 순수에 가까운 함수 ------------------------------------

/** 재개가 만든 pane 이 에이전트로 보일 때까지 기다리는 상한 — 끝내 안 나타날 때만 쓰인다(R2-3). 그 사이 같은 재개는 새 프로세스를 만들지 않는다. */
export const RESUME_PENDING_MS = 30_000

export type OpenPane = PaneSession

export type ResumeDeps = {
  history: SessionHistory
  context: () => ResumeContext
  /** 지금 corral pane 들의 감지된 에이전트·세션 참조 — 같은 세션이 열려 있으면 새 프로세스를 띄우지 않는다(C8, `isOpenSession`). */
  openPanes: () => OpenPane[]
  now?: () => number
  /** 에이전트 탭 기동 — 기존 `createRow`(tab.create → agent.start) 경로에 cwd·args 를 더한 것. */
  createRow: (input: { workspaceId: string; kind: HistoryProvider; cwd: string; args: string[] }) => Promise<{ ok: boolean; paneId: string | null; tabId: string | null; error: string | null }>
}

/** 재개(C7·C8) — 렌더러는 식별자만 준다. argv·cwd 는 main 이 스캔 결과로 다시 정한다. */
export async function resumeSession(input: unknown, deps: ResumeDeps): Promise<SessionHistoryResumeResult> {
  const key = readSessionKey(input)
  const workspaceId: unknown = isRecord(input) ? input['workspaceId'] : undefined
  if (key === null) return { kind: 'rejected', reason: '잘못된 세션 식별자' }
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return { kind: 'rejected', reason: '열린 worktree 가 없습니다' }
  const row = deps.history.findRow(key)
  if (row === null) return { kind: 'rejected', reason: '목록에 없는 세션입니다 — 새로고침하세요' }
  const flight = `${row.provider}:${row.id}`
  const panes = deps.openPanes()
  const open = openPaneOf({ panes, key: row })
  if (open !== null) {
    deps.history.endResume(flight)
    return { kind: 'open', paneId: open }
  }
  const now = (deps.now ?? Date.now)()
  const inFlight = deps.history.resumeFlight({ key: flight, provider: row.provider, panes, now })
  if (inFlight.kind !== 'none') return inFlight
  const plan = deps.history.resumePlan({ row, context: deps.context() })
  if (plan.disabled !== null) return { kind: 'rejected', reason: plan.disabled }
  // 표지는 기동을 걸기 **전에** 세운다 — tab.create·agent.start 가 수 초 걸리는 동안 들어온 두 번째 요청도 막는다.
  deps.history.beginResume({ key: flight, until: now + RESUME_PENDING_MS })
  try {
    const created = await deps.createRow({ workspaceId, kind: row.provider, cwd: plan.cwd, args: plan.argv.slice(1) })
    if (created.ok) {
      if (created.paneId !== null) deps.history.attachResume({ key: flight, paneId: created.paneId })
      return { kind: 'started', paneId: created.paneId, tabId: created.tabId, workspaceId }
    }
    deps.history.endResume(flight)
    return { kind: 'error', message: created.error ?? '탭을 만들지 못했습니다' }
  } catch (error) {
    deps.history.endResume(flight)
    return { kind: 'error', message: String(error).slice(0, 200) }
  }
}

/** Finder 에서 보기(C19) — 렌더러가 준 경로를 열지 않는다. 식별자로 스캔 결과의 파일을 찾고, 지금 있는지 본 뒤 연다. */
export async function revealSession(input: unknown, deps: { history: SessionHistory; show: (file: string) => void }): Promise<SessionHistoryRevealResult> {
  const key = readSessionKey(input)
  if (key === null) return { kind: 'rejected', reason: '잘못된 세션 식별자' }
  const row = deps.history.findRow(key)
  if (row === null) return { kind: 'rejected', reason: '목록에 없는 세션입니다' }
  try {
    await fs.promises.access(row.file, fs.constants.R_OK)
  } catch {
    return { kind: 'error', message: '기록 파일이 사라졌습니다' }
  }
  deps.show(row.file)
  return { kind: 'ok' }
}

/** 실행 환경의 기록 루트. */
export const defaultHistoryRoots = (): HistoryRoots => historyRoots({ env: process.env, home: os.homedir() })
