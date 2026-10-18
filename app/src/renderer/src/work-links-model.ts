// 작업 링크 화면 모델 (LIFE-603 C10·C11·C12) — 순수 함수. 링크 해석은 main 이 했다(`WorktreeRow.workLink`) — 여기서는 모아서 고르기만 한다.
//
// - pane 점은 사이드바 에이전트 행과 **같은 함수**(`paneDot`, 같은 안 읽음 집합)에서 온다. 여기서 새 판정을 만들지 않는다.
//   worktree 점 = 그 pane 점들 중 급한 순 첫째 — 탭 집계(`tabStatus`)는 `unverifiable` 같은 칸 없는 점을 버려 사이드바 행과 달라진다.
// - 급한 순서는 `AGENT_DOT_ORDER`(질문 대기 > 막힘 > 일하는 중 > … > 끝남 안 봄 > … > 쉼) 하나.
// - 큰소리 라벨은 사람이 움직일 두 경우만 — 질문 대기(`waiting`) · 끝남 안 봄(`done` = 안 본 끝남, herdr 의 done).
import type { RepoRow, WorktreeRow } from '../../shared/types.js'
import type { WorkLinkRecord } from '../../shared/work.js'
import { linkTargets, type WorktreeWorkLink } from '../../shared/work-link.js'
import { AGENT_DOT_ORDER, waitingQuestion, type AgentDot } from './agent-dot.js'
import { paneDot, type TabAgentKind } from './tab-status.js'
import { latestActivity, type WorkingEntry, type WorkingTree } from './tasks-model.js'

/** 질문 대기 pane 하나 — 본문을 못 읽는 에이전트(grok)는 `text` null + 이유. */
export type LinkedQuestion = { paneId: string; text: string | null; reason: string | null }

export type LinkedTree = WorkingTree & {
  link: WorktreeWorkLink
  /** 열린 workspace 가 있나 — 작업 중 보기는 열린 것만 모은다(T2 와 같다). */
  open: boolean
  /** 첫 에이전트 pane 의 종류(로고). 없으면 null. */
  agent: TabAgentKind | null
  question: LinkedQuestion | null
  /** 「터미널에서 답하기」 · 칩 클릭이 고를 pane — 질문 대기면 그 pane, 아니면 null(첫 세션 선택 규칙). */
  focusPane: string | null
}

function agentKindOf(agent: string | null): TabAgentKind | null {
  return agent === 'claude' || agent === 'codex' || agent === 'grok' ? agent : null
}

/**
 * worktree 하나의 점 — pane 점(사이드바 행과 같은 `paneDot`, 안 읽음 집합도 사이드바와 같은 `useUnread`) 중 급한 순 첫째.
 * 에이전트 pane 이 없으면 null.
 */
export function worktreeDot({ worktree, unreadPanes }: { worktree: WorktreeRow; unreadPanes: ReadonlySet<string> }): AgentDot | null {
  const panes = (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes).filter((pane) => pane.agent !== null)
  const dots = panes.map((pane) => paneDot({ pane, unread: unreadPanes.has(pane.paneId) }))
  return dots.reduce<AgentDot | null>((best, dot) => (best === null || urgency(dot) < urgency(best) ? dot : best), null)
}

/** 트리의 링크된 worktree 전부(열림·닫힘). `unreadPanes` = 사이드바와 같은 안 읽음 pane 집합. */
export function linkedTrees({ repos, unreadPanes }: { repos: RepoRow[]; unreadPanes: ReadonlySet<string> }): LinkedTree[] {
  return repos.flatMap((repo) => repo.worktrees.flatMap((worktree): LinkedTree[] => {
    const link = worktree.workLink ?? null
    if (link === null) return []
    const panes = (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes)
    const agents = panes.filter((pane) => pane.agent !== null)
    const asking = agents.find((pane) => paneDot({ pane, unread: unreadPanes.has(pane.paneId) }) === 'waiting')
    return [{
      path: worktree.path,
      repoRoot: repo.root,
      repoName: repo.name,
      branch: worktree.branch?.replace(/^refs\/heads\//, '') ?? worktree.path.split('/').pop() ?? worktree.path,
      dot: worktreeDot({ worktree, unreadPanes }),
      activityAt: latestActivity(panes.map((pane) => pane.digest.lastActivityAt)),
      link,
      open: worktree.openWorkspaceId !== null,
      agent: agentKindOf(agents[0]?.agent ?? null),
      question: asking === undefined ? null : {
        paneId: asking.paneId,
        ...waitingQuestion({ blockedReason: asking.agentState.blockedReason, pendingQuestions: asking.digest.pendingQuestions }),
      },
      focusPane: asking?.paneId ?? null,
    }]
  }))
}

/** 그 작업에 붙은 worktree — 급한 순. */
export function treesFor({ trees, connectionId, itemId, key }: { trees: LinkedTree[]; connectionId: string; itemId: string; key: string }): LinkedTree[] {
  return trees.filter((tree) => linkTargets({ link: tree.link, connectionId, itemId, key })).sort((a, b) => urgency(a.dot) - urgency(b.dot))
}

function urgency(dot: AgentDot | null): number {
  return dot === null ? AGENT_DOT_ORDER.length : AGENT_DOT_ORDER.indexOf(dot)
}

/** 큰소리 라벨 — 질문 대기 · 끝남 안 봄만. */
export function loudLabel(dot: AgentDot | null): string | null {
  return dot === 'waiting' ? '질문 대기' : dot === 'done' ? '끝남 안 봄' : null
}

/** 칩 하나 + 나머지 수(급한 순 첫째). */
export function chipOf(trees: LinkedTree[]): { tree: LinkedTree; more: number } | null {
  const first = trees[0]
  return first === undefined ? null : { tree: first, more: trees.length - 1 }
}

/**
 * 작업 중 보기(C12) — T2 의 키 감지 대신 링크 모델(명시 + 자동 − 예외). 열린 worktree 만, (연결, 키)로 묶는다.
 * 명시 링크는 키 없는 브랜치여도 들어오고, 뗀 worktree 는 빠진다(main 이 링크를 null 로 싣는다).
 */
export function workingFromLinks(trees: LinkedTree[]): WorkingEntry[] {
  const entries = new Map<string, WorkingEntry>()
  for (const tree of trees) {
    if (!tree.open || !tree.link.connected) continue
    const id = `${tree.link.connectionId}::${tree.link.key}`
    const entry = entries.get(id) ?? { key: tree.link.key, connectionId: tree.link.connectionId, trees: [] }
    entry.trees.push({ path: tree.path, repoRoot: tree.repoRoot, repoName: tree.repoName, branch: tree.branch, dot: tree.dot, activityAt: tree.activityAt })
    entries.set(id, entry)
  }
  return [...entries.values()]
}

/** 원격 링크 한 줄(LIFE-635 C5) — 출처에 있는데 이 Mac 의 로컬 worktree 로 합쳐지지 않는 링크. 읽기 전용. */
export type RemoteLinkRow = {
  id: string
  kindLabel: string
  value: string
  /** PR 만 — `http(s)` 일 때만 링크 주소, 그 밖(`javascript:` 등)은 null 이라 글자로만 그린다. */
  href: string | null
  machine: string | null
  repo: string | null
  createdAt: string | null
}

const REMOTE_KIND_LABEL: Record<WorkLinkRecord['link']['kind'], string> = { worktree: 'worktree', branch: '브랜치', pull_request: 'PR', agent_session: '세션' }

/** 외부로 열어도 되는 주소 — http·https 만(main 의 `isExternalOpenAllowed` 와 같은 축). 못 읽으면 null. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/**
 * 원격 링크 목록(LIFE-635 C5 · D3·D6) — 출처 링크 중 **이 Mac 의 로컬 worktree 와 같은 링크**(종류 worktree · 같은 경로 · 같은 machine — 출처 판별과 같은 축)는
 * 로컬 칩 쪽으로 합쳐 빼고 나머지를 돌려준다(다른 machine · 다른 종류 · 로컬에 없는 경로). `machine` 을 아직 모르면 null — 내 링크를 남의 것으로
 * 잘못 보이지 않게 목록을 그리지 않는다. 출처 이름으로 가르지 않는다(데이터로만).
 */
export function remoteLinks({ records, trees, machine }: { records: WorkLinkRecord[]; trees: LinkedTree[]; machine: string | null }): RemoteLinkRow[] | null {
  if (machine === null) return null
  const local = new Set(trees.map((tree) => tree.path))
  return records
    .filter((record) => !(record.link.kind === 'worktree' && record.machine === machine && local.has(record.link.path)))
    .map((record, index) => {
      const link = record.link
      const value = link.kind === 'worktree' ? link.path : link.kind === 'branch' ? link.name : link.kind === 'pull_request' ? link.url : link.sessionId
      return {
        id: `${link.kind}:${record.machine ?? ''}:${value}:${index}`,
        kindLabel: REMOTE_KIND_LABEL[link.kind],
        value,
        href: link.kind === 'pull_request' ? safeHref(link.url) : null,
        machine: record.machine,
        repo: record.repo,
        createdAt: record.createdAt,
      }
    })
}
