// 작업 상세 상태·자료 (LIFE-602) — 화면(TaskDetail)은 그리기만, 여기서 읽기·쓰기·충돌·활동을 한다.
//
// - 읽기는 열쇠마다 마지막 요청만 받는다(`LatestGate`) — 다른 작업으로 바꾸면 앞 작업의 늦은 응답은 버린다(C1). 열쇠에 작업 uid 를 넣는다.
// - 쓰기는 작업 페이지의 `writeItem` 하나로 — 보드 끌기와 **같은 잠금**·세대·확인 지연(D3). 잠겨 있으면 보내지 않는다.
// - `base` = 서버가 마지막으로 인정한 값(단건 읽기·쓰기 결과). `item` = 화면 값(낙관적 변경 포함). 판(`ifVersion`)은 충돌 검사 능력이 켜진 출처에서만
//   `base.version` 을 싣는다 — 꺼진 출처(LA)는 늘 null 이라 충돌 오류가 나올 수 없고 배너도 없다(C8).
// - 충돌: 저장되지 않는다 — 화면 값은 `base` 로 돌리고, 오류가 실어 온 서버 현재 값과 `base` 를 칸별로 비교해 배너에 싣는다.
//   「새로 불러오기」 = 서버 값으로 다시 읽기 · 「내 값으로 덮기」 = 같은 쓰기를 판 없이 다시.
// - 성공한 쓰기(상세든 보드 끌기든)는 작업 페이지의 `settledWrite` 로 받아 `base`·`item` 에 쓰고 활동을 다시 읽는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkActivityRecord,
  WorkCall,
  WorkCapabilities,
  WorkCapability,
  WorkComment,
  WorkHistoryEntry,
  WorkItem,
  WorkResponse,
  WorkStatus,
} from '../../../shared/work.js'
import { conflictFields, type ConflictField } from '../task-detail-model.js'
import { LatestGate, itemUid, writeBlock } from '../tasks-model.js'
import { request, type ItemWriteOutcome, type MoveNotice, type TasksPageModel } from './useTasksPage.js'

export type DetailTarget = { connectionId: string; itemId: string }

/** 능력에 기대는 묶음 — 받는 중 · 받음 · 실패 · 꺼짐(숨김이면 reason null, 흐림이면 이유). */
export type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string } | { state: 'off'; reason: string | null }

export type DetailConflict = { call: WorkCall; current: WorkItem; by: string | null; fields: ConflictField[]; at: number }

export type ParentRef = { id: string; key: string; title: string }

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
}

const OFF_HIDDEN: Loaded<never> = { state: 'off', reason: null }

function gateOf(capability: WorkCapability | undefined): Loaded<never> | null {
  if (capability === undefined || capability.state === 'on') return null
  return capability.state === 'hidden' ? OFF_HIDDEN : { state: 'off', reason: capability.reason }
}

export function useTaskDetail({ open, target, page, notify }: { open: boolean; target: DetailTarget | null; page: TasksPageModel; notify: (notice: MoveNotice) => void }) {
  const gate = useRef(new LatestGate()).current
  const uid = target === null ? null : itemUid(target)
  const uidRef = useRef(uid)
  uidRef.current = uid
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

  const connection = target === null ? null : page.settings?.connections.find((entry) => entry.id === target.connectionId) ?? null
  const caps: WorkCapabilities | null = connection?.capabilities ?? null
  const descriptor = connection === null ? null : page.settings?.sources.find((source) => source.id === connection.sourceId) ?? null
  const capsRef = useRef(caps)
  capsRef.current = caps
  const busy = uid !== null && page.busy.has(uid)
  /** 쓰기 막힘 이유 — 연결 상태(권한·끊김·인증) → 그 작업의 앞 쓰기 확인 중. */
  const blocked = writeBlock(connection?.status ?? null)?.reason ?? (busy ? '앞 변경을 출처가 확인하는 중…' : null)

  /** 읽기 하나 — 열쇠에 작업 uid 를 넣고, 마지막 요청·같은 작업일 때만 받는다. */
  const read = useCallback(async ({ key, call }: { key: string; call: WorkCall }): Promise<WorkResponse | null> => {
    const at = uidRef.current
    if (target === null || at === null) return null
    const requestId = gate.issue(`${key}:${at}`)
    const response = await request({ requestId, connectionId: target.connectionId, call })
    return gate.accepts({ key: `${key}:${at}`, requestId }) && uidRef.current === at ? response : null
  }, [gate, target])

  const refreshActivity = useCallback(async (): Promise<void> => {
    if (target === null) return
    const at = uidRef.current
    const historyGate = gateOf(capsRef.current?.history)
    const [activity, listed] = await Promise.all([
      // 활동 조회 실패는 활동만 비운다 — 상세는 그대로(preload 가 없거나 거절해도 던지지 않는다).
      Promise.resolve().then(() => window.corral.workActivity({ connectionId: target.connectionId, itemId: target.itemId })).catch(() => null),
      historyGate === null ? read({ key: 'history', call: { op: 'listHistory', itemId: target.itemId } }) : Promise.resolve(null),
    ])
    if (uidRef.current !== at) return
    if (activity !== null && activity.ok) setRecords(activity.records)
    if (historyGate !== null) setHistory(historyGate)
    else if (listed !== null) setHistory(listed.ok && listed.result.op === 'listHistory' ? { state: 'ready', value: listed.result.entries } : { state: 'error', message: listed.ok ? '출처 응답 모양이 다릅니다.' : listed.error.message })
  }, [read, target])

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
    const at = uidRef.current
    const chain: ParentRef[] = []
    let parentId = start.parentId
    for (let depth = 0; depth < 5 && parentId !== null; depth += 1) {
      const known = page.rows.find((row) => row.space.connectionId === target?.connectionId && row.item.id === parentId)?.item ?? null
      let parent = known
      if (parent === null) {
        const response = await read({ key: `parent${depth}`, call: { op: 'getItem', itemId: parentId } })
        parent = response !== null && response.ok && response.result.op === 'getItem' ? response.result.item : null
      }
      if (parent === null) break
      chain.push({ id: parent.id, key: parent.key, title: parent.title })
      parentId = parent.parentId
    }
    if (uidRef.current === at) setParents(chain)
  }, [page.rows, read, target])

  // 작업이 바뀌면 다시 짓는다 — 보드 자료에 있는 행으로 먼저 그리고(본문·연결은 단건이 채운다), 단건·자식·코멘트·활동을 받는다.
  const targetKey = uid ?? ''
  useEffect(() => {
    setConflict(null)
    setTransitions(null)
    setParents([])
    setRecords([])
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

  useEffect(() => {
    if (!open || target === null) return
    let alive = true
    void (async () => {
      const response = await read({ key: 'item', call: { op: 'getItem', itemId: target.itemId } })
      if (!alive || response === null) return
      if (!response.ok || response.result.op !== 'getItem') {
        setPhase({ state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
        return
      }
      const loaded = response.result.item
      setBase(loaded)
      setItem(loaded)
      setPhase({ state: 'ready', message: null })
      const known = page.load.data.find((entry) => entry.connectionId === target.connectionId && entry.spaceKey === loaded.spaceKey)?.statuses ?? null
      if (known !== null) setStatuses(known)
      else {
        const listed = await read({ key: 'statuses', call: { op: 'listStatuses', spaceKey: loaded.spaceKey } })
        if (alive && listed !== null && listed.ok && listed.result.op === 'listStatuses') setStatuses(listed.result.statuses)
      }
      void loadParents(loaded)
      void refreshChildren()
      void refreshComments()
      void refreshActivity()
    })()
    return () => { alive = false }
  }, [open, targetKey, readSeq])

  // 성공한 쓰기(상세·보드 끌기) — 서버 값을 받는다. 단건이 아닌 응답(목록 모양)은 본문·연결을 지금 값으로 둔다.
  useEffect(() => {
    const settled = page.settledWrite
    if (settled === null || settled.uid !== uidRef.current) return
    const merge = (current: WorkItem | null): WorkItem => ({ ...settled.item, body: settled.item.body ?? current?.body ?? null, relations: settled.item.relations ?? current?.relations ?? null })
    setBase(merge)
    setItem(merge)
    void refreshActivity()
  }, [page.settledWrite])

  const versionOf = (current: WorkItem | null): string | null => (caps?.conflictCheck.state === 'on' ? current?.version ?? null : null)

  /** 쓰기 하나 — 잠금·막힘은 보내기 전에, 실패·충돌은 화면 값을 서버 값으로 돌리고 알린다. */
  const write = useCallback(async (spec: DetailWrite): Promise<ItemWriteOutcome> => {
    const current = baseRef.current
    if (target === null || current === null) return { kind: 'stale' }
    const at = uidRef.current
    if (blocked !== null) {
      notify({ kind: 'failed', message: `${current.key} — ${blocked}` })
      return { kind: 'busy' }
    }
    if (spec.optimistic !== null) {
      const apply = spec.optimistic
      setItem((value) => (value === null ? value : apply(value)))
    }
    const outcome = await page.writeItem({ connectionId: target.connectionId, spaceKey: current.spaceKey, itemId: current.id, call: spec.call, optimistic: spec.optimistic })
    if (uidRef.current !== at) return outcome
    switch (outcome.kind) {
      case 'ok': {
        setConflict(null)
        if (spec.undoing === true) notify({ kind: 'undone', label: `${current.key} 를 되돌렸습니다` })
        else if (spec.label !== null) {
          const undo = spec.undo
          notify({
            kind: 'moved',
            label: spec.label,
            undo: () => {
              if (undo === null) return true
              const now = baseRef.current
              if (now === null || uidRef.current !== at) return false
              if (page.busy.has(at ?? '')) {
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
      case 'late':
        return outcome
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
          setConflict({ call: spec.call, current: conflictInfo.current, by: conflictInfo.by, fields: conflictFields({ base: opened, current: conflictInfo.current }), at: Date.parse(conflictInfo.current.updatedAt) || Date.now() })
        } else if (spec.quiet !== true) {
          notify({ kind: 'failed', message: `${current.key} — ${outcome.error.message}` })
        }
        return outcome
      }
    }
  }, [target, blocked, notify, page])
  const writeRef = useRef(write)
  writeRef.current = write

  /** 단건만 다시 — 연결 추가·되돌리기처럼 응답에 작업이 없는 쓰기 뒤. */
  const refreshItem = useCallback(async (): Promise<void> => {
    if (target === null) return
    const response = await read({ key: 'item', call: { op: 'getItem', itemId: target.itemId } })
    if (response === null || !response.ok || response.result.op !== 'getItem') return
    setBase(response.result.item)
    setItem(response.result.item)
  }, [read, target])

  /** 「새로 불러오기」 — 서버 값으로 다시 그린다(미저장 편집은 화면이 버린다). */
  const reloadFromServer = useCallback(() => {
    setConflict(null)
    setReadSeq((value) => value + 1)
  }, [])

  /** 「내 값으로 덮기」 — 같은 쓰기를 판 없이 다시. */
  const overrideConflict = useCallback(async (): Promise<ItemWriteOutcome | null> => {
    if (conflict === null) return null
    const call = conflict.call
    const forced: WorkCall = call.op === 'updateItem' || call.op === 'changeStatus' || call.op === 'setPlacement' || call.op === 'setParent' ? { ...call, ifVersion: null } : call
    const outcome = await write({ call: forced, optimistic: null, label: null, undo: null })
    if (outcome.kind === 'ok') setReadSeq((value) => value + 1)
    return outcome
  }, [conflict, write])

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
    target, uid, item, base, phase, statuses, parents, children, comments, history, records, conflict, transitions,
    caps, descriptor, connection, blocked, busy, commentsGate,
    write, versionOf, reloadFromServer, overrideConflict, loadTransitions, openKey, openItem,
    refreshItem, refreshChildren, refreshComments, refreshActivity, setChildren, setComments, setItem,
  }
}

export type TaskDetailModel = ReturnType<typeof useTaskDetail>
