// 작업 페이지 상태·자료 (LIFE-601) — 화면(TasksPage)은 그리기만, 여기서 출처 요청·영속·낙관적 반영을 한다.
//
// - 요청은 `window.corral.workRequest` 하나(T1 계약). 요청 id 는 `LatestGate` 가 매기고, 같은 열쇠의 마지막 요청 응답만 받는다(C7 늦은 응답 폐기):
//   `load`(스페이스 자료) · `more`(다음 쪽) · `find`(키 검색) · `item:<연결>:<id>`(작업 하나의 쓰기) · `transitions`(끄는 작업의 허용 전이).
// - 끌기 = 즉시 반영 → 요청 → 성공이면 되돌리기 토스트(6초) / 실패면 원래 자리 + 오류 토스트. 같은 작업에 뒤 요청이 나갔으면 앞 응답은 화면을 건드리지 않는다.
// - 영속(C3): 스페이스·보기·필터·정렬·그룹·밀도·프리셋 기본 → ui-prefs `tasksPage`. 검색어·스크롤은 페이지가 마운트를 유지해 같은 실행 안에서 남는다.

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
  readTasksPrefs,
  rowsOf,
  sameSpace,
  searchKey,
  spaceGroups,
  spaceId,
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

export type MoveRequest = { row: TasksRow; intent: DragIntent }
export type MoveNotice = { kind: 'moved'; label: string; undo: () => void } | { kind: 'undone'; label: string } | { kind: 'failed'; message: string }

type SpaceResult = { ok: true; data: SpaceData } | { ok: false; error: WorkError }

const EMPTY_LOAD: TasksLoad = { spaceId: null, phase: 'idle', data: [], error: null, loadingMore: false }

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
  const [space, setSpace] = useState<TasksSpace | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [load, setLoad] = useState<TasksLoad>(EMPTY_LOAD)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [working, setWorking] = useState<Map<string, WorkingLookup>>(new Map())
  const [transitions, setTransitions] = useState<{ itemId: string; keys: string[] | null } | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load

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
    const response = await window.corral.workRequest({ requestId, connectionId, call })
    return { accepted: response.requestId === requestId && gate.accepts({ key, requestId }), response }
  }, [gate])

  // 스페이스 목록을 이번 실행에서 아직 못 받은 연결은 열 때 한 번 받는다(능력 표도 같이 선다).
  useEffect(() => {
    if (!open || settings === null) return
    for (const connection of settings.connections) {
      if (connection.spaces !== null || connection.status === 'testing') continue
      void send({ key: `spaces:${connection.id}`, connectionId: connection.id, call: { op: 'listSpaces' } })
    }
  }, [open, settings, send])

  // 첫 진입 스페이스(C2) — 열 때마다 활성 worktree 레포의 기본 스페이스를 먼저 본다.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!open) { wasOpen.current = false; return }
    if (!prefsReady || settings === null) return
    if (wasOpen.current && space !== null) return
    wasOpen.current = true
    const next = initialSpace({ groups, settings, repoRoot: activeRepoRoot, last: space ?? prefs.space })
    if (!sameSpace(next, space)) setSpace(next)
  }, [open, prefsReady, settings, groups, activeRepoRoot, space, prefs.space])

  const chooseSpace = useCallback((next: TasksSpace) => {
    setSpace(next)
    setSelectedId(null)
    setPrefs({ space: next })
  }, [setPrefs])

  // --- 불러오기 ---
  const targets = useMemo((): { connectionId: string; spaceKey: string; spaceName: string; color: string | null; colorIndex: number }[] => {
    if (space === null) return []
    const rows = groups.flatMap((group) => group.rows)
    if (space.kind === 'all') return rows.map((row) => ({ connectionId: row.connectionId, spaceKey: row.key, spaceName: row.name, color: row.color, colorIndex: row.colorIndex }))
    const row = rows.find((entry) => entry.connectionId === space.connectionId && entry.key === space.spaceKey)
    return [{ connectionId: space.connectionId, spaceKey: space.spaceKey, spaceName: row?.name ?? space.spaceKey, color: row?.color ?? null, colorIndex: row?.colorIndex ?? 1 }]
  }, [space, groups])
  const targetsId = targets.map((target) => `${target.connectionId}::${target.spaceKey}`).join('|')

  const reload = useCallback(async ({ quiet }: { quiet: boolean }) => {
    if (space === null) { setLoad(EMPTY_LOAD); return }
    const id = spaceId(space)
    gate.invalidate('more')
    const token = gate.issue('load')
    setLoad((current) => (quiet && current.spaceId === id ? current : { spaceId: id, phase: 'loading', data: current.spaceId === id ? current.data : [], error: null, loadingMore: false }))
    const results = await Promise.all(targets.map(async (target): Promise<SpaceResult> => {
      const [statuses, items] = await Promise.all([
        window.corral.workRequest({ requestId: `${token}/st/${target.spaceKey}`, connectionId: target.connectionId, call: { op: 'listStatuses', spaceKey: target.spaceKey } }),
        window.corral.workRequest({ requestId: `${token}/it/${target.spaceKey}`, connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: null } }),
      ])
      if (!statuses.ok) return { ok: false, error: statuses.error }
      if (!items.ok) return { ok: false, error: items.error }
      if (statuses.result.op !== 'listStatuses' || items.result.op !== 'listItems') return { ok: false, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }
      const data: SpaceData = {
        connectionId: target.connectionId, spaceKey: target.spaceKey, spaceName: target.spaceName, color: target.color, colorIndex: target.colorIndex,
        statuses: statuses.result.statuses, kinds: statuses.result.kinds, items: items.result.items, nextCursor: items.result.nextCursor, truncated: items.result.truncated,
      }
      return { ok: true, data }
    }))
    if (!gate.accepts({ key: 'load', requestId: token })) return
    const error = results.flatMap((result) => (result.ok ? [] : [result.error]))[0] ?? null
    const data = results.flatMap((result) => (result.ok ? [result.data] : []))
    setLoad({ spaceId: id, phase: error === null ? 'ready' : 'error', data, error, loadingMore: false })
  }, [space, targets, gate])

  // 스페이스가 바뀌면 다시 짓고, 다시 열면 조용히 새로 받는다(지금 그림은 둔 채).
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open || space === null || targets.length === 0) {
      if (open && space === null) setLoad(EMPTY_LOAD)
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
    // 이어 받는 중 스페이스·정렬·필터가 바뀌었으면(무효화) 늦게 온 쪽을 붙이지 않는다(C9).
    if (!accepted || loadRef.current.spaceId !== spaceAt) { setLoad((value) => ({ ...value, loadingMore: false })); return }
    if (!response.ok || response.result.op !== 'listItems') {
      const error = response.ok ? null : response.error
      setLoad((value) => ({ ...value, loadingMore: false }))
      if (error !== null) notify({ kind: 'failed', message: `더 불러오지 못했습니다 — ${error.message}` })
      return
    }
    const { items, nextCursor, truncated } = response.result
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
  const patterns = useMemo(() => (settings === null ? [] : settings.connections.map((connection) => ({
    connectionId: connection.id,
    pattern: settings.sources.find((source) => source.id === connection.sourceId)?.keyPattern ?? null,
  }))), [settings])
  useEffect(() => {
    const candidates = patterns.flatMap(({ connectionId, pattern }) => {
      const key = searchKey({ query, pattern })
      return key === null ? [] : [{ connectionId, key }]
    })
    if (candidates.length === 0) { gate.invalidate('find'); setHits([]); return }
    const token = gate.issue('find')
    void Promise.all(candidates.map(({ connectionId, key }) =>
      window.corral.workRequest({ requestId: `${token}/${connectionId}`, connectionId, call: { op: 'findByKey', key } }).then((response) => ({ connectionId, response })),
    )).then((answers) => {
      if (!gate.accepts({ key: 'find', requestId: token })) return
      const spaceName = (connectionId: string, spaceKey: string): string =>
        settings?.connections.find((connection) => connection.id === connectionId)?.spaces?.find((entry) => entry.key === spaceKey)?.name ?? spaceKey
      setHits(answers.flatMap(({ connectionId, response }) =>
        response.ok && response.result.op === 'findByKey' && response.result.item !== null
          ? [{ connectionId, item: response.result.item, spaceName: spaceName(connectionId, response.result.item.spaceKey) }]
          : []))
    })
  }, [query, patterns, gate, settings])

  // --- 작업 중 (C11) ---
  const lookupOf = ({ response, connectionId }: { response: WorkResponse; connectionId: string }): WorkingLookup => {
    if (!response.ok) return { state: 'error', message: response.error.message }
    if (response.result.op !== 'findByKey' || response.result.item === null) return { state: 'missing' }
    const item = response.result.item
    const spaceName = settings?.connections.find((connection) => connection.id === connectionId)?.spaces?.find((entry) => entry.key === item.spaceKey)?.name ?? item.spaceKey
    return { state: 'found', item, spaceName }
  }
  const trees = useMemo((): WorkingTree[] => repos.flatMap((repo) => repo.worktrees.flatMap((worktree) => {
    if (worktree.openWorkspaceId === null || worktree.branch === null) return []
    const dots = (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes.filter((pane) => pane.agent !== null).map((pane) => paneDot({ pane, unread: false })))
    const status = tabStatus(dots)
    return [{
      path: worktree.path,
      repoRoot: repo.root,
      repoName: repo.name,
      branch: worktree.branch,
      dot: status?.dot ?? (dots.length > 0 ? 'idle' : null),
    }]
  })), [repos])
  const workingEntries = useMemo(() => detectWorking({ trees, patterns }), [trees, patterns])
  const workingIds = workingEntries.map((entry) => `${entry.connectionId}::${entry.key}`).join('|')
  useEffect(() => {
    if (!open) return
    for (const entry of workingEntries) {
      const id = `${entry.connectionId}::${entry.key}`
      setWorking((current) => (current.has(id) ? current : new Map(current).set(id, { state: 'loading' })))
      void send({ key: `working:${id}`, connectionId: entry.connectionId, call: { op: 'findByKey', key: entry.key } }).then(({ accepted, response }) => {
        if (!accepted) return
        setWorking((current) => new Map(current).set(id, lookupOf({ response, connectionId: entry.connectionId })))
      })
    }
  }, [open, workingIds])
  const workingKeys = useMemo(() => new Set(workingEntries.map((entry) => entry.key)), [workingEntries])

  // --- 쓰기 (C7) ---
  const patchItems = useCallback(({ connectionId, spaceKey, update }: { connectionId: string; spaceKey: string; update: (items: WorkItem[]) => WorkItem[] }) => {
    setLoad((value) => ({ ...value, data: value.data.map((entry) => (entry.connectionId === connectionId && entry.spaceKey === spaceKey ? { ...entry, items: update(entry.items) } : entry)) }))
  }, [])

  const move = useCallback(async ({ row, intent, undo }: MoveRequest & { undo: boolean }): Promise<void> => {
    const call = callOf({ item: row.item, intent })
    if (call === null) return
    const { connectionId, spaceKey, statuses } = row.space
    const before = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)?.items ?? []
    const original = before.find((item) => item.id === row.item.id) ?? row.item
    const reverse = inverseOf({ item: original, intent, items: before })
    patchItems({ connectionId, spaceKey, update: (items) => applyIntent({ items, itemId: row.item.id, intent, statuses }) })
    const { accepted, response } = await send({ key: `item:${connectionId}:${row.item.id}`, connectionId, call })
    // 같은 작업에 뒤 요청이 나갔다 — 이 응답은 화면을 건드리지 않는다(뒤 요청이 최종 상태를 정한다).
    if (!accepted) return
    if (!response.ok) {
      // 원래 자리로 — 순서는 옮기기 전 순서 값 전체를, 상태·배치는 그 작업만 되돌린다.
      patchItems({
        connectionId, spaceKey,
        update: (items) => (intent.kind === 'reorder'
          ? items.map((item) => ({ ...item, rank: before.find((entry) => entry.id === item.id)?.rank ?? item.rank }))
          : items.map((item) => (item.id === original.id ? { ...item, statusKey: original.statusKey, category: original.category, placement: original.placement } : item))),
      })
      notify({ kind: 'failed', message: `${original.key} — ${response.error.message}` })
      return
    }
    const result = response.result
    if (result.op === 'changeStatus' || result.op === 'setPlacement' || result.op === 'reorder') {
      // 출처 값으로 덮되, 화면 순서 값은 낙관적 자리를 둔다(다른 작업의 순서 값은 출처가 다시 매겼을 수 있다 — 다음 불러오기에서 맞춘다).
      patchItems({ connectionId, spaceKey, update: (items) => items.map((item) => (item.id === result.item.id ? { ...result.item, rank: item.rank } : item)) })
    }
    const label = describe({ item: original, intent, statuses })
    if (undo) { notify({ kind: 'undone', label: `${original.key} 를 되돌렸습니다` }); return }
    notify({
      kind: 'moved',
      label,
      undo: () => {
        const now = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)
        const item = now?.items.find((entry) => entry.id === original.id)
        if (now === undefined || item === undefined) return
        void move({ row: { item, space: now, status: now.statuses.find((status) => status.key === item.statusKey) ?? null }, intent: reverse, undo: true })
      },
    })
  }, [patchItems, send, notify])

  /** 끄기 시작 — 허용 전이만인 출처면 그 작업의 허용 전이를 받는다(칸 흐림). */
  const beginDrag = useCallback(async (row: TasksRow, mode: 'any' | 'allowed') => {
    if (mode === 'any') { setTransitions(null); return }
    setTransitions({ itemId: row.item.id, keys: null })
    const { accepted, response } = await send({ key: 'transitions', connectionId: row.space.connectionId, call: { op: 'listTransitions', itemId: row.item.id } })
    if (!accepted) return
    setTransitions({ itemId: row.item.id, keys: response.ok && response.result.op === 'listTransitions' ? response.result.statusKeys : null })
  }, [send])
  const endDrag = useCallback(() => {
    gate.invalidate('transitions')
    setTransitions(null)
  }, [gate])

  const rows = useMemo(() => rowsOf(load.spaceId === (space === null ? null : spaceId(space)) ? load.data : []), [load, space])

  const connectionStatus = space?.kind === 'space' ? settings?.connections.find((connection) => connection.id === space.connectionId)?.status ?? null : null
  const banner: TasksBanner | null = load.error !== null
    ? bannerOf(load.error)
    : connectionStatus === 'auth' || connectionStatus === 'forbidden' || connectionStatus === 'offline'
      ? { kind: connectionStatus, message: settings?.connections.find((connection) => space?.kind === 'space' && connection.id === space.connectionId)?.error?.message ?? '' }
      : null

  return {
    prefs, setPrefs, prefsReady,
    settings, groups, space, chooseSpace,
    query, setQuery, selectedId, setSelectedId,
    load, rows, banner, connectionStatus,
    reload, loadMore, invalidateMore,
    hits, workingEntries, working, workingKeys, trees,
    move: (request: MoveRequest) => move({ ...request, undo: false }),
    beginDrag, endDrag, transitions,
  }
}

export type TasksPageModel = ReturnType<typeof useTasksPage>
