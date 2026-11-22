// diff 줄 메모를 모아 에이전트에게 보내기 (LIFE-832) — 렌더러(본문·후보)와 main(접수 재검사)이 같이 쓰는 순수 함수.
//
// · 메모 대상 = 오른쪽이 작업 파일인 diff 모드 넷의 오른쪽 줄(00-analysis D1). 줄 번호가 에이전트가 여는 파일과 같다.
// · 본문(D9) = 머리 한 줄 + 메모마다 `File:`/`Line:`/`Code:`/`Note:` 네 줄, 파일 경로 → 줄 순. 글 칸은 `"…"` 로 감싸고 안의 `\`·`"`·줄바꿈을
//   이스케이프한다(orca `formatDiffComment` 와 같은 결) — 본문의 줄바꿈은 구조에만 있다. 탭도 `\t` 로 — claude 기록이 붙여 넣은 탭을 공백으로 바꿔 대조가 깨진다(최종 관문). 제어문자는 폰 지시와 같은 `cleanBody` 규칙.
// · 대상(D5) = 그 worktree **자기 workspace** 의 에이전트 pane(claude·codex·grok). 부모·main workspace 의 pane 은 그 worktree 행이 아니라 후보에 없다.
//   세션 참조(`agentSession`)가 없으면 들어감을 확인할 수 없어 고를 수 없다.
import type { ScmDiffMode } from './scm.js'
import type { AgentStatus, WorktreeRow } from './types.js'
import { cleanBody, MAX_INPUT_BYTES, utf8Bytes } from './input-body.js'

/** 메모를 달 수 있는 diff 모드 — `sidesOf` 의 오른쪽이 작업 파일인 넷. */
const NOTE_MODES: ReadonlySet<ScmDiffMode> = new Set<ScmDiffMode>(['wt', 'wtType', 'wtRename', 'base'])

export function notesAllowed(mode: ScmDiffMode): boolean {
  return NOTE_MODES.has(mode)
}

/** 본문에 싣는 메모 하나 — `lineText` 는 메모를 단 때 그 줄의 내용. */
export type NoteForBody = { rel: string; line: number; lineText: string; body: string }

/** 메모 단 때 줄 내용의 상한(글자) — 긴 줄(번들·한 줄 JSON)이 본문을 채우지 않게. 넘으면 앞부분 + `…`. */
export const LINE_TEXT_MAX = 300

/** 코드 포인트 단위로 자른다(리뷰 r1 A2) — UTF-16 단위로 자르면 경계의 서로게이트 쌍이 갈려 본문이 ill-formed 가 된다. */
export function clipLineText(text: string): string {
  const points = [...text]
  return points.length > LINE_TEXT_MAX ? `${points.slice(0, LINE_TEXT_MAX).join('')}…` : text
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** 짝 없는 서로게이트가 없다(well-formed UTF-16 — UTF-8 로 바꿔도 바이트가 그대로다). */
export function wellFormed(text: string): boolean {
  return !new RegExp(LONE_SURROGATE.source).test(text)
}

/**
 * 본문 앞에 **타이핑하는** 리드 한 줄(리뷰 r1 A1) — 붙여 넣은 글뿐인 메시지는 provider 가 지시로 따르지 않을 수 있고(claude 는 거절한다),
 * claude 기록은 붙여 넣은 블록을 리드 아래 `<pasted_content>` 로 싼다. 줄바꿈이 없다 — 제출 Enter 는 본문 하나의 것이다.
 * 오케스트레이션 `PROMPT_LEAD` 와 뜻이 달라 따로 둔다. main 허브가 이 값을 치고, 확인 단계는 이 값과 본문을 같이 보인다.
 */
export const DIFF_NOTES_LEAD = '아래에 붙여 넣은 diff 리뷰 메모를 읽고 각 파일·줄에 반영해 주세요:'

/** 글 칸 — 제어문자를 지운 뒤 `"…"` 로 감싸고 `\`·`"`·줄바꿈·탭을 이스케이프한다(본문에 탭이 남지 않는다 — provider 가 탭을 바꿔 기록하는 일을 타지 않게). */
function quote(text: string): string {
  const clean = cleanBody(text).replace(LONE_SURROGATE, '\uFFFD')
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`
}

/** 경로 → 줄 순(코드 단위 비교 — 로캘에 따라 바뀌지 않는다). */
export function compareNotes(a: { rel: string; line: number }, b: { rel: string; line: number }): number {
  if (a.rel !== b.rel) return a.rel < b.rel ? -1 : 1
  return a.line - b.line
}

/**
 * 보낼 본문 — 결정적이다(같은 메모·같은 기준 → 같은 바이트). `against` = 메모를 단 diff 탭들의 비교 기준(중복·순서는 여기서 정리).
 * 돌려준 글은 이미 `cleanBody` 를 거쳤다 — 확인 단계에 보이는 글 = main 이 넣는 글.
 */
export function formatNotesBody(input: { notes: readonly NoteForBody[]; against: readonly string[] }): string {
  const against = [...new Set(input.against.map((text) => cleanBody(text).replace(/\n/g, ' ')))].sort()
  const head = `diff 리뷰 메모 ${input.notes.length}개${against.length === 0 ? '' : ` (비교 기준: ${against.join(', ')})`}`
  const blocks = [...input.notes].sort(compareNotes).map((note) => [`File: ${quote(note.rel)}`, `Line: ${note.line}`, `Code: ${quote(clipLineText(note.lineText))}`, `Note: ${quote(note.body)}`].join('\n'))
  // well-formed 단언(리뷰 r1 A2) — 글 칸은 이미 짝 없는 서로게이트를 U+FFFD 로 바꿨다. 머리(비교 기준 글)까지 같은 규칙으로 닫는다.
  return cleanBody([head, ...blocks].join('\n\n')).replace(LONE_SURROGATE, '\uFFFD')
}

/** 본문 상한 검사 — 넘으면 보내기 전에 막는다(L9). */
export function bodyTooLarge(text: string): boolean {
  return utf8Bytes(text) > MAX_INPUT_BYTES
}

// --- 대상 -------------------------------------------------------------------------------------------------

export type NoteAgentKind = 'claude' | 'codex' | 'grok'

const agentKindOf = (agent: string | null): NoteAgentKind | null => (agent === 'claude' || agent === 'codex' || agent === 'grok' ? agent : null)

export type NoteTarget = {
  paneId: string
  kind: NoteAgentKind
  /** 탭 이름(없으면 「탭 N」) — 여러 pane 을 구별하는 글. */
  tabLabel: string
  title: string
  status: AgentStatus
  /** 고를 수 있나 — 세션 참조가 없으면 들어감을 확인할 수 없다. */
  selectable: boolean
  reason: string | null
}

export const NO_SESSION_TEXT = '세션 기록을 찾을 수 없어 들어갔는지 확인할 수 없습니다'

/** 그 worktree 자기 workspace 의 에이전트 pane — 탭 순서 → pane 순서. 닫힌 workspace 면 빈 목록. */
export function noteTargets(worktree: WorktreeRow): NoteTarget[] {
  const tabs = [...(worktree.workspace?.tabs ?? [])].sort((a, b) => a.order - b.order)
  const out: NoteTarget[] = []
  for (const tab of tabs) {
    for (const pane of tab.panes) {
      const kind = agentKindOf(pane.agent)
      if (kind === null) continue
      const selectable = pane.agentSession !== null
      out.push({ paneId: pane.paneId, kind, tabLabel: tab.label.trim() === '' ? `탭 ${tab.number}` : tab.label, title: pane.title, status: pane.agentStatus, selectable, reason: selectable ? null : NO_SESSION_TEXT })
    }
  }
  return out
}

/** 기본 선택 — 고를 수 있는 후보가 정확히 하나면 그것. */
export function defaultTarget(targets: readonly NoteTarget[]): string | null {
  const selectable = targets.filter((target) => target.selectable)
  return selectable.length === 1 ? (selectable[0]?.paneId ?? null) : null
}

/** main 접수 재검사(D6) — 렌더러가 보낸 (worktree, pane) 이 지금 상태에서 그 worktree 자기 workspace 의 고를 수 있는 에이전트 pane 인가. */
export function checkNoteTarget(input: { worktrees: readonly WorktreeRow[]; worktree: string; paneId: string }): { ok: true; kind: NoteAgentKind } | { ok: false; reason: 'not_worktree' | 'not_target' | 'no_session' } {
  const row = input.worktrees.find((worktree) => worktree.path === input.worktree)
  if (row === undefined) return { ok: false, reason: 'not_worktree' }
  const target = noteTargets(row).find((candidate) => candidate.paneId === input.paneId)
  if (target === undefined) return { ok: false, reason: 'not_target' }
  if (!target.selectable) return { ok: false, reason: 'no_session' }
  return { ok: true, kind: target.kind }
}

// --- IPC -------------------------------------------------------------------------------------------------

export type DiffNotesSendInput = { requestId: string; worktree: string; paneId: string; text: string }
export type DiffNotesRefusal = 'bad_input' | 'too_large' | 'not_clean' | 'ill_formed' | 'empty' | 'not_worktree' | 'not_target' | 'no_session' | 'not_ready'
export type DiffNotesSendResult = { ok: true } | { ok: false; reason: DiffNotesRefusal }

/** 허브 상태(InputHub `InputState` 중 지시가 닿는 것). `unknown` = main 이 모르는 id(재시작 등). */
export type DiffNotesPhase = 'queued' | 'sending' | 'delivered' | 'unconfirmed' | 'failed' | 'cancelled' | 'unknown'
export type DiffNotesState = { requestId: string; state: DiffNotesPhase; wait: 'turn' | 'gate' | null; reason: string | null }

const PHASES: readonly DiffNotesPhase[] = ['queued', 'sending', 'delivered', 'unconfirmed', 'failed', 'cancelled', 'unknown']

/** 요청 id 모양 — 렌더러가 만든다. main 은 이 모양만 받는다. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

/** push 한 건 읽기 — 모양이 어긋나면 null. */
export function readDiffNotesState(value: unknown): DiffNotesState | null {
  if (typeof value !== 'object' || value === null) return null
  const requestId: unknown = Reflect.get(value, 'requestId')
  const state: unknown = Reflect.get(value, 'state')
  const wait: unknown = Reflect.get(value, 'wait')
  const reason: unknown = Reflect.get(value, 'reason')
  const phase = PHASES.find((item) => item === state)
  if (!isRequestId(requestId) || phase === undefined) return null
  if (wait !== null && wait !== 'turn' && wait !== 'gate') return null
  if (reason !== null && typeof reason !== 'string') return null
  return { requestId, state: phase, wait, reason }
}

/** 실패·접수 거절 사유 → 보이는 문구. 모르는 사유는 원문 코드를 붙인다. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  mac_input: '보내기를 접수한 뒤 그 pane 에 키 입력이 있어 넣지 않았습니다',
  mac_draft: '그 pane 입력창에 쓰던 글이 있어 넣지 않았습니다',
  draft_unknown: '그 pane 입력창이 비었는지 판단하지 못해 넣지 않았습니다',
  agent_view: 'Claude agent view 화면이라 넣지 않았습니다',
  target_changed: '접수 뒤 그 pane 의 세션이 바뀌어 넣지 않았습니다',
  closed: '그 pane 이 닫혔습니다',
  not_listed: '그 pane 을 찾을 수 없습니다',
  no_session: NO_SESSION_TEXT,
  not_ready: 'herdr 연결을 아직 읽지 못했습니다',
  guard_outdated: 'herdr guard 가 낡아 넣을 수 없습니다 — herdr 서버를 다시 시작하세요',
  record_unreadable: '세션 기록을 읽지 못했습니다',
  record_ambiguous: '세션 기록이 둘 이상이라 고를 수 없습니다',
  backend: 'herdr 호출이 실패했습니다',
  queue_full: '그 pane 에 대기 중인 지시가 너무 많습니다',
  empty: '보낼 메모가 없습니다',
  bad_input: '요청 모양이 맞지 않습니다',
  too_large: `본문이 상한(${MAX_INPUT_BYTES} 바이트)을 넘습니다`,
  not_clean: '본문에 넣을 수 없는 문자가 있습니다',
  ill_formed: '본문에 짝 없는 서로게이트 문자가 있습니다',
  lead_stranded: '본문은 넣지 않았습니다 — 그 pane 입력창에 리드 한 줄이 남았을 수 있습니다. 지우고 다시 보내세요',
  lead_unknown: '리드 한 줄이 들어갔는지 확인하지 못해 본문은 넣지 않았습니다 — 그 pane 입력창에 리드 한 줄이 남았을 수 있습니다. 지우고 다시 보내세요',
  lead_input: '리드를 친 뒤 그 pane 에 다른 입력이 있어 본문은 넣지 않았습니다 — 입력창에 리드 한 줄이 남았을 수 있습니다. 지우고 다시 보내세요',
  lead_pane_gone: '리드를 친 뒤 그 pane 이 없어져 본문은 넣지 않았습니다',
  not_worktree: '그 worktree 를 찾을 수 없습니다',
  not_target: '그 pane 은 이 worktree 의 에이전트 pane 이 아닙니다',
}

export function reasonText(reason: string | null): string {
  if (reason === null) return '알 수 없는 사유'
  return REASON_TEXT[reason] ?? `사유 ${reason}`
}
