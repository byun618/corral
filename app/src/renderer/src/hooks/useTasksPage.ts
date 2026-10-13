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
// - 출처 요청은 `request` 하나로 — preload Promise 가 reject 되거나 30초 안에 답이 없으면 `network` 실패 응답으로 바꾼다(R3-E).
//   잠금 해제·원복·오류 토스트가 언제나 지난다.
// - 스페이스 목록 조회(연결별 · 세대별)는 시도·실패를 보존한다 — 실패하면 「다시 시도」 까지 다시 보내지 않는다(R1-C).
// - 스페이스 선택(R1-D): 첫 선택(이 실행에서 처음 열 때 — 레포 기본 → 마지막 → 첫 스페이스, 목록을 받는 중이면 기다림) · 재열기는 그대로 ·
//   설정이 바뀌어 고른 스페이스가 없어지면(숨김·연결 제거) 다시 고른다.
// - 키 검색은 검색어·연결 세대·키 모양이 바뀔 때만 조회한다 — 상태 push(새 settings 객체)는 조회를 다시 부르지 않는다. 닫힌 동안은 조회하지 않는다(R1-B).
// - 영속(C3): 스페이스·보기·필터·정렬·그룹·밀도·프리셋 기본 → ui-prefs `tasksPage`. 검색어·스크롤은 페이지가 마운트를 유지해 같은 실행 안에서 남고,
//   다시 열 때의 조용한 새로고침은 **더 받아 둔 쪽 수만큼** 다시 받는다(R1-N).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkCall, WorkError, WorkItem, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import {
  DEFAULT_TASKS_PREFS,
  LatestGate,
  applyIntent,
  compareRank,
  detectWorking,
  initialSpace,
  latestActivity,
  readTasksPrefs,
  rowUid,
  rowsOf,
  sameSpace,
  searchKey,
  spaceGroups,
  spaceId,
  spaceStillValid,
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
export type MoveNotice = { kind: 'moved'; label: string; undo: () => void } | { kind: 'undone'; label: string } | { kind: 'failed'; message: string }

type SpaceResult = { ok: true; data: SpaceData; pages: number } | { ok: false; error: WorkError }
type SpaceFetch = { state: 'pending' } | { state: 'done' } | { state: 'failed'; error: WorkError }
/** 키 조회 결과 — 그 결과를 낸 검색어에 귀속한다. 검색어가 바뀌면 새 응답 전까지 옛 결과를 보이지 않는다(R3-I). */
type KeySearch = { query: string; hits: { connectionId: string; item: WorkItem }[]; errors: { connectionId: string; error: WorkError }[] }
/** 화면에 쓴 변경 하나 — 그보다 먼저 시작한 목록 응답에 다시 적용한다(R1-F). 확인 안 된 쓰기도 이 모양으로 남긴다(R2-C). */
type Override = { seq: number; connectionId: string; generation: number; spaceKey: string; apply: (items: WorkItem[]) => WorkItem[] }

const EMPTY_LOAD: TasksLoad = { spaceId: null, phase: 'idle', data: [], error: null, loadingMore: false }
const NO_SEARCH: KeySearch = { query: '', hits: [], errors: [] }

/**
 * 렌더러 쪽 요청 시간 제한 — main 의 출처 요청 시간 제한(MCP 15초, `mcp-http.ts`)보다 길게 잡아, 정상 시간 초과는 main 의 실패 응답으로 오고
 * 이 값은 IPC 자체가 답하지 않는 경우만 잡는다(R3-E).
 */
const REQUEST_TIMEOUT_MS = 30_000

/** 출처 요청 하나 — reject·무응답도 `ok:false` 응답으로(R3-E). 잠금·원복 경로가 예외로 건너뛰어지지 않는다. */
async function request({ requestId, connectionId, call }: { requestId: string; connectionId: string; call: WorkCall }): Promise<WorkResponse> {
  const failed = (message: string): WorkResponse => ({ requestId, connectionId, ok: false, error: { kind: 'network', message, status: null } })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<WorkResponse>((resolve) => { timer = setTimeout(() => resolve(failed('응답이 없습니다 — 시간이 지났습니다.')), REQUEST_TIMEOUT_MS) })
  try {
    return await Promise.race([window.corral.workRequest({ requestId, connectionId, call }), timeout])
  } catch (error) {
    return failed(`요청이 끊겼습니다 — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
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
function callOf({ item, intent }: { item: WorkItem; intent: DragIntent }): WorkCall | null {
  switch (intent.kind) {
    case 'status': return { op: 'changeStatus', itemId: item.id, statusKey: intent.statusKey, ifVersion: null }
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
  /** 쓰기 실패·완료 분류 변경 뒤 서버 재조회 — `reload` 는 아래에서 정의된다. */
  const reloadRef = useRef<(options: { quiet: boolean }) => Promise<void>>(async () => {})
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
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
    // 다시 적용할 변경 = 이 목록 요청 **전에** 시작해 아직 확인 안 된 쓰기(R2-C) + 요청 **뒤에** 화면에 쓴 변경(옮기기·원복·응답 반영, R1-F) — 순번 순.
    const later = overrides.current.filter((entry) => entry.seq > startSeq)
    overrides.current = later
    // 다른 세대의 변경은 새 자료에 다시 적용하지 않는다(R3-D).
    const replay = [...[...pendingWrites.current.values()].filter((entry) => entry.seq <= startSeq), ...later]
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
  const patterns = useMemo(() => {
    const current = settingsRef.current
    return current === null ? [] : current.connections.map((connection) => ({ connectionId: connection.id, pattern: patternOf({ settings: current, sourceId: connection.sourceId }) }))
  }, [patternsId])
  useEffect(() => {
    if (!open) { gate.invalidate('find'); return }
    const candidates = patterns.flatMap(({ connectionId, pattern }) => {
      const key = searchKey({ query, pattern })
      return key === null ? [] : [{ connectionId, key }]
    })
    if (candidates.length === 0) { gate.invalidate('find'); setSearch(NO_SEARCH); return }
    const token = gate.issue('find')
    void Promise.all(candidates.map(({ connectionId, key }) =>
      request({ requestId: `${token}/${connectionId}`, connectionId, call: { op: 'findByKey', key } }).then((response) => ({ connectionId, response })),
    )).then((answers) => {
      if (!gate.accepts({ key: 'find', requestId: token })) return
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
  const reflect = useCallback(({ connectionId, item }: { connectionId: string; item: WorkItem }) => {
    const id = `${connectionId}::${item.key}`
    gate.invalidate(`working:${id}`)
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

  const move = useCallback(async ({ row, intent, undo }: MoveRequest & { undo: boolean }): Promise<void> => {
    const call = callOf({ item: row.item, intent })
    if (call === null) return
    const { connectionId, spaceKey, statuses } = row.space
    const uid = rowUid(row)
    // 확인 안 된 쓰기가 있는 카드는 잠근다(R2-A) — 끌기 손잡이도 잠겨 있지만 되돌리기 버튼은 여기서 막는다.
    if (pendingWrites.current.has(uid)) {
      notify({ kind: 'failed', message: `${row.item.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 하세요.` })
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
    let outcome: { accepted: boolean; response: WorkResponse } | null = null
    try {
      outcome = await send({ key: `item:${uid}`, connectionId, call })
    } finally {
      // 잠금은 어떤 경로로 끝나도 푼다(R3-E) — 단 세대가 바뀌어 이미 지운 뒤 같은 카드의 새 쓰기가 잡았으면 그 잠금은 둔다.
      if (pendingWrites.current.get(uid) === written) pendingWrites.current.delete(uid)
      setBusy(new Set(pendingWrites.current.keys()))
    }
    // 세대가 바뀐 뒤 온 응답은 버린다(R3-D) — 새 자료에 반영하지도 원복하지도 않는다.
    if (written.generation !== currentGeneration(connectionId)) return
    const { accepted, response } = outcome
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
      const reordering = [...pendingWrites.current.values()].some((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey && reorders.current.has(entry))
      if (!reordering) void reloadRef.current({ quiet: true })
    } else {
      patch({ connectionId, spaceKey, apply: setFields({ item: settled }) })
    }
    reflect({ connectionId, item: settled })
    // 완료 분류를 넘나들면 이 작업이 막던 작업의 막힘 자료가 바뀐다 — 목록·작업 중·키 조회를 서버에서 다시 읽는다(R2-J·R3-C).
    if (crossesDone({ from: original, to: settled })) {
      void reloadRef.current({ quiet: true })
      setWorkingRound((value) => value + 1)
      setSearchRound((value) => value + 1)
    }
    if (undo) { notify({ kind: 'undone', label: `${original.key} 를 되돌렸습니다` }); return }
    notify({
      kind: 'moved',
      label: describe({ item: original, intent, statuses }),
      // 되돌리기는 옮긴 맥락(연결·스페이스·작업·이전 값)을 들고 간다 — 다른 스페이스로 옮겨 가도 역요청을 보낸다(R1-E).
      // 보내는 값 = 이 쓰기 직전 출처가 인정한 값(`reverse`) — 거절된 낙관적 값이 끼어들 수 없다(R2-A).
      undo: () => {
        const now = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)
        const at = now ?? row.space
        const item = now?.items.find((entry) => entry.id === original.id) ?? settled
        void move({ row: { item, space: at, status: at.statuses.find((status) => status.key === item.statusKey) ?? null }, intent: reverse, undo: true })
      },
    })
  }, [patch, send, notify, reflect, currentGeneration])

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

  /** 배너의 「다시 시도」 — 실패한 스페이스 목록 조회를 풀고(다시 보낸다) 자료와 키 조회를 다시 받는다(R2-G). */
  const retry = useCallback(() => {
    setSpaceFetch((current) => new Map([...current].filter(([, value]) => value.state !== 'failed')))
    setSearchRound((current) => current + 1)
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
    move: (request: MoveRequest) => move({ ...request, undo: false }),
    /** 확인 안 된 쓰기가 있는 카드(uid) — 끌기 잠금·「확인하는 중」 표시(R2-A). */
    busy,
    beginDrag, endDrag, transitions,
  }
}

export type TasksPageModel = ReturnType<typeof useTasksPage>
