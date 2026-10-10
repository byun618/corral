// 폰용 대화방 목록 (LIFE-580 J4·J8·J11) — main 상태 스냅샷 → 폰이 그리는 목록. 순수 함수만 둔다(electron·소켓 없음).
//
// **값과 순서는 데스크톱 파생 코드가 정한다(J4)** — 여기서 규칙을 다시 짜지 않는다:
//   · 작업 순서 = `buildSidebarSections`(「레포로 묶기」 보기 + 사용자의 정렬 모드·수동 순서). 데스크톱 필터·고정은 폰에 적용하지 않는다(F4)
//   · 하위 워크트리 합치기 = `lineageGraph` + `nestSectionItems`(parentPath 를 최상위 조상까지, 고아는 독립 그룹)
//   · 채널 행·제목·상태 점·워커 들여쓰기·보존 행 = `buildAgentRows`(사이드바 `WorktreeBlock` 과 같은 호출)
// 이 파일이 더하는 것은 폰 전용 결정뿐이다 — 「나를 기다리는 것」 분류·정렬(디자인 Q1) · 미리보기(J11) · 숨김(M3-b) · 비밀·경로 감추기(J8).
//
// 안 읽음(J1)은 폰 장부라 서버가 모른다. 그래서 점을 두 번 계산해 둘 다 보낸다 — `dot`(본 것으로 칠 때) · `dotUnseen`(안 본 것으로 칠 때).
// 데스크톱도 같은 함수에 자기 장부(`unreadPanes`)를 넣어 고른다. 폰은 자기 장부로 둘 중 하나를 고를 뿐 점 규칙을 모른다.
//
// 보내지 않는 것(J8 · R1-A3 계약): 셸 pane · 터미널 화면 내용 · 레포·작업 경로(id 는 경로 해시) · **홈 아래 절대경로**(미리보기 글의 경로는
// 그 pane 의 작업 worktree 안이면 worktree 상대, 밖이면 `~/` — `maskPaths`) · 토큰·비용 · 환경. 제목은 데스크톱 사이드바와 같은 문자열이다
// (터미널 제목 폴백·홈 축약 포함 — 데스크톱 함수 그대로, J4). 행 수는 자르지 않는다 — 글만 표시 길이로 자른다.
import { createHash } from 'node:crypto'
import type { AgentDot } from '../../shared/agent-dot.js'
import { readKeyList, readWorktreeOrder, type ManualOrder } from '../../shared/manual-order.js'
import { buildAgentRows, livePaneIdsOf, retainedByWorktree, type AgentRowNode } from '../../shared/sidebar-agents.js'
import { buildSidebarSections, lineageGraph, nestSectionItems } from '../../shared/sidebar-sections.js'
import { readSidebarView, type SidebarView } from '../../shared/sidebar-view.js'
import type { AgentSessionRef, AppState, PaneRow, UiPrefs, WorktreeRow } from '../../shared/types.js'
import { worktreeDisplayName } from '../../shared/worktree-name.js'

/** 목록이 읽는 상태 칸 — `currentState()` 의 일부. */
export type ListState = Pick<AppState, 'repos' | 'retainedAgents' | 'orchestrationLineage' | 'integrations' | 'home' | 'link'>

/** `now` 은 시험만 고정한다 — 데스크톱 smart 정렬의 「신선한 완료」 30분 경계가 이 시각을 본다. */
export type ListInput = { state: ListState; prefs: UiPrefs | null; now?: number }

/** 표시 길이 상한 — 행 수가 아니라 글자만 자른다(J8 「조용히 자르지 않는다」 는 행 이야기다). */
export const TITLE_MAX = 120
export const PREVIEW_MAX = 160

export type MobileAgentKind = 'claude' | 'codex' | 'grok'

/** 2줄 미리보기 재료(J11). 접두어(질문·맥에서 승인·실패…)는 폰이 점에서 고른다 — 여기는 글만. */
export type MobilePreview =
  | { kind: 'question'; text: string | null }
  | { kind: 'approval'; text: string | null }
  | { kind: 'prompt'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'none' }

export type MobileWaitKind = 'question' | 'approval' | 'login' | 'other'

export type MobileChannel = {
  /** 목록 안 정체 — live 는 pane id, 보존 행은 `retained:<pane id>`. M4 가 대화를 열 때 쓴다. */
  id: string
  /** 안 읽음·접힘 장부 키(J1) — provider 세션 정체의 해시. 세션 참조가 없으면 `pane:<pane id>`(herdr 재기동 때 바뀐다). */
  key: string
  status: 'live' | 'closed'
  kind: MobileAgentKind | null
  title: string
  dot: AgentDot
  /** 안 본 것으로 칠 때의 점 — 데스크톱이 자기 장부로 고르는 두 번째 값. 끝난 행만 `dot` 과 다르다. */
  dotUnseen: AgentDot
  /** 0 = 작업 머리 아래, 1 = 워커(같은 워크트리 계보) 또는 하위 워크트리 출신. 데스크톱처럼 시각 깊이는 1 로 고정. */
  depth: 0 | 1
  /** 하위 워크트리 출신이면 그 워크트리 이름(`↳ 출신`). */
  origin: string | null
  /** 띄운 세션 — 목록 행 셋째 줄용: 부모가 다른 작업 그룹에 있거나 모를 때만(디자인 Q3). `{title:null}` = 모름. */
  spawnedBy: { title: string | null } | null
  /** 띄운 세션 — 대화 머리용: 계보에 부모가 있으면 **항상**(579 Q3, R1 C2). `{title:null}` = 부모를 모름. 계보에 없으면 null. */
  parent: { title: string | null } | null
  preview: MobilePreview
  waiting: MobileWaitKind | null
  model: string | null
  /** 행 시각(데스크톱 `timeAt` 과 같은 값). */
  timeAt: number | null
  /** 안 읽음 재료(J1) — 마지막 활동 시각과 턴 결과. */
  activityAt: number | null
  outcome: 'completed' | 'interrupted' | 'failed' | null
}

export type MobileTask = { id: string; name: string; isDefault: boolean; channels: MobileChannel[] }
export type MobileRepo = { id: string; name: string; tasks: MobileTask[] }

export type MobileList =
  | { available: true; repos: MobileRepo[]; waiting: string[] }
  /** 맥이 아직 herdr 상태를 못 읽었다 — 폰은 이것을 「세션 0」 으로 그리지 않는다(L5ⓗ). */
  | { available: false; reason: string; repos: []; waiting: [] }

/** 경로를 폰에 보내지 않는다 — 안정된 짧은 해시만. */
export function opaqueId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function channelKey(input: { paneId: string; session: AgentSessionRef | null }): string {
  const { session } = input
  if (session === null) return `pane:${input.paneId}`
  const target = session.kind === 'id' ? `id:${session.id}` : `path:${session.path}`
  return `s:${opaqueId(`${session.agent}\u0000${session.source}\u0000${target}`)}`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function mobileKind(kind: AgentRowNode['kind']): MobileAgentKind | null {
  return kind === 'claude' || kind === 'codex' || kind === 'grok' ? kind : null
}

/** 폰은 늘 레포 › 작업으로 묶는다 — 정렬 모드·프로젝트 순서만 데스크톱 값을 따르고 필터는 끈다(F4). */
export function phoneView(prefs: UiPrefs | null): SidebarView {
  const view = readSidebarView(prefs === null ? {} : { ...prefs })
  return { ...view, groupBy: 'repo', repoFilter: [], hideDefaultBranch: false, hideDetachedHead: false }
}

export function phoneOrder(prefs: UiPrefs | null): ManualOrder {
  if (prefs === null) return { repos: [], worktrees: {}, all: [] }
  return { repos: readKeyList(prefs.manualRepoOrder), worktrees: readWorktreeOrder(prefs.manualWorktreeOrder), all: readKeyList(prefs.manualFlatOrder) }
}

/**
 * 경로 가림(R1-A3 ② → R4-A1). 경계를 열거하지 않는다 — 계약은 하나다: **결과 글에 홈 아래 절대경로(퍼센트 인코딩 모양 포함)가 남지 않는다.**
 * ① 퍼센트 디코딩 — 유효한 `%XX` 만, 바뀌지 않을 때까지(8중 인코딩까지). 한 덩어리가 UTF-8 로 안 풀리면 그 안의 ASCII 바이트만 푼다.
 *    8회 안에 고정점에 닿지 못하면(9중 이상) 글 전체를 `…` 로 바꾼다 — fail-closed(R5-A1).
 * ② 홈 문자열이 나오는 **모든 위치** — 앞 글자는 보지 않는다(`-I/Users/me`·`//Users/me`·`file://localhost/Users/me` 모두). 뒤 경계만 본다:
 *    글 끝·`/`·홈 이름에 이어질 수 없는 글자. 이름에 이어지는 글자 = 영숫자 `_` `-` — 그래서 `/Users/meow`·`/Users/me2`·`/Users/me-old` 는
 *    다른 홈으로 남는다. `.` 은 경계로 본다(`/Users/me.bak` → `~.bak` 과잉 가림) — `.` 다음 글자로 다른 이름을 짐작하면 `/Users/me.file://…` 처럼
 *    문장 끝 점 뒤에 글이 붙은 홈이 샌다(불변식 시험이 찾은 모양).
 * ③ 그 pane 의 worktree 안이면 worktree 상대(`src/a.ts`, 자신은 `.`), 그 밖의 홈 아래면 `~`.
 * ④ 과잉 가림은 허용한다(`/x/Users/me/a` → `/x~/a`, `file:///Users/me/a` → `file://~/a`) — 정보 손실일 뿐 노출이 아니다.
 * 범위 밖: Windows 모양(`C:\Users\me`) — 데스크톱 macOS POSIX 경로가 계약이다.
 */
const ROOT_AFTER = String.raw`(?![A-Za-z0-9_-])`
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g
const DECODE_ROUNDS = 8

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeRun(run: string): string {
  try {
    return decodeURIComponent(run)
  } catch {
    // UTF-8 로 안 풀리는 덩어리(`%FF%2F`) — ASCII 바이트만 푼다. 그래야 `%FF%2FUsers…` 의 `%2F` 가 숨지 못한다.
    return run.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  }
}

/**
 * 퍼센트 디코딩을 고정점까지 — 최대 `DECODE_ROUNDS` 번 풀고 한 번 더 확인한다(8중 인코딩까지 고정점에 닿는다).
 * 그 안에 고정점에 닿지 못하면 `complete: false` 다(R5-A1 — 그 글은 아직 인코딩된 홈을 품을 수 있다).
 */
function decodeToFixpoint(text: string): { text: string; complete: boolean } {
  let out = text
  for (let round = 0; round <= DECODE_ROUNDS; round += 1) {
    const next = out.replace(PERCENT_RUN, decodeRun)
    if (next === out) return { text: out, complete: true }
    out = next
  }
  return { text: out, complete: false }
}

export function percentDecode(text: string): string {
  return decodeToFixpoint(text).text
}

/** 디코딩이 고정점에 닿지 못한 글 전체를 대신하는 표시(R5-A1, fail-closed) — 원문·부분 디코딩 결과 어느 것도 싣지 않는다. */
export const MASKED_UNDECODABLE = '…'

export function maskPaths(input: { text: string; worktree: string | null; home: string }): string {
  const home = input.home.replace(/\/+$/, '')
  const worktree = input.worktree === null ? '' : input.worktree.replace(/\/+$/, '')
  const decoded = decodeToFixpoint(input.text)
  // 9중 이상 인코딩 — 남은 `%XX` 안에 홈이 숨을 수 있어 글 전체를 가린다(main 비용 상한은 유지).
  if (!decoded.complete && home !== '') return MASKED_UNDECODABLE
  let out = decoded.text
  // worktree 가 홈 자체면 상대경로로 바꾸지 않는다(홈 전체가 `.` 이 되면 `~` 보다 덜 알려 준다).
  if (worktree !== '' && worktree !== home) {
    const root = escapeRegExp(worktree)
    out = out.replace(new RegExp(`${root}/(?=[^\\s])`, 'g'), '')
    out = out.replace(new RegExp(`${root}${ROOT_AFTER}`, 'g'), '.')
  }
  if (home !== '') out = out.replace(new RegExp(`${escapeRegExp(home)}${ROOT_AFTER}`, 'g'), '~')
  return out
}

function toolLine(pane: PaneRow): string | null {
  const tool = pane.digest.tool
  if (tool === null) return null
  return tool.input === null ? tool.name : `${tool.name} · ${tool.input}`
}

/**
 * 미리보기(J11 · R1-A5 코디 해석으로 확정한 순서):
 *   질문 대기 → 그 질문 · 권한 대기 → 그 도구(claude) · 실패 → 실패 사유 · **작업 중이면 지금 도구** → 내 마지막 지시 → 마지막 도구 → 없음.
 * 작업 중 도구가 지시보다 앞서는 것은 디자인 Q4 「지금 무엇을 하나」. 에이전트 마지막 답은 M4.
 * 글은 홈 아래 경로를 감춘 뒤 자른다(`maskPaths`) — `place` = 그 pane 의 작업 worktree 경로 · 홈.
 */
export function previewOf(input: { pane: PaneRow; dot: AgentDot; place: { worktree: string | null; home: string } }): MobilePreview {
  const { pane, dot, place } = input
  const tool = pane.agent === 'claude' ? toolLine(pane) : null
  const clip = (text: string): string => oneLine(maskPaths({ text, worktree: place.worktree, home: place.home }), PREVIEW_MAX)
  if (dot === 'waiting') {
    if (pane.agentState.blockedReason === 'permission') return { kind: 'approval', text: tool === null ? null : clip(tool) }
    const question = pane.digest.pendingQuestions?.[0]
    const text = question === undefined ? null : question.question.trim() !== '' ? question.question : question.header
    return { kind: 'question', text: text === null ? null : clip(text) }
  }
  if (dot === 'failed') {
    const outcome = pane.digest.turnOutcome
    const error = outcome?.outcome === 'failed' ? outcome.error : null
    if (error !== null && error.trim() !== '') return { kind: 'error', text: clip(error) }
  }
  if (dot === 'working' && tool !== null) return { kind: 'tool', text: clip(tool) }
  const prompt = pane.digest.lastPrompt
  if (prompt !== null && prompt.trim() !== '') return { kind: 'prompt', text: clip(prompt) }
  if (tool !== null) return { kind: 'tool', text: clip(tool) }
  return { kind: 'none' }
}

/** 「나를 기다리는 것」 에 오르는가(디자인 Q1·Q6) — 답할 수 있는 질문 · 맥에서만 풀리는 대기(권한·로그인·그 밖). */
export function waitingOf(input: { pane: PaneRow; dot: AgentDot }): MobileWaitKind | null {
  const reason = input.pane.agentState.blockedReason
  if (input.dot === 'waiting') return reason === 'permission' ? 'approval' : 'question'
  if (input.dot === 'blocked') return reason === 'login' ? 'login' : 'other'
  return null
}

type Built = { channel: MobileChannel; taskId: string; since: number; paneId: string | null; nested: boolean }

export function buildMobileList(input: ListInput): MobileList {
  const { state, prefs } = input
  if (state.link.phase !== 'live') return { available: false, reason: state.link.phase, repos: [], waiting: [] }
  const now = input.now ?? Date.now()
  const repos = state.repos
  const sections = buildSidebarSections({ repos, view: phoneView(prefs), order: phoneOrder(prefs), now })
  const graph = lineageGraph(repos)
  const livePaneIds = livePaneIdsOf(repos)
  const retainedOf = retainedByWorktree({ repos, retained: state.retainedAgents })
  const lineageParent = new Map<string, string | null>()
  if (state.orchestrationLineage.state === 'ready') for (const entry of state.orchestrationLineage.entries) lineageParent.set(entry.paneId, entry.parentPaneId)

  const built: Built[] = []
  const out: MobileRepo[] = []
  for (const section of sections) {
    if (section.kind !== 'repo') continue
    const tasks: MobileTask[] = []
    for (const unit of nestSectionItems({ items: section.items, collapsed: new Set(), graph })) {
      const root = unit.root.item.worktree
      const taskId = opaqueId(root.path)
      const live: Built[] = []
      const closed: Built[] = []
      for (const worktree of [root, ...unit.descendants.map((row) => row.item.worktree)]) {
        const origin = worktree === root ? null : worktreeDisplayName(worktree)
        for (const item of worktreeChannels({ worktree, state, livePaneIds, retained: retainedOf.get(worktree.path) ?? [] })) {
          const depth: 0 | 1 = origin !== null || item.nested ? 1 : 0
          const entry: Built = { ...item, taskId, channel: { ...item.channel, depth, origin } }
          if (entry.channel.status === 'live') live.push(entry)
          else closed.push(entry)
        }
      }
      // M3-b — 열린 AI 세션이 없는 작업은 숨긴다(셸만 · 닫힌 세션만 남은 작업 포함). J2 — 보존 행은 그룹 끝에.
      if (live.length === 0) continue
      built.push(...live, ...closed)
      tasks.push({ id: taskId, name: worktreeDisplayName(root), isDefault: !root.isLinked, channels: [...live, ...closed].map((entry) => entry.channel) })
    }
    if (tasks.length > 0) out.push({ id: opaqueId(section.repo.root), name: section.repo.name, tasks })
  }

  // 띄운 세션(디자인 Q3) — 대화 머리(`parent`)는 계보에 부모가 있으면 항상(R1 C2), 목록 행(`spawnedBy`)은 들여쓰기로 부모가 안 보일 때만:
  // 부모가 다른 작업에 있거나 모를 때.
  const byPane = new Map(built.filter((entry) => entry.paneId !== null).map((entry) => [entry.paneId, entry]))
  for (const entry of built) {
    if (entry.paneId === null || !lineageParent.has(entry.paneId)) continue
    const parentPaneId = lineageParent.get(entry.paneId) ?? null
    const parent = parentPaneId === null ? undefined : byPane.get(parentPaneId)
    entry.channel.parent = { title: parent?.channel.title ?? null }
    if (entry.nested) continue
    if (parent !== undefined && parent.taskId === entry.taskId) continue
    entry.channel.spawnedBy = { title: parent?.channel.title ?? null }
  }

  // 「나를 기다리는 것」 정렬(디자인 Q1) — 답할 수 있는 질문 → 맥에서만 풀리는 대기 → 최근순.
  const rank = (kind: MobileWaitKind): number => (kind === 'question' ? 0 : 1)
  const waiting = built
    .filter((entry) => entry.channel.status === 'live' && entry.channel.waiting !== null)
    .sort((a, b) => rank(a.channel.waiting ?? 'other') - rank(b.channel.waiting ?? 'other') || b.since - a.since)
    .map((entry) => entry.channel.id)
  return { available: true, repos: out, waiting }
}

type WorktreeChannel = { channel: MobileChannel; since: number; paneId: string | null; nested: boolean }

/** 한 워크트리의 채널 — 사이드바 `WorktreeBlock` 과 같은 `buildAgentRows` 호출을 장부 두 벌로. 서브에이전트 행은 세션이 아니라 뺀다. */
function worktreeChannels(input: { worktree: WorktreeRow; state: ListState; livePaneIds: ReadonlySet<string>; retained: ListState['retainedAgents'] }): WorktreeChannel[] {
  const { worktree, state } = input
  const tabs = worktree.workspace?.tabs ?? []
  const common = { tabs, retained: input.retained, lineage: state.orchestrationLineage, livePaneIds: input.livePaneIds, integrations: state.integrations, home: state.home }
  const seen = buildAgentRows({ ...common, unreadPanes: new Set() })
  const everyPane = new Set([...tabs.flatMap((tab) => tab.panes.map((pane) => pane.paneId)), ...input.retained.map((row) => row.paneId)])
  const unseen = new Map(flatten(buildAgentRows({ ...common, unreadPanes: everyPane })).map(({ node }) => [node.key, node]))
  const panes = new Map(tabs.flatMap((tab) => tab.panes).map((pane) => [pane.paneId, pane]))
  const retained = new Map(input.retained.map((row) => [row.paneId, row]))
  const out: WorktreeChannel[] = []
  for (const { node, nested } of flatten(seen)) {
    if (node.source === 'subagent') continue
    if (node.kind === 'shell') continue
    const kind = mobileKind(node.kind)
    const dotUnseen = unseen.get(node.key)?.dot ?? node.dot
    if (node.source === 'retained') {
      const row = retained.get(node.paneId)
      out.push({
        channel: {
          id: node.key,
          key: `closed:${node.paneId}`,
          status: 'closed',
          kind,
          title: oneLine(node.full.label, TITLE_MAX),
          dot: node.dot,
          dotUnseen,
          depth: 0,
          origin: null,
          spawnedBy: null,
          parent: null,
          preview: { kind: 'none' },
          waiting: null,
          model: null,
          timeAt: node.timeAt,
          activityAt: null,
          outcome: null,
        },
        since: row?.retainedAt ?? 0,
        paneId: null,
        nested,
      })
      continue
    }
    const pane = panes.get(node.paneId)
    if (pane === undefined || pane.agent === null) continue
    out.push({
      channel: {
        id: node.key,
        key: channelKey({ paneId: pane.paneId, session: pane.agentSession }),
        status: 'live',
        kind,
        title: oneLine(node.full.label, TITLE_MAX),
        dot: node.dot,
        dotUnseen,
        depth: 0,
        origin: null,
        spawnedBy: null,
        parent: null,
        preview: previewOf({ pane, dot: node.dot, place: { worktree: worktree.path, home: state.home } }),
        waiting: waitingOf({ pane, dot: node.dot }),
        model: node.model,
        timeAt: node.timeAt,
        activityAt: pane.digest.lastActivityAt,
        outcome: pane.digest.turnOutcome?.outcome ?? null,
      },
      since: pane.agentState.observedAt,
      paneId: pane.paneId,
      nested,
    })
  }
  return out
}

function flatten(roots: readonly AgentRowNode[]): { node: AgentRowNode; nested: boolean }[] {
  return roots.flatMap((root) => [{ node: root, nested: false }, ...root.children.map((child) => ({ node: child, nested: true }))])
}
