// 작업 페이지 상태·자료 (LIFE-601) — 화면(TasksPage)은 그리기만, 여기서 출처 요청·영속·낙관적 반영을 한다.
//
// - 요청은 `window.corral.workRequest` 하나(T1 계약). 요청 id 는 `LatestGate` 가 매기고, 같은 열쇠의 마지막 요청 응답만 받는다(C7 늦은 응답 폐기):
//   `load`(스페이스 자료) · `more`(다음 쪽) · `find`(키 검색) · `item:<연결>::<id>`(작업 하나의 쓰기) · `transitions`(끄는 작업의 허용 전이).
// - 작업 정체는 `(연결, 작업 id)`(R1-L) — 작업 id 는 연결 안에서만 유일하다.
// - 끌기 = 즉시 반영 → 요청 → 성공이면 되돌리기 토스트(6초) / 실패면 **마지막 확정 값**으로 + 오류 토스트(R1-E). 같은 작업에 요청이 겹치면
//   앞 요청의 성공은 확정 값만 갱신하고, 뒤 요청이 이미 **거절로** 끝났을 때만 화면에 쓴다(뒤 요청이 성공했으면 앞 응답은 낡은 값이다). 화면 변경은 순번을 달고 남겨 두어, 그보다 먼저 시작한
//   목록 응답이 와도 그 위에 다시 적용한다(R1-F).
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
type KeySearch = { hits: { connectionId: string; item: WorkItem }[]; errors: { connectionId: string; error: WorkError }[] }
/** 화면에 쓴 변경 하나 — 그보다 먼저 시작한 목록 응답에 다시 적용한다(R1-F). */
type Override = { seq: number; connectionId: string; spaceKey: string; apply: (items: WorkItem[]) => WorkItem[] }
/** 작업 하나의 쓰기 기록 — 확정 값(마지막으로 출처가 인정한 값)과 진행 중 요청 수(R1-E). */
type Journal = { confirmed: WorkItem; ranks: Map<string, string | null>; inFlight: number; latest: 'pending' | 'ok' | 'failed' }

const EMPTY_LOAD: TasksLoad = { spaceId: null, phase: 'idle', data: [], error: null, loadingMore: false }
const NO_SEARCH: KeySearch = { hits: [], errors: [] }

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

function setRanks(ranks: Map<string, string | null>): (items: WorkItem[]) => WorkItem[] {
  return (items) => items.map((entry) => {
    const rank = ranks.get(entry.id)
    return rank === undefined ? entry : { ...entry, rank }
  })
}

/** 뒤 요청의 결과 — 기다리는 사이 다른 요청이 바꾸므로 함수로 읽는다(대입 좁히기가 await 를 넘어 남지 않게). */
function latestOf(journal: Journal): Journal['latest'] {
  return journal.latest
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
  const journals = useRef(new Map<string, Journal>())
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
    const response = await window.corral.workRequest({ requestId, connectionId, call })
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
  const targetsId = targets.map((target) => `${target.connectionId}::${target.spaceKey}`).join('|')

  /** 화면 자료에 변경 하나를 쓰고, 순번을 달아 남긴다(R1-F). */
  const patch = useCallback(({ connectionId, spaceKey, apply }: { connectionId: string; spaceKey: string; apply: (items: WorkItem[]) => WorkItem[] }) => {
    writeSeq.current += 1
    overrides.current.push({ seq: writeSeq.current, connectionId, spaceKey, apply })
    setLoad((value) => ({ ...value, data: value.data.map((entry) => (entry.connectionId === connectionId && entry.spaceKey === spaceKey ? { ...entry, items: apply(entry.items) } : entry)) }))
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
        window.corral.workRequest({ requestId: `${at}/st`, connectionId: target.connectionId, call: { op: 'listStatuses', spaceKey: target.spaceKey } }),
        window.corral.workRequest({ requestId: `${at}/it`, connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: null } }),
      ])
      if (!statuses.ok) return { ok: false, error: statuses.error }
      if (!first.ok) return { ok: false, error: first.error }
      if (statuses.result.op !== 'listStatuses' || first.result.op !== 'listItems') return { ok: false, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }
      let { items, nextCursor, truncated } = first.result
      let pages = 1
      // 다시 열 때는 더 받아 둔 쪽 수만큼 다시 받는다 — 아래쪽 작업·스크롤이 사라지지 않게(R1-N).
      const wanted = same ? (pagesRef.current.get(`${target.connectionId}::${target.spaceKey}`) ?? 1) : 1
      while (pages < wanted && nextCursor !== null) {
        const next = await window.corral.workRequest({ requestId: `${at}/it${pages}`, connectionId: target.connectionId, call: { op: 'listItems', spaceKey: target.spaceKey, cursor: nextCursor } })
        if (!next.ok || next.result.op !== 'listItems') break
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
    // 이 목록 요청 뒤에 화면에 쓴 변경(옮기기·원복·응답 반영)을 다시 적용한다 — 옛 목록이 나중 변경을 덮지 않게(R1-F).
    const later = overrides.current.filter((entry) => entry.seq > startSeq)
    overrides.current = later
    if (!same) pagesRef.current = new Map()
    const error = results.flatMap((result) => (result.ok ? [] : [result.error]))[0] ?? null
    const data = results.flatMap((result) => {
      if (!result.ok) return []
      pagesRef.current.set(`${result.data.connectionId}::${result.data.spaceKey}`, result.pages)
      const items = later
        .filter((entry) => entry.connectionId === result.data.connectionId && entry.spaceKey === result.data.spaceKey)
        .reduce((current, entry) => entry.apply(current), result.data.items)
      return [{ ...result.data, items }]
    })
    setLoad({ spaceId: id, phase: error === null ? 'ready' : 'error', data, error, loadingMore: false })
  }, [space, targets, gate])

  // 스페이스가 바뀌면 다시 짓고, 다시 열면 조용히 새로 받는다(지금 그림은 둔 채).
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open || space === null || targets.length === 0) {
      if (open && (space === null || targets.length === 0)) setLoad(EMPTY_LOAD)
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
      window.corral.workRequest({ requestId: `${token}/${connectionId}`, connectionId, call: { op: 'findByKey', key } }).then((response) => ({ connectionId, response })),
    )).then((answers) => {
      if (!gate.accepts({ key: 'find', requestId: token })) return
      // 조회 오류는 「결과 없음」 이 아니다 — 따로 모아 배너로(R1-K).
      setSearch({
        hits: answers.flatMap(({ connectionId, response }) => (response.ok && response.result.op === 'findByKey' && response.result.item !== null ? [{ connectionId, item: response.result.item }] : [])),
        errors: answers.flatMap(({ connectionId, response }) => {
          if (!response.ok) return [{ connectionId, error: response.error }]
          return response.result.op === 'findByKey' ? [] : [{ connectionId, error: { kind: 'invalid_response', message: '출처 응답 모양이 다릅니다.', status: null } }]
        }),
      })
    })
  }, [open, query, patterns, gate])
  const spaceNameOf = useCallback(({ connectionId, spaceKey }: { connectionId: string; spaceKey: string }): string =>
    settings?.connections.find((connection) => connection.id === connectionId)?.spaces?.find((entry) => entry.key === spaceKey)?.name ?? spaceKey, [settings])
  const hits = useMemo((): SearchHit[] => search.hits.map((hit) => ({ ...hit, spaceName: spaceNameOf({ connectionId: hit.connectionId, spaceKey: hit.item.spaceKey }) })), [search, spaceNameOf])

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
  const workingIds = workingEntries.map((entry) => `${entry.connectionId}::${entry.key}`).join('|')
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
  }, [open, workingIds])
  const workingLookups = useMemo(() => {
    const map = new Map<string, WorkingLookup>()
    for (const [id, lookup] of working) {
      map.set(id, lookup.state === 'found' ? { state: 'found', item: lookup.item, spaceName: spaceNameOf({ connectionId: id.slice(0, id.indexOf('::')), spaceKey: lookup.item.spaceKey }) } : lookup)
    }
    return map
  }, [working, spaceNameOf])
  const workingKeys = useMemo(() => new Set(workingEntries.map((entry) => entry.key)), [workingEntries])

  // --- 쓰기 (C7) ---
  const move = useCallback(async ({ row, intent, undo }: MoveRequest & { undo: boolean }): Promise<void> => {
    const call = callOf({ item: row.item, intent })
    if (call === null) return
    const { connectionId, spaceKey, statuses } = row.space
    const uid = rowUid(row)
    const before = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)?.items ?? [row.item]
    const original = before.find((item) => item.id === row.item.id) ?? row.item
    const known = journals.current.get(uid)
    // 진행 중 요청이 없으면 지금 화면 값이 확정 값이다. 있으면(겹친 끌기) 첫 요청 전의 확정 값을 그대로 둔다(R1-E).
    const journal: Journal = known !== undefined && known.inFlight > 0
      ? known
      : { confirmed: original, ranks: new Map(before.map((item) => [item.id, item.rank])), inFlight: 0, latest: 'pending' }
    journal.inFlight += 1
    journal.latest = 'pending'
    journals.current.set(uid, journal)
    const reverse = inverseOf({ item: original, intent, items: before })
    patch({ connectionId, spaceKey, apply: (items) => applyIntent({ items, itemId: row.item.id, intent, statuses }) })
    const { accepted, response } = await send({ key: `item:${uid}`, connectionId, call })
    journal.inFlight -= 1
    const settled = response.ok && (response.result.op === 'changeStatus' || response.result.op === 'setPlacement' || response.result.op === 'reorder') ? response.result.item : null
    if (!accepted) {
      // 앞 요청 — 뒤 요청이 성공했으면 이 응답은 낡았다(버린다). 뒤 요청이 거절로 끝났으면 출처의 마지막 값은 이 성공이다. 아직이면 확정 값만 갱신한다.
      const latest = latestOf(journal)
      if (settled === null || latest === 'ok') return
      journal.confirmed = settled
      if (latest === 'failed' && intent.kind !== 'reorder') patch({ connectionId, spaceKey, apply: setFields({ item: settled }) })
      return
    }
    if (settled !== null) journal.confirmed = settled
    journal.latest = response.ok ? 'ok' : 'failed'
    if (!response.ok) {
      // 마지막 확정 값으로 — 순서는 첫 요청 전 순서 값 전체를, 상태·배치는 그 작업만.
      patch({ connectionId, spaceKey, apply: intent.kind === 'reorder' ? setRanks(journal.ranks) : setFields({ item: journal.confirmed }) })
      notify({ kind: 'failed', message: `${original.key} — ${response.error.message}` })
      return
    }
    // 출처 값으로 덮되, 화면 순서 값은 낙관적 자리를 둔다(다른 작업의 순서 값은 출처가 다시 매겼을 수 있다 — 다음 불러오기에서 맞춘다).
    if (settled !== null && intent.kind !== 'reorder') patch({ connectionId, spaceKey, apply: setFields({ item: settled }) })
    if (undo) { notify({ kind: 'undone', label: `${original.key} 를 되돌렸습니다` }); return }
    const resultItem = settled ?? original
    notify({
      kind: 'moved',
      label: describe({ item: original, intent, statuses }),
      // 되돌리기는 옮긴 맥락(연결·스페이스·작업·이전 값)을 들고 간다 — 다른 스페이스로 옮겨 가도 역요청을 보낸다(R1-E).
      undo: () => {
        const now = loadRef.current.data.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey)
        const at = now ?? row.space
        const item = now?.items.find((entry) => entry.id === original.id) ?? resultItem
        void move({ row: { item, space: at, status: at.statuses.find((status) => status.key === item.statusKey) ?? null }, intent: reverse, undo: true })
      },
    })
  }, [patch, send, notify])

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

  /** 배너의 「다시 시도」 — 실패한 스페이스 목록 조회를 풀고(다시 보낸다) 자료를 다시 받는다. */
  const retry = useCallback(() => {
    setSpaceFetch((current) => new Map([...current].filter(([, value]) => value.state !== 'failed')))
    void reload({ quiet: false })
  }, [reload])

  const rows = useMemo(() => rowsOf(load.spaceId === (space === null ? null : spaceId(space)) ? load.data : []), [load, space])

  // 배너(C5) — 불러오기 오류 → 보이는 연결의 상태 오류 → 스페이스 목록 조회 실패(「전체」 포함) → 키 조회 오류 순.
  const scope = settings === null ? [] : settings.connections.filter((connection) => space === null || space.kind === 'all' || connection.id === space.connectionId)
  const broken = scope.find((connection) => connection.status === 'auth' || connection.status === 'forbidden' || connection.status === 'offline')
  const spaceError = spaceErrors.find((entry) => scope.some((connection) => connection.id === entry.connectionId))
  const keyError = search.errors[0]
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
    beginDrag, endDrag, transitions,
  }
}

export type TasksPageModel = ReturnType<typeof useTasksPage>
