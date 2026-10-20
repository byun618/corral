// 작업 링크 (LIFE-603 · 묶음 K11·K8) — main 쪽 한 곳.
//
// 1. **해석해서 싣기**(`annotate`): 트리를 내보낼 때마다 `repos.json` 메타(명시 링크 · 예외)와 연결의 키 모양으로 worktree 마다 링크를 정해
//    `WorktreeRow.workLink` 에 싣는다. 판정은 `shared/work-link.ts` 의 `resolveWorkLink` 하나 — 사이드바 · 작업 중 · 칩 · 상세가 같은 값을 본다.
// 2. **쓰기**(`saveExplicit`·`detach`): `RepoRegistry.change()` 잠금을 지난다(CLI `worktree set` 과 같은 잠금). 런타임 workspace 줄은 타지 않는다 —
//    시작이 그 줄을 잡고 에이전트 ready 를 기다리는 동안에도 링크 저장·떼기가 줄 서지 않는다(F3).
// 3. **사건 기록**(`observe`): 링크된 worktree 의 실행(자동 연결)·에이전트(질문 · 턴 결과) 사건을 활동에 남긴다. 작업 페이지가 닫혀 있어도 main 이 남긴다.
//    같은 사건은 `eventKey` 로 한 번만(재시작 · 상태 재방송 · 같은 질문 재관측). 열쇠는 설계 메모 §4.
// 4. **기존 링크 이관**(LIFE-635 C4 · D4): 이 실행 전에 생긴 명시 링크·자동 연결을 출처에 **덧붙인다**(멱등 저장 — 같은 링크 = 한 행).
//    로컬(`repos.json`)은 읽기만 한다 — 이관은 레지스트리 `change()` 를 부르지 않는다. 출처 행을 지우는 길은 없다(지우기는 「작업 떼기」 하나).
//    한 번에 한 건씩(직렬), 실패는 같은 자격으로 다시 보내도 되는 것(네트워크·5xx·응답 깨짐)만 간격을 두고 상한까지 — 인증·권한·거절은 멈추고
//    토큰을 바꾸면(새 자격 세대) 다시. 능력을 모르는 연결(클라이언트 전)은 요청 0 으로 기다린다(앱 기동이 금고를 열지 않는다). 메모리만 — 재기동하면 한 번 더 보낸다(멱등).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DetachWorkLinkResult, RepoRow, WorktreeRow, PaneRow } from '../../shared/types.js'
import type { WorkActivityChange, WorkLink } from '../../shared/work.js'
import { waitingQuestion } from '../../shared/agent-dot.js'
import { resolveWorkLink, type LinkConnection, type StoredWorkLink, type WorktreeWorkLink } from '../../shared/work-link.js'
import type { StartSourceLink } from '../../shared/work-start.js'
import type { DroppedLink, WorktreeMetadataRecord } from '../registry.js'
import type { LinkMigrateOutcome } from './service.js'

/** 미확정 시작의 붙이기 결과(R3-A·R3-C) — `claimExplicit`. */
export type ClaimResult = 'saved' | 'linked' | 'held' | 'failed'

export type LinkRegistryPort = {
  metadata(): Record<string, WorktreeMetadataRecord>
  droppedLinks(): DroppedLink[]
  change<T>(mutate: (data: { worktrees: Record<string, WorktreeMetadataRecord> }) => T): T
}

export type LinkWorkPort = {
  linkConnections(): LinkConnection[]
  repoDefaultConnection(repoRoot: string): string | null
  recordEvent(input: { connectionId: string; itemId: string | null; itemKey: string; eventKey: string; change: WorkActivityChange }): boolean
  /** 이미 남긴 사건의 내용을 고친다(R1-M — 턴 결과의 바뀐 파일 수). 그 열쇠가 없거나 같으면 false. */
  refreshEvent(input: { eventKey: string; change: WorkActivityChange }): boolean
  storeLink(input: { connectionId: string; itemId: string; link: WorkLink; action: 'save' | 'remove' }): Promise<StartSourceLink>
  /** 자동 연결의 출처 저장(R1-I). 능력을 아직 모르면 null — 다음 관측에서 다시. */
  storeAutoLink(input: { connectionId: string; key: string; link: WorkLink }): Promise<StartSourceLink | null>
  /** 기존 링크 이관 한 건(LIFE-635). 없는 포트(시험 가짜)는 이관하지 않는다. */
  migrateLink?(input: { connectionId: string; itemId: string | null; key: string; link: WorkLink }): Promise<LinkMigrateOutcome>
  /** 연결의 자격 세대 — 멈춘 이관을 새 토큰으로 다시 시작할지 가른다. */
  credentialGeneration?(connectionId: string): number
  /** 자동 연결 떼기의 출처 지우기(LIFE-635 X1-1) — 키로 작업을 찾아 remove. 없는 포트(시험 가짜)는 출처를 건드리지 않는다. */
  removeAutoLink?(input: { connectionId: string; key: string; link: WorkLink }): Promise<StartSourceLink>
}

/** 이관 재시도 상한(같은 실행 안, 링크 하나당 보내는 횟수) · 첫 간격(두 배씩). 넘으면 다음 실행까지 멈춘다(LIFE-635 C4 ⓒ — design-notes §4). */
export const MIGRATE_MAX_ATTEMPTS = 3
export const MIGRATE_RETRY_MS = 30_000

/**
 * 이관 한 건의 상태 — `pending`(보낼 것) · `done`(저장됨·건너뜀·시작이 이미 보냄) · `stopped`(같은 자격으로 다시 보내지 않는 실패 — 새 세대면 다시) ·
 * `exhausted`(재시도 상한 — 이 실행에서는 끝). `deferred` = 능력 모름 — 다음 관측까지 기다린다.
 */
type Migration = {
  connectionId: string
  itemId: string | null
  key: string
  worktree: string
  repoRoot: string
  state: 'pending' | 'done' | 'stopped' | 'exhausted'
  attempts: number
  nextAt: number
  deferred: boolean
  generation: number | null
  /** 실패를 남길 활동 열쇠 — 이 실행에서 처음 본 자동 연결은 자동 연결 저장과 같은 열쇠(`run:srcfail:<자동 사건 열쇠>`), 그 밖은 이관 열쇠. */
  activityKey: string
  /** 마지막 관측 트리에 있나 — 전송 후보 여부만 가른다. 실패 이력(상태·시도·다음 시각·세대)은 트리에서 빠져도 남는다(X2-2 · X3-1). */
  present: boolean
}

/**
 * 이관 상태 규칙(X3-1·X3-2 — design-notes §12): 항목(= 링크별 이력)은 **사용자 떼기로만** 지도에서 지운다. 저장 성공은 `done` 으로 남고,
 * 자격 세대 교체는 이력을 처음으로 되돌린다. 트리 누락·응답 대기·관측 순서로는 지우지 않는다(보내는 중인 항목의 응답도 같은 객체에 적힌다).
 * 메모리 상한은 **보류**로: 아직 이력이 필요한 항목(`done` 아닌 것)이 이만큼 있으면 새 링크의 항목을 만들지 않는다. 저장 성공(`done`)은 자리로 세지 않는다(X4-1) —
 * 앞 항목이 성공해 자리가 나면 같은 실행에서 보류된 링크를 이어 받는다(`done` 항목은 남아 같은 링크를 다시 보내지 않는다).
 */
export const MIGRATE_MAX_ENTRIES = 500

/** 턴 결과 뒤 이 시간 안에는 바뀐 파일 수를 다시 읽어 고친다(R1-M — git 상태 폴링이 결과보다 늦게 올 수 있다). */
export const FILES_SETTLE_MS = 60_000

export type LinkDeps = {
  registry: () => LinkRegistryPort | null
  work: () => LinkWorkPort | null
  log: (event: string, data: Record<string, unknown>) => void
  /** 시계 · 다시 보기 타이머 — 시험이 바꾼다. 기본 `Date.now` · `setTimeout`(unref). */
  now?: () => number
  schedule?: (run: () => void, ms: number) => void
  /**
   * worktree 의 세대(R2-J ⓑ) — 같은 경로를 지웠다 다시 만들면 바뀌는 값. 자동 연결 열쇠에 넣어 다시 만든 worktree 의 자동 연결도 남게 한다.
   * 기본 = `<path>/.git` 의 생성 시각(ms, 정수). 못 읽으면 null(열쇠의 세대 칸은 `na`).
   */
  generation?: (worktreePath: string) => string | null
}

function gitBirth(worktreePath: string): string | null {
  try {
    const stat = fs.statSync(path.join(worktreePath, '.git'))
    return String(Math.trunc(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs))
  } catch {
    return null
  }
}

/**
 * 본문 없는 질문 대기를 남기기 전에 기다리는 시간(R2-C). 지문 계약은 「질문이 없으면 null」 하나라(`SessionDigest.pendingQuestions` —
 * 빈 배열은 오지 않는다) 「기록을 아직 안 읽음」 과 「읽었는데 본문 없음」 이 같은 값이다. herdr 의 막힘 사유는 곧장 오고 기록 판독은
 * 1.5초 폴링이므로, 판독 두 번(3초) 동안 그대로 본문이 없을 때만 「본문 없음」 으로 남긴다. 그 사이 본문이 오면 본문 줄 하나만 남는다.
 */
export const QUESTION_SETTLE_MS = 3_000


const sha8 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

function branchName(branch: string | null): string | null {
  return branch === null ? null : branch.replace(/^refs\/heads\//, '')
}

function sessionOf(pane: PaneRow): string {
  const ref = pane.agentSession
  return ref === null ? `pane:${pane.paneId}` : ref.kind === 'id' ? ref.id : ref.path
}

function filesChanged(worktree: WorktreeRow): number | null {
  const git = worktree.gitStatus
  if (git.error !== null) return null
  return git.staged + git.unstaged + git.untracked + git.conflicted
}

export class WorkLinks {
  private readonly deps: LinkDeps
  private droppedSeen = ''
  /** 출처 저장을 기다리는 자동 연결(R1-I) — 열쇠 = 사건 열쇠. 메모리만(재시작하면 그 회차는 출처에 안 남는다 — 설계 메모 §4). */
  /** 본문 없는 질문 대기를 처음 본 시각 — 열쇠 = 사건 열쇠(R2-C). */
  private readonly noBodySince = new Map<string, { since: number; recorded: boolean }>()
  private lastRepos: RepoRow[] | null = null
  /** 세대 캐시 — 트리에서 사라진 경로는 지운다(다시 나타나면 새로 읽는다). */
  private readonly generations = new Map<string, string | null>()
  private settleArmed = false
  private readonly autoStores = new Map<string, { connectionId: string; itemId: string | null; key: string; worktree: string; repoRoot: string; inFlight: boolean }>()
  /** 기존 링크 이관(LIFE-635) — 열쇠 = `연결:작업:경로`(작업 = id, 자동이면 `key:<키>`). */
  private readonly migrations = new Map<string, Migration>()
  private migrationLoop: Promise<void> | null = null
  private migrationTimerAt: number | null = null
  /**
   * worktree 경로 → 그 경로의 출처 쓰기 줄(X2-1). 시작 저장·미확정 시작 복구·자동 연결 저장·이관·떼기(명시·자동)가 **모두** 이 줄에 서서 한 번에 하나씩 나간다 —
   * 떼기의 remove 는 앞선 쓰기가 끝난 뒤 나가 그 링크의 마지막 연산이 된다.
   */
  private readonly writes = new Map<string, Promise<void>>()
  /** 경로마다 떼기 횟수 — 줄 선 add 는 나갈 차례에 이 값이 줄 설 때와 다르면(그사이 떼어졌으면) 보내지 않는다(X2-1). */
  private readonly detachCount = new Map<string, number>()
  /** 떼어진 경로 — 트리가 그 경로를 링크 없이 보일 때까지 이관·재시도가 보내지 않는다(X1-2). */
  private readonly detached = new Set<string>()
  /** 시작·복구의 출처 저장이 `later`(machine 미확정 — X3-3)로 미뤄진 경로 — 이 실행에 적힌 링크여도 이관이 보낸다(저장 성공·떼기로 풀린다). */
  private readonly owed = new Set<string>()
  /** 상한 보류를 로그에 한 번만. */
  private heldLogged = false
  /** 마지막 관측에서 상한으로 보류된 링크가 있나 — 자리가 나면 같은 실행에서 다시 관측해 받는다(X4-1). */
  private held = false
  /** 이 실행의 시작 시각 — 이보다 늦게 적힌 명시 링크는 시작이 이미 출처에 보냈다(이관하지 않는다). */
  private readonly bootAt: number

  constructor(deps: LinkDeps) {
    this.deps = deps
    this.bootAt = (deps.now ?? Date.now)()
  }

  /** 레지스트리를 못 읽으면 빈 메타 — 링크 없이 그린다(앱은 산다). */
  private metadata(): Record<string, WorktreeMetadataRecord> {
    const registry = this.deps.registry()
    if (registry === null) return {}
    try {
      const metadata = registry.metadata()
      const dropped = registry.droppedLinks()
      const signature = JSON.stringify(dropped)
      if (dropped.length > 0 && signature !== this.droppedSeen) this.deps.log('work.link_dropped', { dropped })
      this.droppedSeen = signature
      return metadata
    } catch {
      return {}
    }
  }

  /** 트리에 링크를 싣는다 — 연결이 없으면(작업 서비스 전) 명시 링크만, `connected: false`. */
  annotate(repos: RepoRow[]): RepoRow[] {
    const metadata = this.metadata()
    const work = this.deps.work()
    const connections = work?.linkConnections() ?? []
    return repos.map((repo) => {
      const defaultConnectionId = work?.repoDefaultConnection(repo.root) ?? null
      return {
        ...repo,
        worktrees: repo.worktrees.map((worktree) => {
          const meta = metadata[worktree.path]
          const workLink = resolveWorkLink({
            branch: branchName(worktree.branch),
            explicit: meta?.workLink ?? null,
            suppressed: meta?.workLinkSuppressed === true,
            defaultConnectionId,
            connections,
          })
          return { ...worktree, workLink }
        }),
      }
    })
  }

  /** 시작으로 만든 worktree 에 명시 링크(예외는 푼다 — 그 worktree 는 이 작업을 하려고 만든 것이다). */
  saveExplicit({ path, link }: { path: string; link: StoredWorkLink }): boolean {
    const registry = this.deps.registry()
    if (registry === null) return false
    try {
      registry.change((data) => {
        const current = data.worktrees[path] ?? {}
        data.worktrees[path] = { ...current, workLink: link, workLinkSuppressed: false }
      })
      // 새 링크다 — 앞 떼기의 「낡은 트리 막기」 는 끝(이 링크의 출처 저장은 시작이 `sourceSave` 로 보낸다).
      this.detached.delete(path)
      return true
    } catch (error) {
      this.deps.log('work.link_save_failed', { path, error: String(error) })
      return false
    }
  }

  /**
   * 미확정 시작에서 붙이기(R3-A·R3-C) — 이 시도가 만든 것인지 모르는 자리라 남의 것을 덮지 않는다. 잠금 안에서 보고 쓴다.
   * - `held`: 다른 작업의 명시 링크 · 떼기 예외가 있다 — 쓰지 않는다.
   * - `linked`: 같은 작업의 명시 링크가 이미 있다 — 쓰지 않는다(다른 시도가 붙였다).
   * - `saved` / `failed`: 비어 있어 썼다 / 쓰지 못했다.
   */
  claimExplicit({ path, link }: { path: string; link: StoredWorkLink }): ClaimResult {
    const registry = this.deps.registry()
    if (registry === null) return 'failed'
    try {
      const result = registry.change((data): ClaimResult => {
        const current = data.worktrees[path] ?? {}
        const existing = current.workLink ?? null
        if (existing !== null) return existing.connectionId === link.connectionId && existing.itemId === link.itemId ? 'linked' : 'held'
        if (current.workLinkSuppressed === true) return 'held'
        data.worktrees[path] = { ...current, workLink: link, workLinkSuppressed: false }
        return 'saved'
      })
      if (result === 'saved') this.detached.delete(path)
      return result
    } catch (error) {
      this.deps.log('work.link_save_failed', { path, error: String(error) })
      return 'failed'
    }
  }

  /**
   * 사이드바 「작업 떼기」 — 명시 링크면 지우고, 어느 쪽이든 그 worktree 를 자동 연결 예외로 둔다(명시 링크를 지운 뒤 브랜치 키로 다시 붙지 않게).
   * 실행 갈래에 「떼기」 를 남기고, 출처가 링크를 저장하는 능력이 있으면 출처의 링크도 지운다(실패해도 로컬 떼기는 그대로).
   */
  async detach({ worktree, repoRoot }: { worktree: WorktreeRow; repoRoot: string }): Promise<DetachWorkLinkResult> {
    const registry = this.deps.registry()
    const link = this.annotate([{ root: repoRoot, name: '', error: null, worktrees: [worktree] }])[0]?.worktrees[0]?.workLink ?? null
    if (registry === null) return { ok: false, error: '레지스트리를 읽지 못했습니다.' }
    if (link === null) return { ok: false, error: '이 worktree 에는 작업 링크가 없습니다.' }
    try {
      registry.change((data) => {
        const current = data.worktrees[worktree.path] ?? {}
        const { workLink: _removed, ...rest } = current
        void _removed
        data.worktrees[worktree.path] = { ...rest, workLinkSuppressed: true }
      })
    } catch (error) {
      return { ok: false, error: `링크를 떼지 못했습니다: ${String(error)}` }
    }
    // 이 링크의 이관·자동 저장은 더 보내지 않는다. 줄에 이미 선 add 는 나갈 차례에 떼기를 보고 빠지고, 이미 나간 쓰기는 끝난 뒤 지운다 —
    // 늦은 add(시작·복구·자동 연결·이관 어느 쪽이든)가 떼기를 뒤집지 않게(X1-2 · X2-1).
    this.detached.add(worktree.path)
    this.detachCount.set(worktree.path, (this.detachCount.get(worktree.path) ?? 0) + 1)
    for (const [key, entry] of this.migrations) if (entry.worktree === worktree.path) this.migrations.delete(key)
    this.owed.delete(worktree.path)
    for (const [key, entry] of this.autoStores) if (entry.worktree === worktree.path) this.autoStores.delete(key)
    const work = this.deps.work()
    const sourceLink = await this.queueWrite({ path: worktree.path, add: false, send: async () => {
      if (work === null) return null
      // 자동 연결은 작업 id 가 없다 — 키로 찾아 지운다(X1-1). 지우기 포트가 없으면(시험 가짜) 출처를 건드리지 않는다.
      const target: WorkLink = { kind: 'worktree', path: worktree.path, repoRoot }
      return link.itemId !== null ? work.storeLink({ connectionId: link.connectionId, itemId: link.itemId, link: target, action: 'remove' })
        : work.removeAutoLink === undefined ? null : work.removeAutoLink({ connectionId: link.connectionId, key: link.key, link: target })
    } })
    work?.recordEvent({
      connectionId: link.connectionId,
      itemId: link.itemId,
      itemKey: link.key,
      eventKey: `run:detach:${link.connectionId}:${link.key}:${worktree.path}:${Date.now()}`,
      change: { field: 'run', event: 'detach', worktree: worktree.path, branch: branchName(worktree.branch) },
    })
    // 출처 지우기 실패는 활동에도 남긴다(LIFE-635 C6) — 로컬 떼기는 이미 끝났다.
    if (sourceLink?.state === 'failed') {
      work?.recordEvent({
        connectionId: link.connectionId, itemId: link.itemId, itemKey: link.key, eventKey: `run:srcfail:detach:${link.connectionId}:${link.key}:${worktree.path}:${Date.now()}`,
        change: { field: 'run', event: 'source_link_failed', worktree: worktree.path, message: sourceLink.message },
      })
    }
    return { ok: true, mode: link.mode, sourceLink }
  }

  /**
   * 링크된 worktree 의 사건을 남긴다 — 상태를 내보낼 때마다 부른다. 같은 사건은 열쇠로 걸러져 한 번만 남는다.
   * 자동 연결 · 질문(본문 — 못 읽는 에이전트는 이유) · 턴 결과(완료 · 중단 · 실패 + 바뀐 파일 수).
   */
  observe(repos: RepoRow[]): void {
    const work = this.deps.work()
    if (work === null) return
    this.lastRepos = repos
    this.held = false
    const waiting = new Set<string>()
    const linkedAt = this.linkedTimes()
    const migrating = new Set<string>()
    const present = new Set(repos.flatMap((repo) => repo.worktrees.map((row) => row.path)))
    for (const known of [...this.generations.keys()]) if (!present.has(known)) this.generations.delete(known)
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        const link = worktree.workLink ?? null
        // 떼어진 경로를 링크 없이 보면 떼기가 트리에 닿았다 — 다시 붙으면 새 링크로 다룬다.
        if (link === null) this.detached.delete(worktree.path)
        if (link === null || !link.connected) continue
        const scope = `${link.connectionId}:${link.key}`
        const record = (eventKey: string, change: WorkActivityChange) => work.recordEvent({ connectionId: link.connectionId, itemId: link.itemId, itemKey: link.key, eventKey, change })
        const autoKey = `run:auto:${scope}:${worktree.path}:${link.mode === 'auto' ? this.generationOf(worktree.path) ?? 'na' : ''}`
        const migrationKey = `${link.connectionId}:${link.itemId ?? `key:${link.key}`}:${worktree.path}`
        migrating.add(migrationKey)
        const detached = this.detached.has(worktree.path)
        if (link.mode === 'auto' && record(autoKey, { field: 'run', event: 'auto_link', worktree: worktree.path, branch: branchName(worktree.branch) }) && !detached) {
          // 자동 연결의 출처 저장 — 이관 포트가 있으면 이관과 **같은 상한·간격·정지 정책**으로 보낸다(X1-6: 「사건을 처음 남김」 을 「저장 완료」 로 보지 않는다).
          // 실패 활동 열쇠는 자동 연결 저장의 열쇠 그대로. 이관 포트가 없으면(시험 가짜) 옛 자동 저장 경로.
          if (work.migrateLink !== undefined) {
            const current = this.migrations.get(migrationKey)
            if (current === undefined) {
              if (this.roomFor(migrationKey)) this.migrations.set(migrationKey, { ...this.migration({ link, worktree: worktree.path, repoRoot: repo.root, state: 'pending' }), activityKey: `run:srcfail:${autoKey}` })
            } else if (current.state === 'pending' && current.attempts === 0) current.activityKey = `run:srcfail:${autoKey}`
          } else {
            this.autoStores.set(autoKey, { connectionId: link.connectionId, itemId: link.itemId, key: link.key, worktree: worktree.path, repoRoot: repo.root, inFlight: false })
          }
        }
        if (!this.migrations.has(migrationKey) && !detached) {
          // 이 실행에서 시작이 적은 명시 링크는 시작이 이미 출처에 보냈다(`start.ts` 의 storeLink) — 시작이 미뤘으면(`owed`) 이관이 보낸다.
          const fresh = link.mode === 'explicit' && (linkedAt.get(worktree.path) ?? 0) >= this.bootAt && !this.owed.has(worktree.path)
          // 보낼 것 없는(fresh) 링크는 항목을 만들지 않는다 — 상한을 쓰지 않는다(다음 관측도 같은 판정).
          if (!fresh && this.roomFor(migrationKey)) this.migrations.set(migrationKey, this.migration({ link, worktree: worktree.path, repoRoot: repo.root, state: 'pending' }))
        }
        for (const pane of (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)) this.observePane({ pane, worktree, scope, record, refresh: work.refreshEvent.bind(work), waiting })
      }
    }
    // 사라진 대기(답했거나 본문이 왔다)는 잊는다. 아직 기다리는 것이 있으면 창이 지난 뒤 한 번 더 본다 — 트리가 안 바뀌어도 남게.
    for (const key of [...this.noBodySince.keys()]) if (!waiting.has(key)) this.noBodySince.delete(key)
    // 이미 「본문 없음」 을 남긴 대기는 다시 볼 것이 없다 — 타이머를 다시 걸지 않는다(R3-F).
    if ([...this.noBodySince.values()].some((entry) => !entry.recorded) && !this.settleArmed) {
      this.settleArmed = true
      const schedule = this.deps.schedule ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.() })
      schedule(() => { this.settleArmed = false; if (this.lastRepos !== null) this.observe(this.lastRepos) }, QUESTION_SETTLE_MS)
    }
    this.flushAutoStores(work)
    this.reviewMigrations({ work, present: migrating })
  }

  /** 이관이 다 끝날 때까지(시험·종료 정리용) — 돌고 있는 직렬 보내기를 기다린다. */
  async migrationsSettled(): Promise<void> {
    while (this.migrationLoop !== null) await this.migrationLoop
  }

  /** 명시 링크가 적힌 시각 — 레지스트리를 **읽기만** 한다. 못 읽으면 빈 지도(그러면 모두 이관 대상 — 멱등이라 안전하다). */
  private linkedTimes(): Map<string, number> {
    const times = new Map<string, number>()
    for (const [worktreePath, meta] of Object.entries(this.metadata())) if (meta.workLink) times.set(worktreePath, meta.workLink.linkedAt)
    return times
  }

  private migration({ link, worktree, repoRoot, state }: { link: WorktreeWorkLink; worktree: string; repoRoot: string; state: Migration['state'] }): Migration {
    return { connectionId: link.connectionId, itemId: link.itemId, key: link.key, worktree, repoRoot, state, attempts: 0, nextAt: 0, deferred: false, generation: null, activityKey: `run:srcfail:migrate:${link.connectionId}:${link.key}:${worktree}`, present: true }
  }

  /** 새 항목을 만들 자리가 있나 — 상한이면 보류(X3-2 — 이미 있는 항목은 건드리지 않는다). 자리 = `done` 아닌 항목 수(X4-1). */
  private roomFor(migrationKey: string): boolean {
    if (this.unsettledMigrations() < MIGRATE_MAX_ENTRIES) return true
    this.held = true
    if (!this.heldLogged) this.deps.log('work.link_migrate_held', { key: migrationKey, max: MIGRATE_MAX_ENTRIES })
    this.heldLogged = true
    return false
  }

  private unsettledMigrations(): number {
    let count = 0
    for (const entry of this.migrations.values()) if (entry.state !== 'done') count += 1
    return count
  }

  /**
   * 관측마다 — 트리에 있는지(전송 후보)만 고치고 **이력은 지우지 않는다**(X3-1). 자격 세대가 바뀐 연결의 실패 이력은 처음으로(규칙 ③ — 저장된 것은 그대로).
   * 기다리던 것은 다시 본다. 그리고 직렬 보내기를 깨운다.
   */
  private reviewMigrations({ work, present }: { work: LinkWorkPort; present: Set<string> }): void {
    if (work.migrateLink === undefined) return
    for (const [key, entry] of this.migrations) {
      entry.present = present.has(key)
      if (entry.state !== 'done' && entry.generation !== null && entry.generation !== (work.credentialGeneration?.(entry.connectionId) ?? entry.generation)) {
        entry.state = 'pending'
        entry.attempts = 0
        entry.nextAt = 0
        entry.generation = null
      }
      if (entry.present) entry.deferred = false
    }
    this.pumpMigrations(work)
  }

  private pumpMigrations(work: LinkWorkPort): void {
    if (this.migrationLoop !== null) return
    this.migrationLoop = this.drainMigrations(work).finally(() => { this.migrationLoop = null })
  }

  /** 한 번에 한 건 — 보낼 것이 없을 때까지. 간격을 기다리는 것이 남으면 그 시각에 다시 깨운다. */
  private async drainMigrations(work: LinkWorkPort): Promise<void> {
    const migrate = work.migrateLink?.bind(work)
    if (migrate === undefined) return
    for (;;) {
      const now = (this.deps.now ?? Date.now)()
      const entry = [...this.migrations.values()].find((row) => row.present && row.state === 'pending' && !row.deferred && row.nextAt <= now && !this.detached.has(row.worktree))
      if (entry === undefined) {
        // 보류된 링크가 있고 성공으로 자리가 났으면 같은 실행에서 이어 받는다(X4-1) — 마지막 트리를 다시 관측해 항목을 만들고 계속 보낸다.
        if (!this.held || this.lastRepos === null || this.unsettledMigrations() >= MIGRATE_MAX_ENTRIES) break
        this.held = false
        // 한 틱 넘긴다 — 이 보내기가 `migrationLoop` 에 걸린 뒤 관측해야 관측의 깨우기가 두 번째 보내기를 띄우지 않는다.
        await Promise.resolve()
        if (this.lastRepos !== null) this.observe(this.lastRepos)
        continue
      }
      const outcome = await this.queueWrite({ path: entry.worktree, add: true, send: () => migrate({ connectionId: entry.connectionId, itemId: entry.itemId, key: entry.key, link: { kind: 'worktree', path: entry.worktree, repoRoot: entry.repoRoot } }).catch((error: unknown): LinkMigrateOutcome => {
        this.deps.log('work.link_migrate_error', { connectionId: entry.connectionId, key: entry.key, error: String(error) })
        return { state: 'failed', retry: true, message: '출처에 링크를 남기지 못했습니다.', generation: work.credentialGeneration?.(entry.connectionId) ?? 0 }
      }) })
      // 줄 서는 사이·보내는 사이 떼어졌으면 결과를 버린다 — 떼기가 이 쓰기 뒤에 지운다(항목은 떼기가 이미 지웠다).
      if (outcome === null || this.detached.has(entry.worktree)) continue
      this.settleMigration({ work, entry, outcome })
    }
    const waiting = [...this.migrations.values()].filter((row) => row.present && row.state === 'pending' && !row.deferred).map((row) => row.nextAt)
    if (waiting.length > 0) this.wakeMigrations({ work, at: Math.min(...waiting) })
  }

  private settleMigration({ work, entry, outcome }: { work: LinkWorkPort; entry: Migration; outcome: LinkMigrateOutcome }): void {
    switch (outcome.state) {
      case 'saved':
      case 'skipped':
        entry.state = 'done'
        this.owed.delete(entry.worktree)
        return
      case 'later':
        entry.deferred = true
        return
      case 'failed': {
        entry.attempts += 1
        entry.generation = outcome.generation
        if (!outcome.retry) entry.state = 'stopped'
        else if (entry.attempts >= MIGRATE_MAX_ATTEMPTS) entry.state = 'exhausted'
        else entry.nextAt = (this.deps.now ?? Date.now)() + MIGRATE_RETRY_MS * 2 ** (entry.attempts - 1)
        this.deps.log('work.link_migrate_failed', { connectionId: entry.connectionId, key: entry.key, worktree: entry.worktree, attempts: entry.attempts, retry: outcome.retry, state: entry.state })
        // 활동에는 링크마다 한 번(같은 열쇠) — 재시도마다 줄이 늘지 않는다.
        work.recordEvent({
          connectionId: entry.connectionId, itemId: entry.itemId, itemKey: entry.key, eventKey: entry.activityKey,
          change: { field: 'run', event: 'source_link_failed', worktree: entry.worktree, message: outcome.message },
        })
      }
    }
  }

  /**
   * 그 경로의 출처 쓰기를 줄 세운다(X2-1) — 앞 쓰기가 끝난 뒤 `send` 를 부른다. `add` 는 줄 선 뒤 그 경로가 떼어졌으면 부르지 않고 null.
   * remove(떼기)는 늘 나간다 — 줄 끝에서.
   */
  private queueWrite<T>({ path: worktree, add, send }: { path: string; add: boolean; send: () => Promise<T> }): Promise<T | null> {
    const queuedAt = this.detachCount.get(worktree) ?? 0
    const previous = this.writes.get(worktree) ?? Promise.resolve()
    const result = previous.then(() => add && (this.detachCount.get(worktree) ?? 0) !== queuedAt ? null : send())
    const settled = result.then(() => {}, () => {})
    this.writes.set(worktree, settled)
    void settled.then(() => { if (this.writes.get(worktree) === settled) this.writes.delete(worktree) })
    return result
  }

  /**
   * 시작·미확정 시작 복구의 출처 저장(X2-1) — 같은 경로의 줄에 선다. 로컬 링크를 적은 같은 틱에 불러야 한다(그 뒤 떼기가 이 add 를 빼거나 기다린다).
   * 줄 선 뒤 떼어졌으면 보내지 않고 `skipped`.
   */
  async sourceSave({ path: worktree, send }: { path: string; send: () => Promise<StartSourceLink> }): Promise<StartSourceLink> {
    const result = (await this.queueWrite({ path: worktree, add: true, send })) ?? { state: 'skipped', message: null }
    // 미뤄졌으면(machine 미확정 — X3-3) 이관이 맡는다: 이 경로는 이 실행에 적힌 링크여도 이관 대상. 떼어졌으면 맡지 않는다.
    if (result.state === 'later' && !this.detached.has(worktree)) {
      this.owed.add(worktree)
      if (this.lastRepos !== null) this.observe(this.lastRepos)
    }
    return result
  }

  private wakeMigrations({ work, at }: { work: LinkWorkPort; at: number }): void {
    if (this.migrationTimerAt !== null && this.migrationTimerAt <= at) return
    this.migrationTimerAt = at
    const schedule = this.deps.schedule ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.() })
    schedule(() => { this.migrationTimerAt = null; this.pumpMigrations(work) }, Math.max(0, at - (this.deps.now ?? Date.now)()))
  }

  private generationOf(worktreePath: string): string | null {
    if (!this.generations.has(worktreePath)) this.generations.set(worktreePath, (this.deps.generation ?? gitBirth)(worktreePath))
    return this.generations.get(worktreePath) ?? null
  }

  /** 자동 연결을 출처에도 남긴다(C14 · R1-I). 닫힌 출처(LA)는 서비스가 요청 0 으로 skipped. 실패는 활동에 「출처 저장 실패」 로 남긴다. */
  private flushAutoStores(work: LinkWorkPort): void {
    for (const [eventKey, entry] of this.autoStores) {
      if (entry.inFlight) continue
      entry.inFlight = true
      void this.queueWrite({ path: entry.worktree, add: true, send: () => work.storeAutoLink({ connectionId: entry.connectionId, key: entry.key, link: { kind: 'worktree', path: entry.worktree, repoRoot: entry.repoRoot } }) }).then((result) => {
        entry.inFlight = false
        if (result === null) return
        this.autoStores.delete(eventKey)
        if (result.state !== 'failed') return
        this.deps.log('work.auto_link_source_failed', { connectionId: entry.connectionId, key: entry.key, worktree: entry.worktree })
        work.recordEvent({
          connectionId: entry.connectionId, itemId: entry.itemId, itemKey: entry.key, eventKey: `run:srcfail:${eventKey}`,
          change: { field: 'run', event: 'source_link_failed', worktree: entry.worktree, message: result.message },
        })
      }, (error: unknown) => {
        entry.inFlight = false
        this.deps.log('work.auto_link_source_error', { connectionId: entry.connectionId, key: entry.key, error: String(error) })
      })
    }
  }

  private observePane({ pane, worktree, scope, record, refresh, waiting }: {
    pane: PaneRow
    worktree: WorktreeRow
    scope: string
    record: (eventKey: string, change: WorkActivityChange) => boolean
    refresh: (input: { eventKey: string; change: WorkActivityChange }) => boolean
    waiting: Set<string>
  }): void {
    if (pane.agent === null) return
    const digest = pane.digest
    const session = sessionOf(pane)
    const blockedReason = pane.agentStatus === 'blocked' ? pane.agentState.blockedReason : null
    const hasQuestions = digest.pendingQuestions !== null && digest.pendingQuestions.length > 0
    // 질문 대기 판정은 `agentDot` 과 같다 — 빈 목록은 질문이 아니다(R1-N). 권한 대기도 사람이 답할 대기라 남기되 이유를 다르게 단다.
    if (hasQuestions || blockedReason === 'question' || blockedReason === 'permission') {
      const { text, reason } = waitingQuestion({ blockedReason, pendingQuestions: digest.pendingQuestions })
      // 열쇠(R1-L): 본문이 있으면 세션 + 본문 — 기다리는 동안 기록이 자라 시각이 움직여도 같다(같은 세션의 같은 본문 재질문은 하나로 합친다).
      // 본문이 없으면(grok · 권한) 기댈 것이 기록 시각뿐이다 — 세션 + 사유 + 마지막 활동 시각. 최종 관문 C13 실측 항목.
      const identity = text === null ? `${blockedReason ?? 'na'}:${digest.lastActivityAt ?? 'na'}` : `b:${sha8(text)}`
      const eventKey = `agent:q:${scope}:${session}:${identity}`
      if (text === null) {
        // 본문 없음은 판독 창(QUESTION_SETTLE_MS)이 지난 뒤에만(R2-C) — 그 전엔 기록 판독이 아직일 수 있다.
        const pendingKey = `${scope}:${session}:${pane.paneId}`
        waiting.add(pendingKey)
        const now = (this.deps.now ?? Date.now)()
        const since = this.noBodySince.get(pendingKey)?.since ?? now
        if (now - since < QUESTION_SETTLE_MS) {
          this.noBodySince.set(pendingKey, { since, recorded: false })
          return this.observeOutcome({ pane, worktree, scope, session, record, refresh })
        }
        this.noBodySince.set(pendingKey, { since, recorded: true })
      }
      record(eventKey, {
        field: 'agent', event: 'question', agent: pane.agent, worktree: worktree.path, question: text, noBody: reason,
      })
    }
    this.observeOutcome({ pane, worktree, scope, session, record, refresh })
  }

  private observeOutcome({ pane, worktree, scope, session, record, refresh }: {
    pane: PaneRow
    worktree: WorktreeRow
    scope: string
    session: string
    record: (eventKey: string, change: WorkActivityChange) => boolean
    refresh: (input: { eventKey: string; change: WorkActivityChange }) => boolean
  }): void {
    if (pane.agent === null) return
    const digest = pane.digest
    const outcome = digest.turnOutcome
    // 결과 시각이 없으면 같은 결과를 다시 알아볼 열쇠가 없다 — 남기지 않는다(중복보다 빠짐이 낫다).
    if (outcome !== null && digest.turnOutcomeAt !== null && pane.agentStatus !== 'working') {
      const eventKey = `agent:t:${scope}:${session}:${digest.turnOutcomeAt}:${outcome.outcome}`
      const change: WorkActivityChange = {
        field: 'agent', event: 'result', agent: pane.agent, worktree: worktree.path, outcome: outcome.outcome,
        detail: outcome.outcome === 'interrupted' ? outcome.reason : outcome.outcome === 'failed' ? outcome.error : null,
        filesChanged: filesChanged(worktree),
      }
      // 바뀐 파일 수는 첫 관측으로 굳히지 않는다(R1-M) — 결과 뒤 FILES_SETTLE_MS 안에는 git 상태가 따라오면 고친다.
      if (!record(eventKey, change) && Date.now() - digest.turnOutcomeAt < FILES_SETTLE_MS) refresh({ eventKey, change })
    }
  }
}

/** 렌더러 경로 검사 뒤의 링크 — 트리에 있는 worktree 의 해석 결과(없으면 null). */
export function linkOf({ repos, path }: { repos: RepoRow[]; path: string }): { repoRoot: string; worktree: WorktreeRow; link: WorktreeWorkLink | null } | null {
  for (const repo of repos) {
    const worktree = repo.worktrees.find((row) => row.path === path)
    if (worktree !== undefined) return { repoRoot: repo.root, worktree, link: worktree.workLink ?? null }
  }
  return null
}
