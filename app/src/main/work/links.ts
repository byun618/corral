// 작업 링크 (LIFE-603 · 묶음 K11·K8) — main 쪽 한 곳.
//
// 1. **해석해서 싣기**(`annotate`): 트리를 내보낼 때마다 `repos.json` 메타(명시 링크 · 예외)와 연결의 키 모양으로 worktree 마다 링크를 정해
//    `WorktreeRow.workLink` 에 싣는다. 판정은 `shared/work-link.ts` 의 `resolveWorkLink` 하나 — 사이드바 · 작업 중 · 칩 · 상세가 같은 값을 본다.
// 2. **쓰기**(`saveExplicit`·`detach`): `RepoRegistry.change()` 잠금을 지난다(CLI `worktree set` 과 같은 잠금). 런타임 workspace 줄은 타지 않는다 —
//    시작이 그 줄을 잡고 에이전트 ready 를 기다리는 동안에도 링크 저장·떼기가 줄 서지 않는다(F3).
// 3. **사건 기록**(`observe`): 링크된 worktree 의 실행(자동 연결)·에이전트(질문 · 턴 결과) 사건을 활동에 남긴다. 작업 페이지가 닫혀 있어도 main 이 남긴다.
//    같은 사건은 `eventKey` 로 한 번만(재시작 · 상태 재방송 · 같은 질문 재관측). 열쇠는 설계 메모 §4.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DetachWorkLinkResult, RepoRow, WorktreeRow, PaneRow } from '../../shared/types.js'
import type { WorkActivityChange, WorkLink } from '../../shared/work.js'
import { waitingQuestion } from '../../shared/agent-dot.js'
import { resolveWorkLink, type LinkConnection, type StoredWorkLink, type WorktreeWorkLink } from '../../shared/work-link.js'
import type { StartSourceLink } from '../../shared/work-start.js'
import type { DroppedLink, WorktreeMetadataRecord } from '../registry.js'

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
}

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
  private readonly noBodySince = new Map<string, number>()
  private lastRepos: RepoRow[] | null = null
  /** 세대 캐시 — 트리에서 사라진 경로는 지운다(다시 나타나면 새로 읽는다). */
  private readonly generations = new Map<string, string | null>()
  private settleArmed = false
  private readonly autoStores = new Map<string, { connectionId: string; itemId: string | null; key: string; worktree: string; repoRoot: string; inFlight: boolean }>()

  constructor(deps: LinkDeps) {
    this.deps = deps
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
      return true
    } catch (error) {
      this.deps.log('work.link_save_failed', { path, error: String(error) })
      return false
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
    const work = this.deps.work()
    work?.recordEvent({
      connectionId: link.connectionId,
      itemId: link.itemId,
      itemKey: link.key,
      eventKey: `run:detach:${link.connectionId}:${link.key}:${worktree.path}:${Date.now()}`,
      change: { field: 'run', event: 'detach', worktree: worktree.path, branch: branchName(worktree.branch) },
    })
    const sourceLink = link.itemId === null || work === null ? null
      : await work.storeLink({ connectionId: link.connectionId, itemId: link.itemId, link: { kind: 'worktree', path: worktree.path, repoRoot }, action: 'remove' })
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
    const waiting = new Set<string>()
    const present = new Set(repos.flatMap((repo) => repo.worktrees.map((row) => row.path)))
    for (const known of [...this.generations.keys()]) if (!present.has(known)) this.generations.delete(known)
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        const link = worktree.workLink ?? null
        if (link === null || !link.connected) continue
        const scope = `${link.connectionId}:${link.key}`
        const record = (eventKey: string, change: WorkActivityChange) => work.recordEvent({ connectionId: link.connectionId, itemId: link.itemId, itemKey: link.key, eventKey, change })
        const autoKey = `run:auto:${scope}:${worktree.path}:${link.mode === 'auto' ? this.generationOf(worktree.path) ?? 'na' : ''}`
        if (link.mode === 'auto' && record(autoKey, { field: 'run', event: 'auto_link', worktree: worktree.path, branch: branchName(worktree.branch) })) {
          this.autoStores.set(autoKey, { connectionId: link.connectionId, itemId: link.itemId, key: link.key, worktree: worktree.path, repoRoot: repo.root, inFlight: false })
        }
        for (const pane of (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)) this.observePane({ pane, worktree, scope, record, refresh: work.refreshEvent.bind(work), waiting })
      }
    }
    // 사라진 대기(답했거나 본문이 왔다)는 잊는다. 아직 기다리는 것이 있으면 창이 지난 뒤 한 번 더 본다 — 트리가 안 바뀌어도 남게.
    for (const key of [...this.noBodySince.keys()]) if (!waiting.has(key)) this.noBodySince.delete(key)
    if (this.noBodySince.size > 0 && !this.settleArmed) {
      this.settleArmed = true
      const schedule = this.deps.schedule ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.() })
      schedule(() => { this.settleArmed = false; if (this.lastRepos !== null) this.observe(this.lastRepos) }, QUESTION_SETTLE_MS)
    }
    this.flushAutoStores(work)
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
      void work.storeAutoLink({ connectionId: entry.connectionId, key: entry.key, link: { kind: 'worktree', path: entry.worktree, repoRoot: entry.repoRoot } }).then((result) => {
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
        const since = this.noBodySince.get(pendingKey) ?? now
        this.noBodySince.set(pendingKey, since)
        if (now - since < QUESTION_SETTLE_MS) return this.observeOutcome({ pane, worktree, scope, session, record, refresh })
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
