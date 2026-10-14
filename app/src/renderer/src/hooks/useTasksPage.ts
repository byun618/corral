// 작업 페이지 상태·자료 (LIFE-601) — 화면(TasksPage)은 그리기만, 여기서 출처 요청·영속·낙관적 반영을 한다.
//
// - 요청은 `window.corral.workRequest` 하나(T1 계약). 요청 id 는 `LatestGate` 가 매기고, 같은 열쇠의 마지막 요청 응답만 받는다(C7 늦은 응답 폐기):
//   `load`(스페이스 자료) · `more`(다음 쪽) · `find`(키 검색) · `item:<연결>::<id>`(작업 하나의 쓰기) · `transitions`(끄는 작업의 허용 전이).
// - 작업 정체는 `(연결, 작업 id)`(R1-L) — 작업 id 는 연결 안에서만 유일하다.
// - 끌기 = 즉시 반영 → 요청 → 성공이면 되돌리기 토스트(6초) / 실패면 그 카드만 옮기기 전으로 + 오류 토스트 + 서버 재조회.
//   **경합 표면을 줄인다(수정 r2)**: 한 카드에 확인 안 된 쓰기는 하나뿐이다 — 그동안 그 카드의 끌기·되돌리기는 잠긴다(「확인하는 중」).
//   그래서 같은 카드의 응답 순서가 뒤집힐 일이 없고, 「옮기기 전 값」 은 언제나 출처가 마지막으로 인정한 값이다(되돌리기는 그 값을 보낸다).
//   실패·버린 응답이면 그 카드 하나만 옮기기 전 자리로 돌리고(다른 카드의 순서는 건드리지 않는다) 서버를 다시 읽어 수렴한다.
//   목록 응답이 오면 확인 안 된 쓰기(시작 시점과 무관하게)와 그 요청 뒤에 화면에 쓴 변경을 그 위에 다시 적용한다(R1-F·R2-C).
// - **수렴 규칙(수정 r3) — 서버가 정본이다.** 순서 쓰기는 성공해도 의도를 다시 적용하지 않는다: 같은 스페이스의 순서 쓰기가 모두 끝나면
//   목록을 서버에서 다시 읽어 확정 순서로 맞춘다(그동안 화면은 낙관적 순서 그대로 — 깜빡이지 않는다, R3-A). 성공한 쓰기는 작업 중 조회의
//   그 키 응답을 무효화하고 서버 값을 쓴다 — 완료 분류를 넘나들면 작업 중·키 조회를 전부 다시 받는다(종속 막힘, R3-B·C).
// - 쓰기·잠금·화면 변경은 **연결 세대**에 귀속한다(R3-D) — 세대가 바뀌면 이전 세대의 확인 안 된 쓰기는 잠금을 풀고, 새 자료에 다시 적용하지도
//   원복하지도 않는다(늦게 온 그 응답은 버린다).
// - 출처 요청은 `ask` 하나로 — preload Promise 의 reject 는 `network` 실패 응답으로 바꾼다(R3-E). 30초 안에 답이 없으면 **확정 실패가 아니라 「늦음」** 이다(R4-A):
//   읽기는 시간 초과 오류(다시 시도)로, 쓰기는 「확인 지연」 — 잠금만 풀고 낙관적 값은 둔 채, 원래 요청이 끝나면(성공·실패 무관) 서버를 다시 읽어 맞춘다.
// - 스페이스 목록 조회(연결별 · 세대별)는 시도·실패를 보존한다 — 실패하면 「다시 시도」 까지 다시 보내지 않는다(R1-C).
// - 스페이스 선택(R1-D): 첫 선택(이 실행에서 처음 열 때 — 레포 기본 → 마지막 → 첫 스페이스, 목록을 받는 중이면 기다림) · 재열기는 그대로 ·
//   설정이 바뀌어 고른 스페이스가 없어지면(숨김·연결 제거) 다시 고른다.
// - 키 검색은 검색어·연결 세대·키 모양이 바뀔 때만 조회한다 — 상태 push(새 settings 객체)는 조회를 다시 부르지 않는다. 닫힌 동안은 조회하지 않는다(R1-B).
// - 영속(C3): 스페이스·보기·필터·정렬·그룹·밀도·프리셋 기본 → ui-prefs `tasksPage`. 검색어·스크롤은 페이지가 마운트를 유지해 같은 실행 안에서 남고,
//   다시 열 때의 조용한 새로고침은 **더 받아 둔 쪽 수만큼** 다시 받는다(R1-N).
// - **상세 쓰기(LIFE-602 D3)** — `writeItem` 은 끌기(`move`)와 **같은 잠금**(`pendingWrites`, 작업 uid 마다 하나)·같은 세대 귀속·같은 30초
//   「확인 지연」 을 쓴다. 상세에서 저장 중인 작업은 보드에서 끌 수 없고, 끄는 중(확인 전)인 작업은 상세에서 저장하지 않는다(`busy`).
//   성공한 쓰기는 보드 자료에 서버 값을 쓰고, `settled` 로 알려 열린 상세가 같은 값을 받는다(보드 끌기 결과도 상세에 들어간다).
//   상세 단건 읽기(첫 읽기·재조회·새로 불러오기)가 진행 중인 작업도 보드에서 끌거나 되돌릴 수 없다(`reading`, R6-D — 같은 작업 직렬화).
//   보드 쓰기가 시작되면 `startedWrite` 로 알려 열린 상세의 되돌리기 토스트가 곧바로 사라진다(R6-B).
//   선택(열린 상세)·상세 크기는 ui-prefs 에 남긴다(C1 — 닫았다 다시 열거나 재시작해도 복원).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkCall, WorkError, WorkItem, WorkResolutionChoice, WorkResponse, WorkResult, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import {
  DEFAULT_TASKS_PREFS,
  LatestGate,
  applyIntent,
  compareRank,
  detectWorking,
  initialSpace,
  itemUid,
  latestActivity,
  parseUid,
  readTasksPrefs,
  restorableResolution,
  rowUid,
  rowsOf,
  sameSpace,
  searchKey,
  spaceGroups,
  spaceId,
  spaceStillValid,
  UNRESTORABLE_RESOLUTION,
  type DragIntent,
  type SpaceData,
  type TasksPrefs,
  type TasksRow,
  type TasksSpace,
  type WorkingTree,
} from '../tasks-model.js'
import { paneDot, tabStatus } from '../tab-status.js'

export type TasksBanner = { kind: 'auth' | 'forbidden' | 'offline' | 'error'; message: string }

export type TasksLoad = { spaceId: string | null; phase: 'idle' | 'loading' | 'ready' | 'error'; data: SpaceData[]; error: WorkError | null; loadingMore: boolean }

export type SearchHit = { connectionId: string; item: WorkItem; spaceName: string }
/** 작업 중 항목의 조회 결과 — 찾는 중 · 찾음 · 출처에 없음 · 실패. */
export type WorkingLookup = { state: 'loading' } | { state: 'found'; item: WorkItem; spaceName: string } | { state: 'missing' } | { state: 'error'; message: string }
type StoredLookup = { state: 'loading' } | { state: 'found'; item: WorkItem } | { state: 'missing' } | { state: 'error'; message: string }

/** 끄는 작업의 허용 전이(`allowed` 모드) — 받는 중 · 받음 · 실패. 받기 전·실패면 다른 칸은 흐림(fail-closed, C7). */
export type TasksTransitions = { uid: string; state: 'loading' } | { uid: string; state: 'ready'; keys: string[] } | { uid: string; state: 'error'; message: string } | null

export type MoveRequest = { row: TasksRow; intent: DragIntent }
/** `undo` 는 받아들였으면 true — 그 카드가 잠겨 있으면 false 이고 버튼은 남는다(R4-E). */
/** `bind` — 토스트를 띄운 쪽이 지우는 손잡이를 받는다(LIFE-602 수정 5: 상세 되돌리기는 다음 쓰기·판 변화에 곧바로 사라진다). 보드 되돌리기는 쓰지 않는다. */
export type MoveNotice = { kind: 'moved'; label: string; undo: () => boolean; bind?: (dismiss: () => void) => void } | { kind: 'undone'; label: string } | { kind: 'failed'; message: string } | { kind: 'delayed'; message: string }
  /** 되돌릴 수 없는 변경(LIFE-602 수정 1 R1-G — 원래 완료 갈래를 복원할 수 없음) — 되돌리기 버튼 없이 그 사실을 보인다. */
  | { kind: 'final'; label: string }

/**
 * 상세의 쓰기 하나(LIFE-602) — 잠금 열쇠는 `(연결, itemId)`. `optimistic` 이 있으면 보드 자료에 먼저 쓰고, 실패하면 그 작업만 쓰기 전 값으로 돌린다.
 * 자식 만들기는 부모의 잠금을 쓴다(`itemId` = 부모).
 */
export type ItemWrite = { connectionId: string; spaceKey: string; itemId: string; call: WorkCall; optimistic: ((item: WorkItem) => WorkItem) | null }
/** 결과 — 성공 · 출처 실패(충돌 포함) · 잠김(앞 쓰기 확인 중 — 보내지 않았다) · 늦음(확인 지연, 실패 아님) · 버림(세대가 바뀜·더 새 요청). */
export type ItemWriteOutcome = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'busy' } | { kind: 'late'; settled: Promise<LateSettled> } | { kind: 'stale' }
/** 확인 지연 뒤 끝난 결과(LIFE-602 수정 1 R1-C) — 상세가 서버 정본으로 돌아가거나 초안을 남기는 데 쓴다. 세대가 바뀌었으면 stale. */
export type LateSettled = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'stale' }
/** 성공한 쓰기의 서버 값 — 열린 상세가 받는다. `seq` 는 같은 값이 다시 와도 알 수 있게. */
export type SettledWrite = { uid: string; item: WorkItem; seq: number }

type SpaceResult = { ok: true; data: SpaceData; pages: number } | { ok: false; error: WorkError }
type SpaceFetch = { state: 'pending' } | { state: 'done' } | { state: 'failed'; error: WorkError }
/** 키 조회 결과 — 그 결과를 낸 검색어에 귀속한다. 검색어가 바뀌면 새 응답 전까지 옛 결과를 보이지 않는다(R3-I). */
type KeySearch = { query: string; hits: { connectionId: string; item: WorkItem }[]; errors: { connectionId: string; error: WorkError }[] }
/** 화면에 쓴 변경 하나 — 그보다 먼저 시작한 목록 응답에 다시 적용한다(R1-F). 확인 안 된 쓰기도 이 모양으로 남긴다(R2-C). */
type Override = { seq: number; connectionId: string; generation: number; spaceKey: string; apply: (items: WorkItem[]) => WorkItem[] }

const EMPTY_LOAD: TasksLoad = { spaceId: null, phase: 'idle', data: [], error: null, loadingMore: false }
const NO_SEARCH: KeySearch = { query: '', hits: [], errors: [] }

/**
 * 렌더러 쪽 기다림 한도 — **출처 연산 전체의 시간 제한이 아니다**(R4-A). main 의 MCP 15초(`mcp-http.ts`)는 RPC 한 번의 한도이고, 연산 하나가
 * RPC 여러 번이다(LA `setPlacement` = `issue_update` 뒤 대상·체크포인트·프로젝트 `issue_get` 을 차례로) — 그래서 정상 연산도 30초를 넘을 수 있다.
 * 이 한도는 「영원히 안 오는 응답에 잠금·불러오는 중이 갇히지 않게」 만 쓴다: 넘으면 「늦음」 이고 원래 요청은 계속 기다린다.
 */
const REQUEST_TIMEOUT_MS = 30_000
/** 상세가 그 작업을 다시 받는 중 — 보드 잠금 이유·막힘 알림(R6-D). */
export const DETAIL_READING = '상세를 받는 중'

/** 요청 하나의 결과 — 한도 안에 답함 · 늦음(원래 답은 `answer` 로 계속 온다). */
type Asked = { kind: 'answered'; response: WorkResponse } | { kind: 'late'; answer: Promise<WorkResponse> }

/** 출처 요청 하나 — reject 도 `ok:false` 응답으로(R3-E). 잠금·원복 경로가 예외로 건너뛰어지지 않는다. */
async function ask({ requestId, connectionId, call }: { requestId: string; connectionId: string; call: WorkCall }): Promise<Asked> {
  const answer = window.corral.workRequest({ requestId, connectionId, call }).catch((error: unknown): WorkResponse => ({
    requestId, connectionId, ok: false, error: { kind: 'network', message: `요청이 끊겼습니다 — ${error instanceof Error ? error.message : String(error)}`, status: null },
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Asked>((resolve) => { timer = setTimeout(() => resolve({ kind: 'late', answer }), REQUEST_TIMEOUT_MS) })
  try {
    return await Promise.race([answer.then((response): Asked => ({ kind: 'answered', response })), late])
  } finally {
    clearTimeout(timer)
  }
}

/** 읽기 요청 — 늦으면 시간 초과 오류다(「다시 시도」 로 다시 받는다). 늦게 온 원래 답은 버린다. */
export async function request({ requestId, connectionId, call }: { requestId: string; connectionId: string; call: WorkCall }): Promise<WorkResponse> {
  const asked = await ask({ requestId, connectionId, call })
  return asked.kind === 'answered' ? asked.response : { requestId, connectionId, ok: false, error: { kind: 'network', message: '응답이 없습니다 — 시간이 지났습니다.', status: null } }
}

function bannerOf(error: WorkError): TasksBanner {
  switch (error.kind) {
    case 'auth': return { kind: 'auth', message: error.message }
    case 'forbidden': return { kind: 'forbidden', message: error.message }
    case 'network': return { kind: 'offline', message: error.message }
    default: return { kind: 'error', message: error.message }
  }
}

/** 끌기 의도 → 출처 연산. 판(`ifVersion`)은 싣지 않는다 — 보드 끌기는 충돌 배너가 없는 자리다(Q7: 보드는 조용히 새 값으로). */
function callOf({ item, intent, restore }: { item: WorkItem; intent: DragIntent; restore: WorkResolutionChoice | null }): WorkCall | null {
  switch (intent.kind) {
    // 되돌리기가 완료함·취소함으로 돌아갈 때만 그 갈래를 싣는다(R1-G) — 그 밖에는 지금처럼 갈래 없이(출처 기본).
    case 'status': return restore === null ? { op: 'changeStatus', itemId: item.id, statusKey: intent.statusKey, ifVersion: null } : { op: 'changeStatus', itemId: item.id, statusKey: intent.statusKey, ifVersion: null, resolution: restore }
    case 'reorder': return { op: 'reorder', itemId: item.id, afterId: intent.afterId }
    case 'placement': return { op: 'setPlacement', itemId: item.id, placement: intent.placement, ifVersion: null }
    case 'none': return null
  }
}

/** 되돌리기 의도 — 옮기기 전 값으로. 순서는 옮기기 전 바로 앞 작업 뒤로. */
function inverseOf({ item, intent, items }: { item: WorkItem; intent: DragIntent; items: WorkItem[] }): DragIntent {
  switch (intent.kind) {
    case 'status': return { kind: 'status', statusKey: item.statusKey }
    case 'placement': return { kind: 'placement', placement: item.placement ?? 'board' }
    case 'reorder': {
      const ordered = [...items].sort(compareRank)
      const index = ordered.findIndex((entry) => entry.id === item.id)
      return { kind: 'reorder', afterId: index > 0 ? (ordered[index - 1]?.id ?? null) : null }
    }
    case 'none': return intent
  }
}

function describe({ item, intent, statuses }: { item: WorkItem; intent: DragIntent; statuses: WorkStatus[] }): string {
  switch (intent.kind) {
    case 'status': return `${item.key} → ${statuses.find((status) => status.key === intent.statusKey)?.label ?? '다른 상태'}`
    case 'placement': return `${item.key} → ${intent.placement === 'board' ? '보드' : '백로그'}`
    case 'reorder': return `${item.key} 순서를 옮겼습니다`
    case 'none': return item.key
  }
}

/** 작업 하나의 상태·분류·배치를 그 값으로(순서 값은 둔다). */
function setFields({ item }: { item: WorkItem }): (items: WorkItem[]) => WorkItem[] {
  return (items) => items.map((entry) => (entry.id === item.id ? { ...entry, statusKey: item.statusKey, category: item.category, placement: item.placement } : entry))
}

/** 목록 자료의 작업을 서버 값으로 — 목록은 가벼운 모양(본문·연결 null)을 지킨다. */
function replaceItem({ item }: { item: WorkItem }): (items: WorkItem[]) => WorkItem[] {
  return (items) => items.map((entry) => (entry.id === item.id ? { ...item, body: entry.body, relations: entry.relations } : entry))
}

/** 완료 분류를 넘나들었나 — 그 작업이 막던 작업의 막힘 표시가 바뀐다(R2-J). */
function crossesDone({ from, to }: { from: WorkItem; to: WorkItem }): boolean {
  return (from.category === 'done') !== (to.category === 'done')
}

function patternOf({ settings, sourceId }: { settings: WorkSettingsState; sourceId: string }): string | null {
  return settings.sources.find((source) => source.id === sourceId)?.keyPattern ?? null
}

export function useTasksPage({ open, repos, activeRepoRoot, notify }: {
  open: boolean
  repos: RepoRow[]
  activeRepoRoot: string | null
  notify: (notice: MoveNotice) => void
}) {
  const gate = useRef(new LatestGate()).current
  const [prefs, setPrefsState] = useState<TasksPrefs>(DEFAULT_TASKS_PREFS)
  const [prefsReady, setPrefsReady] = useState(false)
  const [settings, setSettings] = useState<WorkSettingsState | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [space, setSpace] = useState<TasksSpace | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 성공한 쓰기의 서버 값 — 열린 상세가 받는다(LIFE-602). */
  const [settledWrite, setSettledWrite] = useState<SettledWrite | null>(null)
  const settledSeq = useRef(0)
  const [load, setLoad] = useState<TasksLoad>(EMPTY_LOAD)
  const [search, setSearch] = useState<KeySearch>(NO_SEARCH)
  const [working, setWorking] = useState<Map<string, StoredLookup>>(new Map())
  const [transitions, setTransitions] = useState<TasksTransitions>(null)
  const [spaceFetch, setSpaceFetch] = useState<ReadonlyMap<string, SpaceFetch>>(new Map())
  const loadRef = useRef(load)
  loadRef.current = load
  const overrides = useRef<Override[]>([])
  const writeSeq = useRef(0)
  /** 확인 안 된 쓰기 — 카드(uid)마다 하나. 있으면 그 카드의 끌기·되돌리기는 잠긴다(R2-A). */
  const pendingWrites = useRef(new Map<string, Override>())
  /** 확인 안 된 쓰기 중 순서 쓰기 — 같은 스페이스의 순서 쓰기가 다 끝나면 서버에서 다시 읽는다(R3-A). */
  const reorders = useRef(new WeakSet<Override>())
  /** 확인이 늦은 쓰기(R4-A) — 잠금은 풀었지만 답이 올 때까지 목록 응답에 다시 적용한다(낙관적 값 유지). */
  const lagging = useRef(new Set<Override>())
  /** 다시 적용할 기록이 없는 확정(순서 성공·늦은 답) 수 — 목록 요청 뒤 이 값이 바뀌었으면 그 응답은 버리고 다시 읽는다(R4-C). */
  const settles = useRef(0)
  /** 쓰기 실패·완료 분류 변경 뒤 서버 재조회 — `reload` 는 아래에서 정의된다. */
  const reloadRef = useRef<(options: { quiet: boolean }) => Promise<void>>(async () => {})
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  /** 상세 단건 읽기가 진행 중인 카드(uid → 수) — 보드 쓰기(끌기·되돌리기)도 막는다(LIFE-602 R6-D). */
  const detailReads = useRef(new Map<string, number>())
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set())
  /** 보드 쓰기 시작 — 열린 상세가 받아 같은 작업의 되돌리기 토스트를 지운다(R6-B). */
  const [startedWrite, setStartedWrite] = useState<{ uid: string; seq: number } | null>(null)
  /** 스페이스 자료(연결·스페이스)마다 받아 둔 쪽 수 — 다시 열 때 그만큼 다시 받는다(R1-N). */
  const pagesRef = useRef(new Map<string, number>())

  // --- 영속 ---
  useEffect(() => {
    let alive = true
    void window.corral.getUiPrefs().then((value) => {
      if (!alive) return
      setPrefsState(readTasksPrefs(value.tasksPage))
      setPrefsReady(true)
    }).catch(() => setPrefsReady(true))
    return () => { alive = false }
  }, [])
  const setPrefs = useCallback((patch: Partial<TasksPrefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch }
      window.corral.setUiPrefs({ tasksPage: next })
      return next
    })
  }, [])
  // 열린 상세(LIFE-602 C1) — 불러온 뒤 한 번 복원하고, 그 뒤 선택이 바뀌면 남긴다.
  const detailRestored = useRef(false)
  useEffect(() => {
    if (!prefsReady || detailRestored.current) return
    detailRestored.current = true
    if (prefs.detail !== null) setSelectedId(itemUid(prefs.detail))
  }, [prefsReady, prefs.detail])
  useEffect(() => {
    if (!detailRestored.current) return
    const next = selectedId === null ? null : parseUid(selectedId)
    const same = next === null ? prefs.detail === null : prefs.detail !== null && prefs.detail.connectionId === next.connectionId && prefs.detail.itemId === next.itemId
    if (!same) setPrefs({ detail: next })
  }, [selectedId, prefs.detail, setPrefs])

  // --- 연결·스페이스 ---
  useEffect(() => {
    let alive = true
    void window.corral.getWorkSettings().then((value) => { if (alive && value !== null) setSettings(value) })
    const off = window.corral.onWorkSettings((value) => setSettings(value))
    return () => { alive = false; off() }
  }, [])
  const groups = useMemo(() => (settings === null ? [] : spaceGroups({ settings, repoRoot: activeRepoRoot })), [settings, activeRepoRoot])

  const send = useCallback(async ({ key, connectionId, call }: { key: string; connectionId: string; call: WorkCall }): Promise<{ accepted: boolean; response: WorkResponse }> => {
    const requestId = gate.issue(key)
    const response = await request({ requestId, connectionId, call })
    return { accepted: response.requestId === requestId && gate.accepts({ key, requestId }), response }
  }, [gate])

  // 스페이스 목록을 아직 못 받은 연결은 열 때 **연결 세대마다 한 번** 받는다(R1-C). 실패는 보존하고 「다시 시도」 까지 다시 보내지 않는다 —
  // 실패도 main 이 상태를 push 하므로, push 마다 다시 보내면 끝없이 돈다.
  useEffect(() => {
    if (!open || settings === null) return
    for (const connection of settings.connections) {
      if (connection.spaces !== null || connection.status === 'testing') continue
      const key = `${connection.id}#${connection.generation}`
      if (spaceFetch.has(key)) continue
      setSpaceFetch((current) => new Map(current).set(key, { state: 'pending' }))
      void send({ key: `spaces:${key}`, connectionId: connection.id, call: { op: 'listSpaces' } }).then(({ response }) => {
        setSpaceFetch((current) => new Map(current).set(key, response.ok ? { state: 'done' } : { state: 'failed', error: response.error }))
      })
    }
  }, [open, settings, spaceFetch, send])
  const spaceErrors = useMemo(() => (settings === null ? [] : settings.connections.flatMap((connection) => {
    const fetched = spaceFetch.get(`${connection.id}#${connection.generation}`)
    return connection.spaces === null && fetched?.state === 'failed' ? [{ connectionId: connection.id, error: fetched.error }] : []
  })), [settings, spaceFetch])
  const failedSpaces = useMemo(() => new Set(spaceErrors.map((entry) => entry.connectionId)), [spaceErrors])

  // 스페이스 선택(C2·R1-D) — 첫 선택은 이 실행에서 한 번, 그 뒤엔 유효성만 본다(재열기에 레포 기본이 사용자 선택을 덮지 않는다).
  const decided = useRef(false)
  useEffect(() => {
    if (!open || !prefsReady || settings === null) return
    if (decided.current) {
      if (space !== null && spaceStillValid({ groups, settings, space, failed: failedSpaces })) return
      const pick = initialSpace({ groups, settings, repoRoot: activeRepoRoot, last: null, failed: failedSpaces })
      if (pick.kind === 'wait' || sameSpace(pick.space, space)) return
      setSpace(pick.space)
      setSelectedId(null)
      if (pick.space !== null) setPrefs({ space: pick.space })
      return
    }
    const pick = initialSpace({ groups, settings, repoRoot: activeRepoRoot, last: prefs.space, failed: failedSpaces })
    if (pick.kind === 'wait') return
    decided.current = true
    setSpace(pick.space)
    // 자동으로 고른 스페이스도 「마지막으로 본 스페이스」 다 — 재시작 뒤 첫 진입 규칙(C2)의 두 번째 갈래가 이 값을 본다.
    if (pick.space !== null && !sameSpace(pick.space, prefs.space)) setPrefs({ space: pick.space })
  }, [open, prefsReady, settings, groups, activeRepoRoot, space, prefs.space, setPrefs, failedSpaces])

  const chooseSpace = useCallback((next: TasksSpace) => {
    decided.current = true
    setSpace(next)
    setSelectedId(null)
    setPrefs({ space: next })
  }, [setPrefs])

  // --- 불러오기 ---
  const targets = useMemo((): { connectionId: string; spaceKey: string; spaceName: string; color: string | null; colorIndex: number }[] => {
    if (space === null || settings === null) return []
    const rows = groups.flatMap((group) => group.rows)
    if (space.kind === 'all') return rows.map((row) => ({ connectionId: row.connectionId, spaceKey: row.key, spaceName: row.name, color: row.color, colorIndex: row.colorIndex }))
    const row = rows.find((entry) => entry.connectionId === space.connectionId && entry.key === space.spaceKey)
    if (row === undefined && !spaceStillValid({ groups, settings, space, failed: failedSpaces })) return []
    return [{ connectionId: space.connectionId, spaceKey: space.spaceKey, spaceName: row?.name ?? space.spaceKey, color: row?.color ?? null, colorIndex: row?.colorIndex ?? 1 }]
  }, [space, groups, settings, failedSpaces])
  // 연결 세대를 넣는다(R2-E) — 같은 스페이스 id 로 토큰(계정)이 바뀌어도 다시 받는다.
  const generationOf = (connectionId: string): number => settings?.connections.find((connection) => connection.id === connectionId)?.generation ?? 0
  /** 지금(응답을 받는 시점) 연결 세대 — await 를 넘어 읽으므로 ref 로(R3-D). */
  const currentGeneration = useCallback((connectionId: string): number => settingsRef.current?.connections.find((connection) => connection.id === connectionId)?.generation ?? 0, [])
  // 세대가 바뀌면 이전 세대의 확인 안 된 쓰기는 잠금을 풀고 버린다 — 새 자료에 다시 적용하지 않는다(R3-D). 그 응답은 move 가 버린다.
  const generationsId = settings === null ? '' : settings.connections.map((connection) => `${connection.id}#${connection.generation}`).join('|')
  useEffect(() => {
    const stale = [...pendingWrites.current].filter(([, entry]) => entry.generation !== currentGeneration(entry.connectionId))
    overrides.current = overrides.current.filter((entry) => entry.generation === currentGeneration(entry.connectionId))
    for (const entry of lagging.current) if (entry.generation !== currentGeneration(entry.connectionId)) lagging.current.delete(entry)
    if (stale.length === 0) return
    for (const [uid] of stale) pendingWrites.current.delete(uid)
    setBusy(new Set(pendingWrites.current.keys()))
  }, [generationsId, currentGeneration])
  const targetsId = targets.map((target) => `${target.connectionId}#${generationOf(target.connectionId)}::${target.spaceKey}`).join('|')

  /** 화면 자료에 변경 하나를 쓰고, 순번을 달아 남긴다(R1-F). */
  const patch = useCallback(({ connectionId, spaceKey, apply }: { connectionId: string; spaceKey: string; apply: (items: WorkItem[]) => WorkItem[] }): Override => {
    writeSeq.current += 1
    const entry: Override = { seq: writeSeq.current, connectionId, generation: currentGeneration(connectionId), spaceKey, apply }
    overrides.current.push(entry)
    setLoad((value) => ({ ...value, data: value.data.map((data) => (data.connectionId === connectionId && data.spaceKey === spaceKey ? { ...data, items: apply(data.items) } : data)) }))
    return entry
  }, [])

  const reload = useCallback(async ({ quiet }: { quiet: boolean }) => {
    if (space === null) { setLoad(EMPTY_LOAD); return }
    const id = spaceId(space)
    gate.invalidate('more')
    const token = gate.issue('load')
    const startSeq = writeSeq.current
    const startSettles = settles.current
    const same = loadRef.current.spaceId === id
    setLoad((current) => (quiet && current.spaceId === id
      ? { ...current, loadingMore: false }
      : { spaceId: id, phase: 'loading', data: current.spaceId === id ? current.data : [], error: null, loadingMore: false }))
    const results = await Promise.all(targets.map(async (target): Promise<SpaceResult> => {
      const at = `${token}/${target.connectionId}/${target.spaceKey}`
      const [statuses, first] = await Promise.all([
        request({ requestId: `${at}/st`, connectionId: target.connectionId, call: { op: 'listStatuses', spaceKey: target.spaceKey } }),
        request({ requestId: `${at}/it`, connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: null } }),
      ])
      if (!statuses.ok) return { ok: false, error: statuses.error }
      if (!first.ok) return { ok: false, error: first.error }
      if (statuses.result.op !== 'listStatuses' || first.result.op !== 'listItems') return { ok: false, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }
      let { items, nextCursor, truncated } = first.result
      let pages = 1
      // 다시 열 때는 더 받아 둔 쪽 수만큼 다시 받는다 — 아래쪽 작업·스크롤이 사라지지 않게(R1-N).
      const wanted = same ? (pagesRef.current.get(`${target.connectionId}::${target.spaceKey}`) ?? 1) : 1
      while (pages < wanted && nextCursor !== null) {
        const next = await request({ requestId: `${at}/it${pages}`, connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: nextCursor } })
        // 덧 쪽 실패는 오류다(R2-F) — 짧은 목록을 성공으로 그리지 않는다. 표시 자료·받아 둔 쪽 수는 그대로 둔다(아래).
        if (!next.ok) return { ok: false, error: next.error }
        if (next.result.op !== 'listItems') return { ok: false, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }
        const known = new Set(items.map((item) => item.id))
        items = [...items, ...next.result.items.filter((item) => !known.has(item.id))]
        nextCursor = next.result.nextCursor
        truncated = next.result.truncated
        pages += 1
      }
      const data: SpaceData = {
        connectionId: target.connectionId, spaceKey: target.spaceKey, spaceName: target.spaceName, color: target.color, colorIndex: target.colorIndex,
        statuses: statuses.result.statuses, kinds: statuses.result.kinds, items, nextCursor, truncated,
      }
      return { ok: true, data, pages }
    }))
    if (!gate.accepts({ key: 'load', requestId: token })) return
    // 요청 뒤에 순서 쓰기가 성공했거나 늦은 답이 왔으면 이 응답은 그 전 값일 수 있다 — 버리고 다시 읽는다(R4-C). 화면은 지금 그대로라 옛 순서로 깜빡이지 않는다.
    if (settles.current !== startSettles) { void reloadRef.current({ quiet }); return }
    // 다시 적용할 변경 = 이 목록 요청 **전에** 시작해 아직 확인 안 된 쓰기(R2-C) + 요청 **뒤에** 화면에 쓴 변경(옮기기·원복·응답 반영, R1-F) — 순번 순.
    const later = overrides.current.filter((entry) => entry.seq > startSeq)
    overrides.current = later
    // 다른 세대의 변경은 새 자료에 다시 적용하지 않는다(R3-D).
    const unsettled = [...pendingWrites.current.values(), ...lagging.current].filter((entry) => entry.seq <= startSeq).sort((a, b) => a.seq - b.seq)
    const replay = [...unsettled, ...later]
      .filter((entry) => entry.generation === currentGeneration(entry.connectionId))
    if (!same) pagesRef.current = new Map()
    const error = results.flatMap((result) => (result.ok ? [] : [result.error]))[0] ?? null
    const shown = loadRef.current.spaceId === id ? loadRef.current.data : []
    const data = results.flatMap((result, index) => {
      if (!result.ok) {
        // 실패한 대상은 지금 보이던 자료를 그대로 둔다(R2-F) — 받아 둔 쪽 수도 그대로.
        const target = targets[index]
        return shown.filter((entry) => entry.connectionId === target?.connectionId && entry.spaceKey === target.spaceKey)
      }
      pagesRef.current.set(`${result.data.connectionId}::${result.data.spaceKey}`, result.pages)
      const items = replay
        .filter((entry) => entry.connectionId === result.data.connectionId && entry.spaceKey === result.data.spaceKey)
        .reduce((current, entry) => entry.apply(current), result.data.items)
      return [{ ...result.data, items }]
    })
    setLoad({ spaceId: id, phase: error === null ? 'ready' : 'error', data, error, loadingMore: false })
  }, [space, targets, gate, currentGeneration])
  reloadRef.current = reload

  // 스페이스가 바뀌면 다시 짓고, 다시 열면 조용히 새로 받는다(지금 그림은 둔 채).
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open || space === null || targets.length === 0) {
      // 대상이 0 이 되면 진행 중 불러오기도 버린다(R2-D) — 늦게 온 응답이 사라진 스페이스의 자료·배너를 되살리지 않게.
      if (open && (space === null || targets.length === 0)) { gate.invalidate('load'); loadedFor.current = null; setLoad(EMPTY_LOAD) }
      return
    }
    const key = `${spaceId(space)}#${targetsId}`
    const quiet = loadedFor.current === key
    loadedFor.current = key
    void reload({ quiet })
  }, [open, space, targetsId])

  const loadMore = useCallback(async () => {
    const current = loadRef.current
    const target = current.data.find((entry) => entry.nextCursor !== null)
    if (target === undefined || target.nextCursor === null || current.loadingMore) return
    const spaceAt = current.spaceId
    setLoad((value) => ({ ...value, loadingMore: true }))
    const { accepted, response } = await send({ key: 'more', connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: target.nextCursor } })
    // 버린 요청(정렬·필터·스페이스가 바뀌었거나 새 요청이 나갔다)은 화면을 건드리지 않는다 — `loadingMore` 는 그 뒤 요청(또는 무효화)이 가진다(R1-M).
    if (!accepted || loadRef.current.spaceId !== spaceAt) return
    if (!response.ok || response.result.op !== 'listItems') {
      const error = response.ok ? null : response.error
      setLoad((value) => ({ ...value, loadingMore: false }))
      if (error !== null) notify({ kind: 'failed', message: `더 불러오지 못했습니다 — ${error.message}` })
      return
    }
    const { items, nextCursor, truncated } = response.result
    const pagesKey = `${target.connectionId}::${target.spaceKey}`
    pagesRef.current.set(pagesKey, (pagesRef.current.get(pagesKey) ?? 1) + 1)
    setLoad((value) => ({
      ...value,
      loadingMore: false,
      data: value.data.map((entry) => (entry.connectionId === target.connectionId && entry.spaceKey === target.spaceKey
        ? { ...entry, items: [...entry.items, ...items.filter((item) => !entry.items.some((known) => known.id === item.id))], nextCursor, truncated }
        : entry)),
    }))
  }, [send, notify])
  /** 정렬·필터가 바뀌면 이어 받던 쪽을 버린다(C9). */
  const invalidateMore = useCallback(() => {
    gate.invalidate('more')
    setLoad((value) => (value.loadingMore ? { ...value, loadingMore: false } : value))
  }, [gate])

  // --- 키 검색 (E2·E3) ---
  // 조회는 「검색어 · 연결(세대) · 키 모양」 이 바뀔 때만(R1-B). settings 객체는 상태 push 마다 새로 오므로 의존하지 않는다.
  const patternsId = settings === null ? '' : settings.connections.map((connection) => `${connection.id}#${connection.generation}#${patternOf({ settings, sourceId: connection.sourceId }) ?? ''}`).join('|')
  /** 「다시 시도」 가 키 조회도 다시 보내게 하는 번호(R2-G). */
  const [searchRound, setSearchRound] = useState(0)
  /** 진행 중인 키 조회 — 그동안 쓰기가 성공하면 그 응답은 쓰기 전 값일 수 있어 다시 보낸다(R4-B). */
  const finding = useRef(false)
  const patterns = useMemo(() => {
    const current = settingsRef.current
    return current === null ? [] : current.connections.map((connection) => ({ connectionId: connection.id, pattern: patternOf({ settings: current, sourceId: connection.sourceId }) }))
  }, [patternsId])
  useEffect(() => {
    if (!open) { gate.invalidate('find'); finding.current = false; return }
    const candidates = patterns.flatMap(({ connectionId, pattern }) => {
      const key = searchKey({ query, pattern })
      return key === null ? [] : [{ connectionId, key }]
    })
    if (candidates.length === 0) { gate.invalidate('find'); finding.current = false; setSearch(NO_SEARCH); return }
    const token = gate.issue('find')
    finding.current = true
    void Promise.all(candidates.map(({ connectionId, key }) =>
      request({ requestId: `${token}/${connectionId}`, connectionId, call: { op: 'findByKey', key } }).then((response) => ({ connectionId, response })),
    )).then((answers) => {
      if (!gate.accepts({ key: 'find', requestId: token })) return
      finding.current = false
      // 조회 오류는 「결과 없음」 이 아니다 — 따로 모아 배너로(R1-K).
      setSearch({
        query,
        hits: answers.flatMap(({ connectionId, response }) => (response.ok && response.result.op === 'findByKey' && response.result.item !== null ? [{ connectionId, item: response.result.item }] : [])),
        errors: answers.flatMap(({ connectionId, response }) => {
          if (!response.ok) return [{ connectionId, error: response.error }]
          return response.result.op === 'findByKey' ? [] : [{ connectionId, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }]
        }),
      })
    })
  }, [open, query, patterns, gate, searchRound])
  const spaceNameOf = useCallback(({ connectionId, spaceKey }: { connectionId: string; spaceKey: string }): string =>
    settings?.connections.find((connection) => connection.id === connectionId)?.spaces?.find((entry) => entry.key === spaceKey)?.name ?? spaceKey, [settings])
  // 지금 검색어의 결과만 보인다 — 새 검색어의 응답이 오기 전에는 옛 키 일치·오류를 보이지 않는다(R3-I).
  const shownSearch = search.query === query ? search : NO_SEARCH
  const hits = useMemo((): SearchHit[] => shownSearch.hits.map((hit) => ({ ...hit, spaceName: spaceNameOf({ connectionId: hit.connectionId, spaceKey: hit.item.spaceKey }) })), [shownSearch, spaceNameOf])

  // --- 작업 중 (C11) ---
  const trees = useMemo((): WorkingTree[] => repos.flatMap((repo) => repo.worktrees.flatMap((worktree) => {
    if (worktree.openWorkspaceId === null || worktree.branch === null) return []
    const tabs = worktree.workspace?.tabs ?? []
    const dots = tabs.flatMap((tab) => tab.panes.filter((pane) => pane.agent !== null).map((pane) => paneDot({ pane, unread: false })))
    const status = tabStatus(dots)
    return [{
      path: worktree.path,
      repoRoot: repo.root,
      repoName: repo.name,
      branch: worktree.branch,
      dot: status?.dot ?? (dots.length > 0 ? 'idle' : null),
      activityAt: latestActivity(tabs.flatMap((tab) => tab.panes.map((pane) => pane.digest.lastActivityAt))),
    }]
  })), [repos])
  const workingEntries = useMemo(() => detectWorking({ trees, patterns }), [trees, patterns])
  const workingIds = workingEntries.map((entry) => `${entry.connectionId}#${generationOf(entry.connectionId)}::${entry.key}`).join('|')
  /** 작업 중 조회를 전부 다시 받게 하는 번호 — 완료 분류를 넘나든 쓰기 뒤(종속 작업의 막힘이 바뀐다, R3-C). */
  const [workingRound, setWorkingRound] = useState(0)
  useEffect(() => {
    if (!open) return
    for (const entry of workingEntries) {
      const id = `${entry.connectionId}::${entry.key}`
      setWorking((current) => (current.has(id) ? current : new Map(current).set(id, { state: 'loading' })))
      void send({ key: `working:${id}`, connectionId: entry.connectionId, call: { op: 'findByKey', key: entry.key } }).then(({ accepted, response }) => {
        if (!accepted) return
        const lookup: StoredLookup = !response.ok
          ? { state: 'error', message: response.error.message }
          : response.result.op !== 'findByKey' ? { state: 'error', message: '출처 응답 모양이 다릅니다.' }
            : response.result.item === null ? { state: 'missing' } : { state: 'found', item: response.result.item }
        setWorking((current) => new Map(current).set(id, lookup))
      })
    }
  }, [open, workingIds, workingRound])
  const workingLookups = useMemo(() => {
    const map = new Map<string, WorkingLookup>()
    for (const [id, lookup] of working) {
      map.set(id, lookup.state === 'found' ? { state: 'found', item: lookup.item, spaceName: spaceNameOf({ connectionId: id.slice(0, id.indexOf('::')), spaceKey: lookup.item.spaceKey }) } : lookup)
    }
    return map
  }, [working, spaceNameOf])
  const workingKeys = useMemo(() => new Set(workingEntries.map((entry) => entry.key)), [workingEntries])

  // --- 쓰기 (C7) ---
  /** 성공한 쓰기를 작업 중 보기·키 조회 결과에도 쓴다(R2-I) — 같은 열림 동안 옛 상태가 남지 않게. */
  // 쓰기 직후엔 그 키의 진행 중 작업 중 조회 응답을 버린다(R3-B) — 쓰기 전에 잡은 옛 값이 늦게 와서 덮지 않게. 찾는 중·없음이던 항목도 서버 값으로.
  // 키 조회도 같다(R4-B) — 진행 중이면 그 응답을 버리고 다시 보낸다.
  const reflect = useCallback(({ connectionId, item }: { connectionId: string; item: WorkItem }) => {
    const id = `${connectionId}::${item.key}`
    gate.invalidate(`working:${id}`)
    if (finding.current) setSearchRound((value) => value + 1)
    setWorking((current) => {
      let changed = false
      const next = new Map(current)
      for (const [known, lookup] of current) {
        const same = known === id || (lookup.state === 'found' && lookup.item.id === item.id && known.startsWith(`${connectionId}::`))
        if (!same) continue
        next.set(known, { state: 'found', item: lookup.state === 'found' ? { ...lookup.item, ...item } : item })
        changed = true
      }
      return changed ? next : current
    })
    setSearch((current) => (current.hits.some((hit) => hit.connectionId === connectionId && hit.item.id === item.id)
      ? { ...current, hits: current.hits.map((hit) => (hit.connectionId === connectionId && hit.item.id === item.id ? { connectionId, item: { ...hit.item, ...item } } : hit)) }
      : current))
  }, [gate])

  const move = useCallback(async ({ row, intent, undo, restore }: MoveRequest & { undo: boolean; restore: WorkResolutionChoice | null }): Promise<void> => {
    const call = callOf({ item: row.item, intent, restore })
    if (call === null) return
    const { connectionId, spaceKey, statuses } = row.space
    const uid = rowUid(row)
    // 확인 안 된 쓰기가 있는 카드는 잠근다(R2-A) — 끌기 손잡이도 잠겨 있지만 되돌리기 버튼은 여기서 막는다.
    if (pendingWrites.current.has(uid)) {
      notify({ kind: 'failed', message: `${row.item.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 하세요.` })
      return
    }
    // 상세가 그 작업을 다시 받는 중이면 보내지 않는다(R6-D) — 기다렸다 보내는 길은 없다.
    if (detailReads.current.has(uid)) {
      notify({ kind: 'failed', message: `${row.item.key} — ${DETAIL_READING}입니다. 받은 뒤 다시 하세요.` })
      return
    }
    const before = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)?.items ?? [row.item]
    // 잠금 덕에 이 카드의 지금 값은 출처가 마지막으로 인정한 값이다(또는 마지막 재조회 값) — 되돌리기·원복은 이 값으로.
    const original = before.find((item) => item.id === row.item.id) ?? row.item
    const reverse = inverseOf({ item: original, intent, items: before })
    const apply = (items: WorkItem[]): WorkItem[] => applyIntent({ items, itemId: row.item.id, intent, statuses })
    const written = patch({ connectionId, spaceKey, apply })
    pendingWrites.current.set(uid, written)
    if (intent.kind === 'reorder') reorders.current.add(written)
    setBusy(new Set(pendingWrites.current.keys()))
    setStartedWrite({ uid, seq: written.seq })
    const requestId = gate.issue(`item:${uid}`)
    let asked: Asked | null = null
    try {
      asked = await ask({ requestId, connectionId, call })
    } finally {
      // 잠금은 어떤 경로로 끝나도 푼다(R3-E) — 단 세대가 바뀌어 이미 지운 뒤 같은 카드의 새 쓰기가 잡았으면 그 잠금은 둔다.
      if (pendingWrites.current.get(uid) === written) pendingWrites.current.delete(uid)
      setBusy(new Set(pendingWrites.current.keys()))
    }
    // 세대가 바뀐 뒤 온 응답은 버린다(R3-D) — 새 자료에 반영하지도 원복하지도 않는다.
    if (written.generation !== currentGeneration(connectionId)) return
    if (asked.kind === 'late') {
      // 늦음은 실패가 아니다(R4-A) — 원복·실패 토스트 없이 「확인 지연」 만 알리고 낙관적 값을 둔다. 답이 오면(성공·실패 무관) 서버를 다시 읽어 맞춘다.
      lagging.current.add(written)
      notify({ kind: 'delayed', message: `${original.key} — 출처 확인이 늦어지고 있습니다. 답이 오면 서버 값으로 맞춥니다.` })
      void asked.answer.then((late) => {
        lagging.current.delete(written)
        if (written.generation !== currentGeneration(connectionId)) return
        // 늦게 온 실패는 알린다 — 화면은 아래 재조회가 서버 값으로 되돌린다(원복을 따로 쓰지 않는다).
        if (!late.ok) notify({ kind: 'failed', message: `${original.key} — ${late.error.message}` })
        settles.current += 1
        void reloadRef.current({ quiet: true })
        setWorkingRound((value) => value + 1)
        setSearchRound((value) => value + 1)
      })
      return
    }
    const { response } = asked
    const accepted = response.requestId === requestId && gate.accepts({ key: `item:${uid}`, requestId })
    const settled = response.ok && (response.result.op === 'changeStatus' || response.result.op === 'setPlacement' || response.result.op === 'reorder') ? response.result.item : null
    if (!accepted || settled === null) {
      // 실패·버린 응답·모양이 다른 응답 = 그 카드 하나만 옮기기 전 자리로(순서는 그 카드만 되돌린다, R2-B), 그리고 서버를 다시 읽어 수렴한다.
      patch({ connectionId, spaceKey, apply: (items) => applyIntent({ items, itemId: row.item.id, intent: reverse, statuses }) })
      notify({ kind: 'failed', message: `${original.key} — ${response.ok ? '출처 응답을 확인하지 못했습니다.' : response.error.message}` })
      void reloadRef.current({ quiet: true })
      return
    }
    if (intent.kind === 'reorder') {
      // 순서는 성공 응답에서 의도를 다시 적용하지 않는다(R3-A) — 다른 카드의 순서 쓰기와 응답이 엇갈리면 서버와 다른 순서가 남는다.
      // 같은 스페이스의 순서 쓰기가 다 끝나면 서버에서 다시 읽어 확정 순서로 맞춘다. 그때까지 화면은 낙관적 순서 그대로다.
      // 다시 적용할 기록을 남기지 않으므로, 이미 나간 목록 요청은 이 성공 전 순서일 수 있다 — 그 응답은 버리고 다시 읽는다(R4-C).
      settles.current += 1
      const reordering = [...pendingWrites.current.values()].some((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey && reorders.current.has(entry))
      if (!reordering) void reloadRef.current({ quiet: true })
    } else {
      patch({ connectionId, spaceKey, apply: setFields({ item: settled }) })
    }
    reflect({ connectionId, item: settled })
    settledSeq.current += 1
    setSettledWrite({ uid, item: settled, seq: settledSeq.current })
    // 완료 분류를 넘나들면 이 작업이 막던 작업의 막힘 자료가 바뀐다 — 목록·작업 중·키 조회를 서버에서 다시 읽는다(R2-J·R3-C).
    if (crossesDone({ from: original, to: settled })) {
      void reloadRef.current({ quiet: true })
      setWorkingRound((value) => value + 1)
      setSearchRound((value) => value + 1)
    }
    if (undo) { notify({ kind: 'undone', label: `${original.key} 를 되돌렸습니다` }); return }
    // 원래 완료 갈래를 다시 쓸 수 없으면 되돌리기를 내지 않는다 — 완료함으로 바꿔 끼우지 않는다(R1-G).
    const restorable = intent.kind === 'status' ? restorableResolution(original) : null
    if (restorable !== null && !restorable.restorable) {
      notify({ kind: 'final', label: `${describe({ item: original, intent, statuses })} · ${UNRESTORABLE_RESOLUTION}` })
      return
    }
    const back = restorable !== null && restorable.restorable ? restorable.resolution : null
    notify({
      kind: 'moved',
      label: describe({ item: original, intent, statuses }),
      // 되돌리기는 옮긴 맥락(연결·스페이스·작업·이전 값)을 들고 간다 — 다른 스페이스로 옮겨 가도 역요청을 보낸다(R1-E).
      // 보내는 값 = 이 쓰기 직전 출처가 인정한 값(`reverse`) — 거절된 낙관적 값이 끼어들 수 없다(R2-A).
      // 이 카드에 확인 안 된 쓰기가 있으면 받지 않는다 — 버튼은 남아 잠금이 풀린 뒤 다시 누를 수 있다(R4-E).
      undo: () => {
        if (pendingWrites.current.has(uid)) {
          notify({ kind: 'failed', message: `${original.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 되돌리세요.` })
          return false
        }
        if (detailReads.current.has(uid)) {
          notify({ kind: 'failed', message: `${original.key} — ${DETAIL_READING}입니다. 받은 뒤 다시 되돌리세요.` })
          return false
        }
        const now = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)
        const at = now ?? row.space
        const item = now?.items.find((entry) => entry.id === original.id) ?? settled
        void move({ row: { item, space: at, status: at.statuses.find((status) => status.key === item.statusKey) ?? null }, intent: reverse, undo: true, restore: back })
        return true
      },
    })
  }, [patch, gate, notify, reflect, currentGeneration])

  /** 상세 단건 읽기 하나를 그 카드의 진행 중 읽기로 센다 — 돌려준 함수로 뺀다(두 번 불러도 한 번만). */
  const holdRead = useCallback((uid: string): (() => void) => {
    detailReads.current.set(uid, (detailReads.current.get(uid) ?? 0) + 1)
    setReading(new Set(detailReads.current.keys()))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = (detailReads.current.get(uid) ?? 1) - 1
      if (next <= 0) detailReads.current.delete(uid)
      else detailReads.current.set(uid, next)
      setReading(new Set(detailReads.current.keys()))
    }
  }, [])

  /**
   * 상세 쓰기(LIFE-602 D3) — 끌기와 같은 잠금·세대·확인 지연. 잠겨 있으면 보내지 않고 `busy`. 실패하면 그 작업만 쓰기 전 목록 값으로 돌리고
   * 서버를 다시 읽는다. 결과 처리(충돌 배너·되돌리기 토스트)는 부르는 쪽(상세)이 한다.
   */
  const writeItem = useCallback(async ({ connectionId, spaceKey, itemId, call, optimistic }: ItemWrite): Promise<ItemWriteOutcome> => {
    const uid = itemUid({ connectionId, itemId })
    if (pendingWrites.current.has(uid)) return { kind: 'busy' }
    const listed = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)?.items.find((item) => item.id === itemId) ?? null
    let written: Override
    if (optimistic !== null && listed !== null) {
      written = patch({ connectionId, spaceKey, apply: (items) => items.map((item) => (item.id === itemId ? optimistic(item) : item)) })
    } else {
      // 목록에 없는 작업(다른 스페이스·검색 결과)도 같은 잠금을 잡는다 — 다시 적용할 변경은 없다.
      writeSeq.current += 1
      written = { seq: writeSeq.current, connectionId, generation: currentGeneration(connectionId), spaceKey, apply: (items) => items }
    }
    pendingWrites.current.set(uid, written)
    setBusy(new Set(pendingWrites.current.keys()))
    const requestId = gate.issue(`item:${uid}`)
    let asked: Asked | null = null
    try {
      asked = await ask({ requestId, connectionId, call })
    } finally {
      if (pendingWrites.current.get(uid) === written) pendingWrites.current.delete(uid)
      setBusy(new Set(pendingWrites.current.keys()))
    }
    const revert = (): void => {
      if (listed !== null && optimistic !== null) patch({ connectionId, spaceKey, apply: (items) => items.map((item) => (item.id === itemId ? listed : item)) })
    }
    if (written.generation !== currentGeneration(connectionId)) return { kind: 'stale' }
    if (asked.kind === 'late') {
      lagging.current.add(written)
      notify({ kind: 'delayed', message: `${listed?.key ?? '작업'} — 출처 확인이 늦어지고 있습니다. 답이 오면 서버 값으로 맞춥니다.` })
      const settledLate = asked.answer.then((late): LateSettled => {
        lagging.current.delete(written)
        if (written.generation !== currentGeneration(connectionId)) return { kind: 'stale' }
        if (!late.ok) notify({ kind: 'failed', message: `${listed?.key ?? '작업'} — ${late.error.message}` })
        settles.current += 1
        void reloadRef.current({ quiet: true })
        setWorkingRound((value) => value + 1)
        setSearchRound((value) => value + 1)
        if (!late.ok) return { kind: 'failed', error: late.error }
        // 늦게 성공한 쓰기도 열린 상세가 서버 값을 받는다(R1-C).
        const item = 'item' in late.result && late.result.item !== null && late.result.item.id === itemId ? late.result.item : null
        if (item !== null) {
          settledSeq.current += 1
          setSettledWrite({ uid, item, seq: settledSeq.current })
        }
        return { kind: 'ok', result: late.result }
      })
      return { kind: 'late', settled: settledLate }
    }
    const { response } = asked
    if (response.requestId !== requestId || !gate.accepts({ key: `item:${uid}`, requestId })) {
      revert()
      void reloadRef.current({ quiet: true })
      return { kind: 'stale' }
    }
    if (!response.ok) {
      revert()
      void reloadRef.current({ quiet: true })
      return { kind: 'failed', error: response.error }
    }
    const { result } = response
    const settled = 'item' in result && result.item !== null && result.item.id === itemId ? result.item : null
    if (settled !== null) {
      patch({ connectionId, spaceKey, apply: replaceItem({ item: settled }) })
      reflect({ connectionId, item: settled })
      settledSeq.current += 1
      setSettledWrite({ uid, item: settled, seq: settledSeq.current })
      if (listed !== null && crossesDone({ from: listed, to: settled })) {
        void reloadRef.current({ quiet: true })
        setWorkingRound((value) => value + 1)
        setSearchRound((value) => value + 1)
      }
    } else {
      // 연결·자식 — 다른 작업의 막힘 배지·새 카드가 생긴다. 서버에서 다시 읽는다.
      void reloadRef.current({ quiet: true })
    }
    return { kind: 'ok', result }
  }, [patch, gate, notify, reflect, currentGeneration])

  /** 끄기 시작 — 허용 전이만인 출처면 그 작업의 허용 전이를 받는다. 받기 전·실패면 칸은 흐림(fail-closed). */
  const beginDrag = useCallback(async (row: TasksRow, mode: 'any' | 'allowed') => {
    if (mode === 'any') { setTransitions(null); return }
    const uid = rowUid(row)
    setTransitions({ uid, state: 'loading' })
    const { accepted, response } = await send({ key: 'transitions', connectionId: row.space.connectionId, call: { op: 'listTransitions', itemId: row.item.id } })
    if (!accepted) return
    if (!response.ok) { setTransitions({ uid, state: 'error', message: response.error.message }); return }
    setTransitions(response.result.op === 'listTransitions' ? { uid, state: 'ready', keys: response.result.statusKeys } : { uid, state: 'error', message: '출처 응답 모양이 다릅니다.' })
  }, [send])
  const endDrag = useCallback(() => {
    gate.invalidate('transitions')
    setTransitions(null)
  }, [gate])

  /** 배너의 「다시 시도」 — 실패한 스페이스 목록 조회를 풀고(다시 보낸다) 자료·키 조회·작업 중 조회를 다시 받는다(R2-G·R4-D). */
  const retry = useCallback(() => {
    setSpaceFetch((current) => new Map([...current].filter(([, value]) => value.state !== 'failed')))
    setSearchRound((current) => current + 1)
    setWorkingRound((current) => current + 1)
    void reload({ quiet: false })
  }, [reload])

  const rows = useMemo(() => rowsOf(load.spaceId === (space === null ? null : spaceId(space)) ? load.data : []), [load, space])

  // 배너(C5) — 불러오기 오류 → 보이는 연결의 상태 오류 → 스페이스 목록 조회 실패(「전체」 포함) → 키 조회 오류 순.
  const scope = settings === null ? [] : settings.connections.filter((connection) => space === null || space.kind === 'all' || connection.id === space.connectionId)
  const broken = scope.find((connection) => connection.status === 'auth' || connection.status === 'forbidden' || connection.status === 'offline')
  const spaceError = spaceErrors.find((entry) => scope.some((connection) => connection.id === entry.connectionId))
  const keyError = shownSearch.errors[0]
  const banner: TasksBanner | null = load.error !== null
    ? bannerOf(load.error)
    : broken !== undefined && (broken.status === 'auth' || broken.status === 'forbidden' || broken.status === 'offline')
      ? { kind: broken.status, message: broken.error?.message ?? '' }
      : spaceError !== undefined
        ? { ...bannerOf(spaceError.error), message: `스페이스 목록 — ${spaceError.error.message}` }
        : keyError !== undefined ? { ...bannerOf(keyError.error), message: `키 조회 — ${keyError.error.message}` } : null
  const connectionStatus = space?.kind === 'space' ? settings?.connections.find((connection) => connection.id === space.connectionId)?.status ?? null : null
  /** 스페이스를 고르는 중(연결은 있는데 목록을 받는 중이라 아직 못 고름). */
  const choosing = settings !== null && settings.connections.length > 0 && space === null && spaceErrors.length === 0

  return {
    prefs, setPrefs, prefsReady,
    settings, groups, space, chooseSpace, choosing,
    query, setQuery, selectedId, setSelectedId,
    load, rows, banner, connectionStatus,
    reload, retry, loadMore, invalidateMore,
    hits, workingEntries, working: workingLookups, workingKeys, trees,
    move: (request: MoveRequest) => move({ ...request, undo: false, restore: null }),
    writeItem, settledWrite, startedWrite, holdRead,
    /** 확인 안 된 쓰기가 있는 카드(uid) — 끌기 잠금·「확인하는 중」 표시(R2-A). */
    busy,
    /** 상세 단건 읽기가 진행 중인 카드(uid) — 끌기 잠금(R6-D). */
    reading,
    beginDrag, endDrag, transitions,
  }
}

export type TasksPageModel = ReturnType<typeof useTasksPage>
