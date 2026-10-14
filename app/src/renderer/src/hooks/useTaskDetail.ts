// 작업 상세 상태·자료 (LIFE-602) — 화면(TaskDetail)은 그리기만, 여기서 읽기·쓰기·충돌·활동을 한다.
//
// 비동기 결과를 언제 적용하는지는 이 파일 한 곳에서 정한다(수정 2 — 규칙 원문 `specs/LIFE-602-task-detail/raw/claude/detail-async-rules.md`).
// - **열기 회차(session)**: 작업(uid) 또는 연결 세대가 바뀔 때마다 하나씩 오른다(A→B→A 도 새 회차). 모든 비동기 시작점은 회차를 잡고,
//   결과가 왔을 때 회차가 같을 때만 적용한다. 다르면 읽기는 버리고 쓰기는 `left` — 화면은 `left` 에 아무것도 하지 않는다(R1-A·R2-A).
//   세대만 바뀐 새 회차는 단건부터 다시 읽고(R2-C·I), 화면은 저장 중 표시를 풀되 초안은 둔다.
// - **판 최신성(stamp)**: 단건 값(base)을 바꾸는 사건마다 시계를 하나 올린다 — 읽기는 **시작할 때**, 쓰기는 **시작할 때와 확정될 때**.
//   읽기 결과는 시작 시각이 지금 base 의 시각보다 뒤일 때만 base 가 된다 — 그 사이 시작·확정된 쓰기가 있으면 낡은 읽기로 버린다(R2-D).
// - **쓰기 준비(sync)**: 응답에 이 작업이 없는 쓰기(연결·자식·코멘트) 뒤 단건을 다시 읽는 동안은 다음 쓰기가 기다렸다가 새 판으로 간다(R2-E).
// - **늦은 확정**: 30초 확인 지연 뒤 온 결과(성공·실패·충돌)는 즉시 결과와 같은 `finish` 로 간다 — 충돌 배너·목록 재조회가 같다(R2-F·G).
// - **목록 묶음 최신성**: 활동(workActivity + listHistory)·코멘트·자식은 같은 묶음의 마지막 요청만 적용한다(R2-H).
// - 쓰기는 작업 페이지의 `writeItem` 하나로 — 보드 끌기와 **같은 잠금**·세대·확인 지연(D3). 판(`ifVersion`)은 충돌 검사 능력이 켜진 출처에서만.
// - 초안(본문·코멘트·제목·연결 키·자식 제목)은 화면이 「보낸 값 vs 지금 값」 으로 정리한다 — 성공해도 보낸 뒤 고친 초안은 지우지 않는다(R2-B).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkActivityRecord,
  WorkCall,
  WorkCapabilities,
  WorkCapability,
  WorkComment,
  WorkError,
  WorkHistoryEntry,
  WorkItem,
  WorkResponse,
  WorkResult,
  WorkStatus,
} from '../../../shared/work.js'
import { conflictFields, type ConflictField } from '../task-detail-model.js'
import { LatestGate, itemUid, writeBlock } from '../tasks-model.js'
import { request, type MoveNotice, type TasksPageModel } from './useTasksPage.js'

export type DetailTarget = { connectionId: string; itemId: string }

/** 능력에 기대는 묶음 — 받는 중 · 받음 · 실패 · 꺼짐(숨김이면 reason null, 흐림이면 이유). */
export type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string } | { state: 'off'; reason: string | null }

export type DetailConflict = { call: WorkCall; current: WorkItem; by: string | null; fields: ConflictField[]; at: number }

export type ParentRef = { id: string; key: string; title: string }

/** 확정된 쓰기 결과 — 즉시든 늦게든 같은 모양. `left` = 요청을 시작한 열기 회차를 떠났다(부르는 쪽은 아무것도 하지 않는다). */
export type DetailFinal = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'busy' } | { kind: 'stale' } | { kind: 'left' }
/** 쓰기 결과 — 확정이거나, 확인 지연(30초)이면 나중에 확정을 주는 약속. */
export type DetailOutcome = DetailFinal | { kind: 'late'; settled: Promise<DetailFinal> }

/** 쓰기 하나 — 낙관적 화면 값, 성공 토스트 문구, 되돌리기(그때의 서버 값으로 만든 역연산). */
export type DetailWrite = {
  call: WorkCall
  optimistic: ((item: WorkItem) => WorkItem) | null
  label: string | null
  undo: ((base: WorkItem) => DetailWrite) | null
  /** 되돌리기로 보낸 쓰기 — 성공하면 「되돌렸습니다」. */
  undoing?: boolean
  /** 실패를 토스트로 알리지 않는다 — 화면이 그 자리에 문구를 보인다(연결·자식·코멘트 입력). 충돌은 그래도 배너. */
  quiet?: boolean
  /** 판을 다시 싣지 않는다 — 「내 값으로 덮기」(판 없이 보낸다). */
  force?: boolean
}

const OFF_HIDDEN: Loaded<never> = { state: 'off', reason: null }

function gateOf(capability: WorkCapability | undefined): Loaded<never> | null {
  if (capability === undefined || capability.state === 'on') return null
  return capability.state === 'hidden' ? OFF_HIDDEN : { state: 'off', reason: capability.reason }
}

/** 판을 싣는 쓰기의 판을 바꾼다 — 쓰기 준비를 기다린 뒤 새 판으로(R2-E) · 덮기는 판 없이. 판이 없는 연산은 그대로. */
function withVersion({ call, version }: { call: WorkCall; version: string | null }): WorkCall {
  switch (call.op) {
    case 'updateItem':
    case 'changeStatus':
    case 'setPlacement':
    case 'setParent':
      return { ...call, ifVersion: version }
    default:
      return call
  }
}

/** 응답에 이 작업의 새 값이 실려 오는가 — 아니면(연결·자식·코멘트) 단건을 다시 읽어야 판이 맞는다. */
function carriesItem({ result, itemId }: { result: WorkResult; itemId: string }): boolean {
  return 'item' in result && result.item !== null && result.item.id === itemId
}

type Settled = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'busy' } | { kind: 'stale' }

export function useTaskDetail({ open, target, page, notify }: { open: boolean; target: DetailTarget | null; page: TasksPageModel; notify: (notice: MoveNotice) => void }) {
  const gate = useRef(new LatestGate()).current
  const uid = target === null ? null : itemUid(target)
  const connection = target === null ? null : page.settings?.connections.find((entry) => entry.id === target.connectionId) ?? null
  const generation = connection?.generation ?? 0

  // 열기 회차 — 작업 또는 세대가 바뀌면 하나 오른다. 렌더 중에 정해 같은 렌더의 모든 콜백이 같은 회차를 본다.
  const sessionKey = uid === null ? '' : `${uid}#${generation}`
  const sessionRef = useRef({ key: '', n: 0 })
  if (sessionRef.current.key !== sessionKey) sessionRef.current = { key: sessionKey, n: sessionRef.current.n + 1 }
  const session = sessionRef.current.n
  const alive = useCallback((started: number): boolean => sessionRef.current.n === started, [])

  // 판 최신성 시계 — 읽기 시작·쓰기 시작·쓰기 확정마다 오른다. base 는 자기를 만든 사건의 시각을 갖는다.
  const clockRef = useRef(0)
  const baseStampRef = useRef(0)
  const tick = useCallback((): number => { clockRef.current += 1; return clockRef.current }, [])

  const [base, setBase] = useState<WorkItem | null>(null)
  const [item, setItem] = useState<WorkItem | null>(null)
  const baseRef = useRef(base)
  baseRef.current = base
  const [phase, setPhase] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; message: string | null }>({ state: 'idle', message: null })
  const [statuses, setStatuses] = useState<WorkStatus[] | null>(null)
  const [parents, setParents] = useState<ParentRef[]>([])
  const [children, setChildren] = useState<Loaded<WorkItem[]>>({ state: 'loading' })
  const [comments, setComments] = useState<Loaded<WorkComment[]>>({ state: 'loading' })
  const [history, setHistory] = useState<Loaded<WorkHistoryEntry[]>>({ state: 'loading' })
  const [records, setRecords] = useState<WorkActivityRecord[]>([])
  const [conflict, setConflict] = useState<DetailConflict | null>(null)
  const [transitions, setTransitions] = useState<Loaded<string[]> | null>(null)
  const [readSeq, setReadSeq] = useState(0)
  /** 쓰기 준비 — 응답에 작업이 없는 쓰기 뒤 단건을 다시 읽는 동안(다음 쓰기는 이것을 기다린다). */
  const syncRef = useRef<Promise<void> | null>(null)
  const [syncing, setSyncing] = useState(false)
  const activitySeqRef = useRef(0)

  const caps: WorkCapabilities | null = connection?.capabilities ?? null
  const descriptor = connection === null ? null : page.settings?.sources.find((source) => source.id === connection.sourceId) ?? null
  const capsRef = useRef(caps)
  capsRef.current = caps
  const locked = uid !== null && page.busy.has(uid)
  /** 확인하는 중 표시 — 잠금(앞 쓰기 확인 중) 또는 쓰기 준비(판 맞추는 중). */
  const busy = locked || syncing
  /** 쓰기 막힘 이유 — 연결 상태(권한·끊김·인증) → 그 작업의 앞 쓰기 확인 중. 쓰기 준비(sync)는 막지 않고 기다린다. */
  const blocked = writeBlock(connection?.status ?? null)?.reason ?? (locked ? '앞 변경을 출처가 확인하는 중…' : null)
  const blockedRef = useRef(blocked)
  blockedRef.current = blocked
  const versionOf = useCallback((current: WorkItem | null): string | null => (capsRef.current?.conflictCheck.state === 'on' ? current?.version ?? null : null), [])

  /** 단건 값을 base 로 받는다 — 시작 시각이 지금 base 보다 뒤일 때만(R2-D). */
  const acceptItem = useCallback(({ value, stamp }: { value: WorkItem; stamp: number }): boolean => {
    if (stamp <= baseStampRef.current) return false
    baseStampRef.current = stamp
    setBase(value)
    setItem(value)
    return true
  }, [])

  /** 읽기 하나 — 같은 열쇠의 마지막 요청이고 같은 열기 회차일 때만 받는다. */
  const read = useCallback(async ({ key, call }: { key: string; call: WorkCall }): Promise<WorkResponse | null> => {
    if (target === null) return null
    const started = sessionRef.current.n
    const requestId = gate.issue(key)
    const response = await request({ requestId, connectionId: target.connectionId, call })
    return gate.accepts({ key, requestId }) && alive(started) ? response : null
  }, [gate, target, alive])

  /** 단건 다시 읽기 — 시작 시각으로 최신성을 본다. 첫 읽기(`item`)와 열쇠를 나눠 서로 버리지 않는다. */
  const refreshItem = useCallback(async (): Promise<void> => {
    if (target === null) return
    const stamp = tick()
    const response = await read({ key: 'refresh', call: { op: 'getItem', itemId: target.itemId } })
    if (response === null || !response.ok || response.result.op !== 'getItem') return
    acceptItem({ value: response.result.item, stamp })
  }, [read, target, acceptItem, tick])

  /** 활동 묶음(corral 기록 + 출처 이력) — 묶음의 마지막 요청·같은 회차만 적용한다(R2-H). */
  const refreshActivity = useCallback(async (): Promise<void> => {
    if (target === null) return
    const started = sessionRef.current.n
    activitySeqRef.current += 1
    const mine = activitySeqRef.current
    const historyGate = gateOf(capsRef.current?.history)
    const [activity, listed] = await Promise.all([
      // 활동 조회 실패는 활동만 비운다 — 상세는 그대로(preload 가 없거나 거절해도 던지지 않는다).
      Promise.resolve().then(() => window.corral.workActivity({ connectionId: target.connectionId, itemId: target.itemId })).catch(() => null),
      historyGate === null ? request({ requestId: `history-${started}-${mine}`, connectionId: target.connectionId, call: { op: 'listHistory', itemId: target.itemId } }) : Promise.resolve(null),
    ])
    if (!alive(started) || activitySeqRef.current !== mine) return
    if (activity !== null && activity.ok) setRecords(activity.records)
    if (historyGate !== null) setHistory(historyGate)
    else if (listed !== null) setHistory(listed.ok && listed.result.op === 'listHistory' ? { state: 'ready', value: listed.result.entries } : { state: 'error', message: listed.ok ? '출처 응답 모양이 다릅니다.' : listed.error.message })
  }, [target, alive])

  const refreshChildren = useCallback(async (): Promise<void> => {
    if (target === null) return
    const response = await read({ key: 'children', call: { op: 'listChildren', itemId: target.itemId } })
    if (response === null) return
    setChildren(response.ok && response.result.op === 'listChildren' ? { state: 'ready', value: response.result.items } : { state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
  }, [read, target])

  const refreshComments = useCallback(async (): Promise<void> => {
    if (target === null) return
    const off = gateOf(capsRef.current?.comments)
    if (off !== null) { setComments(off); return }
    const response = await read({ key: 'comments', call: { op: 'listComments', itemId: target.itemId } })
    if (response === null) return
    setComments(response.ok && response.result.op === 'listComments' ? { state: 'ready', value: response.result.comments } : { state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
  }, [read, target])

  /** 부모 경로 — 가장 가까운 조상부터. 보드 자료에 있으면 그것, 없으면 단건으로(최대 5). */
  const loadParents = useCallback(async (start: WorkItem): Promise<void> => {
    if (target === null) return
    const started = sessionRef.current.n
    const chain: ParentRef[] = []
    let parentId = start.parentId
    for (let depth = 0; depth < 5 && parentId !== null; depth += 1) {
      const known = page.rows.find((row) => row.space.connectionId === target.connectionId && row.item.id === parentId)?.item ?? null
      let parent = known
      if (parent === null) {
        const response = await read({ key: `parent${depth}`, call: { op: 'getItem', itemId: parentId } })
        parent = response !== null && response.ok && response.result.op === 'getItem' ? response.result.item : null
      }
      if (parent === null) break
      chain.push({ id: parent.id, key: parent.key, title: parent.title })
      parentId = parent.parentId
    }
    if (alive(started)) setParents(chain)
  }, [page.rows, read, target, alive])

  // 작업이 바뀌면 다시 짓는다 — 보드 자료에 있는 행으로 먼저 그리고(본문·연결은 단건이 채운다).
  const targetKey = uid ?? ''
  useEffect(() => {
    setConflict(null)
    setTransitions(null)
    setParents([])
    setRecords([])
    baseStampRef.current = 0
    if (target === null) { setBase(null); setItem(null); setPhase({ state: 'idle', message: null }); return }
    const listed = page.rows.find((row) => row.space.connectionId === target.connectionId && row.item.id === target.itemId)?.item ?? null
    setBase(null)
    setItem(listed)
    setStatuses(null)
    setChildren({ state: 'loading' })
    setComments({ state: 'loading' })
    setHistory({ state: 'loading' })
    setPhase({ state: 'loading', message: null })
  }, [targetKey])

  // 회차가 바뀌면(작업·세대) 쓰기 준비를 버린다 — 아래 읽기 effect 가 단건부터 다시 읽는다. 세대만 바뀌었으면 화면 값·초안은 둔다(R2-C·I).
  useEffect(() => {
    syncRef.current = null
    setSyncing(false)
  }, [session])

  useEffect(() => {
    if (!open || target === null) return
    const started = session
    void (async () => {
      const stamp = tick()
      const response = await read({ key: 'item', call: { op: 'getItem', itemId: target.itemId } })
      if (!alive(started) || response === null) return
      if (!response.ok || response.result.op !== 'getItem') {
        setPhase({ state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
        return
      }
      const loaded = response.result.item
      acceptItem({ value: loaded, stamp })
      setPhase({ state: 'ready', message: null })
      const known = page.load.data.find((entry) => entry.connectionId === target.connectionId && entry.spaceKey === loaded.spaceKey)?.statuses ?? null
      if (known !== null) setStatuses(known)
      else {
        const listed = await read({ key: 'statuses', call: { op: 'listStatuses', spaceKey: loaded.spaceKey } })
        if (listed !== null && listed.ok && listed.result.op === 'listStatuses') setStatuses(listed.result.statuses)
      }
      void loadParents(loaded)
      void refreshChildren()
      void refreshComments()
      void refreshActivity()
    })()
  }, [open, session, readSeq])

  // 성공한 쓰기(상세·보드 끌기, 즉시·늦게) — 서버 값을 받는다. 확정 시각을 올려 그 전에 시작한 읽기를 낡은 것으로 만든다.
  // 단건이 아닌 응답(목록 모양)은 본문·연결을 지금 값으로 둔다.
  useEffect(() => {
    const settled = page.settledWrite
    if (settled === null || settled.uid !== uid) return
    baseStampRef.current = tick()
    const merge = (current: WorkItem | null): WorkItem => ({ ...settled.item, body: settled.item.body ?? current?.body ?? null, relations: settled.item.relations ?? current?.relations ?? null })
    setBase(merge)
    setItem(merge)
    void refreshActivity()
  }, [page.settledWrite])

  /** 응답에 이 작업이 없는 쓰기 뒤 — 단건(판)은 쓰기 준비로, 연산에 따라 목록을 다시 읽는다(R1-D·E · R2-E·F). */
  const afterForeign = useCallback((op: WorkCall['op']): void => {
    const done = refreshItem()
    syncRef.current = done
    setSyncing(true)
    void done.finally(() => {
      if (syncRef.current !== done) return
      syncRef.current = null
      setSyncing(false)
    })
    void refreshActivity()
    if (op === 'createItem') void refreshChildren()
    if (op === 'addComment') void refreshComments()
  }, [refreshItem, refreshActivity, refreshChildren, refreshComments])

  /** 확정 처리 — 즉시 결과와 늦은 결과가 같은 길로 온다(R2-F·G). `late` 면 실패 토스트는 작업 페이지가 이미 냈다. */
  const finish = useCallback(({ spec, call, current, started, outcome, late }: { spec: DetailWrite; call: WorkCall; current: WorkItem; started: number; outcome: Settled; late: boolean }): DetailFinal => {
    switch (outcome.kind) {
      case 'ok': {
        setConflict(null)
        if (!carriesItem({ result: outcome.result, itemId: current.id })) afterForeign(call.op)
        if (spec.undoing === true) notify({ kind: 'undone', label: `${current.key} 를 되돌렸습니다` })
        else if (spec.label !== null && spec.undo === null) notify({ kind: 'final', label: spec.label })
        else if (spec.label !== null) {
          const undo = spec.undo
          notify({
            kind: 'moved',
            label: spec.label,
            undo: () => {
              if (undo === null) return true
              const now = baseRef.current
              if (now === null || !alive(started)) return false
              // 지금의 막힘(잠금·연결 상태)을 본다 — 토스트를 만든 때의 값이 아니다.
              if (blockedRef.current !== null) {
                notify({ kind: 'failed', message: `${now.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 되돌리세요.` })
                return false
              }
              void writeRef.current({ ...undo(now), label: null, undo: null, undoing: true })
              return true
            },
          })
        }
        return outcome
      }
      case 'busy':
        setItem(baseRef.current)
        notify({ kind: 'failed', message: `${current.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 하세요.` })
        return outcome
      case 'stale':
        setItem(baseRef.current)
        return outcome
      case 'failed': {
        setItem(baseRef.current)
        const conflictInfo = outcome.error.kind === 'conflict' ? outcome.error.conflict : undefined
        if (conflictInfo !== undefined) {
          const opened = baseRef.current ?? current
          setConflict({ call, current: conflictInfo.current, by: conflictInfo.by, fields: conflictFields({ base: opened, current: conflictInfo.current }), at: Date.parse(conflictInfo.current.updatedAt) || Date.now() })
        } else {
          if (spec.quiet !== true && !late) notify({ kind: 'failed', message: `${current.key} — ${outcome.error.message}` })
          // 늦은 실패는 그 사이 화면이 움직였을 수 있다 — 서버 정본을 다시 읽는다(R1-C).
          if (late) void refreshItem()
        }
        return outcome
      }
    }
  }, [afterForeign, notify, alive, refreshItem])

  /** 쓰기 하나 — 쓰기 준비를 기다리고, 잠금·막힘은 보내기 전에, 결과는 시작한 회차에서만 `finish` 로. */
  const write = useCallback(async (spec: DetailWrite): Promise<DetailOutcome> => {
    if (target === null) return { kind: 'stale' }
    const started = sessionRef.current.n
    let call = spec.force === true ? withVersion({ call: spec.call, version: null }) : spec.call
    const pending = syncRef.current
    if (pending !== null) {
      // 앞 쓰기 뒤 판을 맞추는 중 — 기다렸다가 새 판으로 보낸다(R2-E). 기다리는 사이 떠났으면 보내지 않는다.
      await pending
      if (!alive(started)) return { kind: 'left' }
      if (spec.force !== true) call = withVersion({ call, version: versionOf(baseRef.current) })
    }
    const current = baseRef.current
    if (current === null) return { kind: 'stale' }
    if (blockedRef.current !== null) {
      notify({ kind: 'failed', message: `${current.key} — ${blockedRef.current}` })
      return { kind: 'busy' }
    }
    if (spec.optimistic !== null) {
      const apply = spec.optimistic
      setItem((value) => (value === null ? value : apply(value)))
    }
    // 쓰기 시작 — 그 전에 시작한 읽기는 이제 낡았다(R2-D).
    baseStampRef.current = tick()
    const outcome = await page.writeItem({ connectionId: target.connectionId, spaceKey: current.spaceKey, itemId: current.id, call, optimistic: spec.optimistic })
    if (!alive(started)) return { kind: 'left' }
    if (outcome.kind === 'late') {
      const settled = outcome.settled.then((late): DetailFinal => {
        if (!alive(started) || late.kind === 'stale') return { kind: 'left' }
        return finish({ spec, call, current, started, outcome: late, late: true })
      })
      return { kind: 'late', settled }
    }
    return finish({ spec, call, current, started, outcome, late: false })
  }, [target, notify, page, alive, versionOf, finish, tick])
  const writeRef = useRef(write)
  writeRef.current = write

  /** 확정까지 기다린다 — 늦은 쓰기는 그 약속을, 아니면 그대로. 입력 정리는 이 결과로만 한다. */
  const finalOf = useCallback((outcome: DetailOutcome): Promise<DetailFinal> => (outcome.kind === 'late' ? outcome.settled : Promise.resolve(outcome)), [])

  /** 키로 그 작업이 있는지 읽어 본다 — 연결 추가 전에(R1-H, 없는 키에 쓰기를 보내지 않는다). 떠났으면 null. */
  const lookupKey = useCallback(async (key: string): Promise<{ found: true; item: WorkItem } | { found: false; message: string } | null> => {
    const response = await read({ key: 'lookup', call: { op: 'findByKey', key } })
    if (response === null) return null
    if (!response.ok) return { found: false, message: response.error.message }
    if (response.result.op !== 'findByKey') return { found: false, message: '출처 응답 모양이 다릅니다.' }
    return response.result.item === null ? { found: false, message: `${key} — 없는 작업입니다.` } : { found: true, item: response.result.item }
  }, [read])

  /** 「새로 불러오기」 — 서버 값으로 다시 그린다(미저장 편집은 화면이 버린다). */
  const reloadFromServer = useCallback(() => {
    setConflict(null)
    setReadSeq((value) => value + 1)
  }, [])

  /** 「내 값으로 덮기」 — 같은 쓰기를 판 없이 다시. */
  const overrideConflict = useCallback(async (): Promise<DetailFinal | null> => {
    if (conflict === null) return null
    const final = await finalOf(await write({ call: conflict.call, optimistic: null, label: null, undo: null, force: true }))
    if (final.kind === 'ok') setReadSeq((value) => value + 1)
    return final
  }, [conflict, write, finalOf])

  const loadTransitions = useCallback(async (): Promise<void> => {
    if (target === null || caps?.transition.mode !== 'allowed') { setTransitions(null); return }
    setTransitions({ state: 'loading' })
    const response = await read({ key: 'transitions', call: { op: 'listTransitions', itemId: target.itemId } })
    if (response === null) return
    setTransitions(response.ok && response.result.op === 'listTransitions' ? { state: 'ready', value: response.result.statusKeys } : { state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
  }, [target, caps, read])

  /** 키 링크·연결 행 → 그 작업 상세. 키만 아는 것은 출처에서 찾는다. */
  const openKey = useCallback(async (key: string): Promise<void> => {
    if (target === null) return
    const response = await read({ key: 'find', call: { op: 'findByKey', key } })
    if (response === null) return
    if (response.ok && response.result.op === 'findByKey' && response.result.item !== null) page.setSelectedId(itemUid({ connectionId: target.connectionId, itemId: response.result.item.id }))
    else notify({ kind: 'failed', message: response.ok ? `${key} — 작업을 찾지 못했습니다.` : `${key} — ${response.error.message}` })
  }, [target, read, page, notify])
  const openItem = useCallback((itemId: string) => {
    if (target !== null) page.setSelectedId(itemUid({ connectionId: target.connectionId, itemId }))
  }, [target, page])

  const commentsGate = useMemo(() => gateOf(caps?.comments), [caps])

  return {
    target, uid, session, item, base, phase, statuses, parents, children, comments, history, records, conflict, transitions,
    caps, descriptor, connection, blocked, busy, syncing, commentsGate,
    write, finalOf, versionOf, reloadFromServer, overrideConflict, loadTransitions, openKey, openItem, lookupKey,
    refreshItem, refreshChildren, refreshComments, refreshActivity, setItem,
  }
}

export type TaskDetailModel = ReturnType<typeof useTaskDetail>
