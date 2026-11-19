// 세션 히스토리 (LIFE-808) — 지난 에이전트 세션 목록·검색·재개의 경계 타입과 순수 함수.
//
// main(`main/session-history.ts`)이 디스크 기록을 훑어 행을 만들고, 렌더러(`SessionHistoryView`)가 범위·검색·필터를 건다.
// 범위(C4)·검색(C5)·빈 세션/에이전트 필터(C17·C18)·재개 명령 글(C9)은 여기 한 곳 — 두 층이 같은 규칙을 쓴다.

/** 1차 provider (00-analysis §6 결정 1 — Grok 은 뺀다). */
export type HistoryProvider = 'claude' | 'codex'
export const HISTORY_PROVIDERS: readonly HistoryProvider[] = ['claude', 'codex']

/** 목록 한 행 — 목록 스캔(앞뒤 창)만으로 채운다. 못 읽은 칸은 null(지어내지 않는다). */
export type SessionHistoryRow = {
  provider: HistoryProvider
  id: string
  /** 기록 파일 절대경로 (C19 「기록 경로 복사」). */
  file: string
  /** Claude = customTitle > aiTitle > 첫 프롬프트 · Codex = session_index thread_name > 첫 프롬프트 (C2). 셋 다 없으면 null. */
  title: string | null
  /** 마지막으로 기록된 cwd(없으면 첫 cwd). */
  cwd: string | null
  /** cwd 의 비교 키 — 있으면 realpath, 없으면 문자열 정규화(C4). */
  cwdKey: string | null
  cwdExists: boolean
  /** Codex 기록에는 브랜치가 없다 — 그때 null(지어내지 않는다). */
  branch: string | null
  model: string | null
  /** 첫 사람 프롬프트 한 줄 미리보기(앞 `PREVIEW_MAX` 자). */
  firstPrompt: string | null
  /** 마지막 사람 프롬프트 한 줄 미리보기. */
  lastPrompt: string | null
  /** 마지막 기록 줄의 timestamp, 없으면 파일 mtime (epoch ms). */
  lastActivityAt: number
  /** 빈 세션(C17) — 사람 프롬프트 0 개. 정의는 `main/session-history.ts` 의 `parseClaudeSession`·`parseCodexSession` 주석. */
  empty: boolean
}

/** 목록 미리보기 상한 — 붙여넣기 수십 KB 를 IPC 로 나르지 않는다. */
export const PREVIEW_MAX = 300

export type SessionHistoryListInput = { providers: HistoryProvider[] }
export type SessionHistoryListResult =
  /** `realpaths` = 등록 레포 root·worktree 경로 → realpath (C4 R1-8 — 렌더러가 활성 worktree 를 행 `cwdKey` 와 같은 눈으로 비교한다). */
  | { kind: 'ok'; rows: SessionHistoryRow[]; unreadable: number; realpaths: Record<string, string> }
  | { kind: 'error'; message: string }

/** 상세의 한 턴 — 사람 발화 또는 응답 말풍선. */
export type SessionHistoryTurn = { role: 'prompt' | 'reply'; text: string; at: number | null }

/** 재개 계획(C7) — main 이 스캔 결과·디스크·등록 레포로 정한다. 렌더러는 보여 주기만 한다. */
export type ResumePlan = {
  argv: string[]
  cwd: string
  /** 원래 cwd 가 없어 대체 경로에서 재개한다. */
  fallback: boolean
  /** 재개를 막는 사유(그때는 복사만). null 이면 재개 가능. */
  disabled: string | null
}

export type SessionHistoryDetail = {
  provider: HistoryProvider
  id: string
  file: string
  /** 첫 사람 프롬프트 전문(자르지 않는다 — C6). 없으면 null. */
  firstPrompt: string | null
  /** 최근 턴 — 마지막 `RECENT_TURNS` 개 말풍선(각 `TURN_TEXT_MAX` 자까지). */
  recent: SessionHistoryTurn[]
  /** 메시지 수 — 정의는 `main/session-history.ts` 의 `readDetail` 주석. */
  messageCount: number
  cwd: string | null
  cwdExists: boolean
  resume: ResumePlan
  /** 「명령 복사」·명령 미리보기 글 — `resumeCommandText(resume)` 와 같은 값. */
  command: string
}

export type SessionKey = { provider: HistoryProvider; id: string }
export type SessionHistoryDetailResult = { kind: 'ok'; detail: SessionHistoryDetail } | { kind: 'error'; message: string }
export type SessionHistoryResumeInput = SessionKey & { workspaceId: string }
export type SessionHistoryResumeResult =
  /** 새 탭을 만들었다 — 렌더러는 그 pane 이 상태에 도착한 뒤 선택·탭 펴기를 한다(R2-1, 새 탭 경로와 같은 장치). */
  | { kind: 'started'; paneId: string | null; tabId: string | null; workspaceId: string }
  /** 같은 세션의 재개가 이미 진행 중이다(R1-2) — 새 프로세스를 만들지 않았다. */
  | { kind: 'pending' }
  | { kind: 'open'; paneId: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'error'; message: string }
export type SessionHistoryRevealResult = { kind: 'ok' } | { kind: 'rejected'; reason: string } | { kind: 'error'; message: string }

/** 최근 턴 개수(C6 — 워커 재량): 사람·응답 말풍선 6 개 ≈ 최근 3 왕복. */
export const RECENT_TURNS = 6
/** 최근 턴 한 말풍선의 글 상한. 첫 프롬프트는 자르지 않는다. */
export const TURN_TEXT_MAX = 4000

/** 세션 id 는 UUID 꼴만 받는다(C7) — 그 밖의 값은 argv 에 싣지 않는다. Claude·Codex 둘 다 UUID 다. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function isHistoryProvider(value: unknown): value is HistoryProvider {
  return value === 'claude' || value === 'codex'
}

/** IPC 입력 `{provider, id}` 를 모양으로 읽는다 — 아니면 null(거절). */
export function readSessionKey(input: unknown): SessionKey | null {
  if (typeof input !== 'object' || input === null) return null
  const provider: unknown = Reflect.get(input, 'provider')
  const id: unknown = Reflect.get(input, 'id')
  if (!isHistoryProvider(provider) || !isSessionId(id)) return null
  return { provider, id }
}

/** 재개 argv (C7) — 모델·effort 플래그 없음. 셸 문자열이 아니라 인자 배열이다. */
export function resumeArgv(key: SessionKey): string[] {
  switch (key.provider) {
    case 'claude':
      return ['claude', '--resume', key.id]
    case 'codex':
      return ['codex', 'resume', key.id]
  }
}

/** 셸에 붙여 넣을 때만 쓰는 따옴표 — 안전한 글자뿐이면 그대로, 아니면 작은따옴표로 감싼다. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 「명령 복사」 글(C9) — 언제나 `cd <재개 cwd> && <argv>` 꼴. 원래 cwd 든 대체 cwd 든 **실제로 재개할 폴더**를 앞에 붙여,
 * 어느 터미널에 붙여 넣어도 재개 단추와 같은 자리에서 돈다. 상세의 명령 미리보기도 이 글 그대로다(바이트 같음).
 */
export function resumeCommandText(plan: Pick<ResumePlan, 'argv' | 'cwd'>): string {
  return `cd ${shellQuote(plan.cwd)} && ${plan.argv.map(shellQuote).join(' ')}`
}

// --- 열림(C8) -----------------------------------------------------------------------------------

/** 열림 판정 재료 — pane 하나의 감지된 에이전트와 세션 참조 id. */
export type PaneSession = { paneId: string; agent: string | null; sessionId: string | null }

/**
 * 「열림」(C8 · R1-1) = **에이전트가 감지된** pane(`agent` 가 그 행의 provider)이고 세션 id 가 같을 때만. 에이전트가 끝나 세션 참조만
 * 남은 pane(`agent: null`)·다른 provider 의 pane 은 열림이 아니다 — 그 세션은 재개할 수 있다. main 가드와 렌더러 표지가 이 함수 하나를 쓴다.
 */
export function isOpenSession({ pane, key }: { pane: PaneSession; key: SessionKey }): boolean {
  return pane.agent !== null && pane.agent === key.provider && pane.sessionId === key.id
}

/** 그 세션이 열린 pane — 없으면 null. */
export function openPaneOf({ panes, key }: { panes: readonly PaneSession[]; key: SessionKey }): string | null {
  return panes.find((pane) => isOpenSession({ pane, key }))?.paneId ?? null
}

// --- 범위(C4) -----------------------------------------------------------------------------------

export type HistoryScope = 'worktree' | 'project' | 'machine'
export const HISTORY_SCOPES: readonly { id: HistoryScope; title: string }[] = [
  { id: 'worktree', title: '현재 worktree' },
  { id: 'project', title: '프로젝트' },
  { id: 'machine', title: '머신 전체' },
]

/** `child` 가 `parent` 와 같거나 그 아래 — 경로 경계로 본다(`/a/foo` 는 `/a/foobar` 를 품지 않는다). */
export function isPathWithin({ child, parent }: { child: string; parent: string }): boolean {
  const base = parent.length > 1 && parent.endsWith('/') ? parent.slice(0, -1) : parent
  if (child === base) return true
  return child.startsWith(base === '/' ? '/' : `${base}/`)
}

export type ScopeContext = {
  /** 활성 worktree 경로 — 없으면 null. */
  worktree: string | null
  /** 활성 worktree 가 속한 등록 레포 — root 와 연결 worktree 경로들. */
  repo: { root: string; worktrees: string[] } | null
}

/** corral 이 worktree 를 두는 자리(AGENTS.md 「worktree 는 전부 .claude/worktrees/ 아래」) — 루트 기준 상대. */
export const CORRAL_WORKTREES_DIR = '.claude/worktrees'

export type ScopedRows = { kind: 'rows'; rows: SessionHistoryRow[] } | { kind: 'no-worktree' }

/**
 * 범위 거르기(C4). 현재 worktree = cwd 가 활성 worktree 와 같거나 그 아래 — 단 그 아래에 있는 **다른 등록 worktree** 아래의 행은 뺀다
 * (R1-8 — 루트 체크아웃이 활성일 때 `<root>/.claude/worktrees/*` 세션이 섞이지 않게) · 프로젝트 = 그 레포 root 아래(지운
 * `<root>/.claude/worktrees/X` 의 세션도 root 접두로 묶인다) 또는 연결 worktree 중 하나의 아래 · 머신 전체 = 전부.
 * 활성 worktree 가 없으면 현재 worktree·프로젝트 범위는 빈 목록이 아니라 `no-worktree` 다.
 */
export function scopeRows({ rows, scope, context }: { rows: readonly SessionHistoryRow[]; scope: HistoryScope; context: ScopeContext }): ScopedRows {
  switch (scope) {
    case 'machine':
      return { kind: 'rows', rows: [...rows] }
    case 'worktree': {
      const worktree = context.worktree
      if (worktree === null) return { kind: 'no-worktree' }
      const others = context.repo === null ? [] : [context.repo.root, ...context.repo.worktrees]
      const nested = others.filter((other) => other !== worktree && isPathWithin({ child: other, parent: worktree }))
      // R2-7 — 루트 체크아웃이 활성이면 `<root>/.claude/worktrees/` 아래는 등록 여부와 무관하게 뺀다(지운 worktree 의 세션 포함).
      if (context.repo !== null && context.repo.root === worktree) nested.push(`${worktree === '/' ? '' : worktree}/${CORRAL_WORKTREES_DIR}`)
      return {
        kind: 'rows',
        rows: rows.filter((row) => row.cwdKey !== null && isPathWithin({ child: row.cwdKey, parent: worktree }) && !nested.some((parent) => isPathWithin({ child: row.cwdKey ?? '', parent }))),
      }
    }
    case 'project': {
      if (context.worktree === null) return { kind: 'no-worktree' }
      const bases = context.repo === null ? [context.worktree] : [context.repo.root, ...context.repo.worktrees]
      return { kind: 'rows', rows: rows.filter((row) => row.cwdKey !== null && bases.some((parent) => isPathWithin({ child: row.cwdKey ?? '', parent }))) }
    }
  }
}

// --- 검색(C5) · 필터(C17·C18) --------------------------------------------------------------------

/** 검색 대상 칸 — 제목·cwd·브랜치·모델·첫 프롬프트 미리보기·마지막 프롬프트. */
function searchFields(row: SessionHistoryRow): string[] {
  return [row.title, row.cwd, row.branch, row.model, row.firstPrompt, row.lastPrompt].flatMap((value) => (value === null ? [] : [value.toLowerCase()]))
}

/** 공백으로 나눈 낱말이 **모두**(AND) 어느 칸엔가 대소문자 무시 부분 일치하면 남는다. 빈 검색어 = 그대로. */
export function searchRows({ rows, query }: { rows: readonly SessionHistoryRow[]; query: string }): SessionHistoryRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const fields = searchFields(row)
    return words.every((word) => fields.some((field) => field.includes(word)))
  })
}

export type HistoryAgents = Record<HistoryProvider, boolean>
export const DEFAULT_HISTORY_AGENTS: HistoryAgents = { claude: true, codex: true }

/** 에이전트 필터(C18)·빈 세션 숨기기(C17). */
export function filterRows({ rows, agents, hideEmpty }: { rows: readonly SessionHistoryRow[]; agents: HistoryAgents; hideEmpty: boolean }): SessionHistoryRow[] {
  return rows.filter((row) => agents[row.provider] && (!hideEmpty || !row.empty))
}

/** ui-prefs 의 에이전트 필터 칸 — 모양이 틀리면 기본값(둘 다 켬). 칸마다 따로 본다. */
export function readHistoryAgents(value: unknown): HistoryAgents {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_HISTORY_AGENTS }
  const claude: unknown = Reflect.get(value, 'claude')
  const codex: unknown = Reflect.get(value, 'codex')
  return { claude: typeof claude === 'boolean' ? claude : true, codex: typeof codex === 'boolean' ? codex : true }
}

/** 켠 provider 목록 — 목록 IPC 입력(끈 쪽은 main 이 훑지 않는다). */
export function enabledProviders(agents: HistoryAgents): HistoryProvider[] {
  return HISTORY_PROVIDERS.filter((provider) => agents[provider])
}
