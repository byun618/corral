// 작업 만들기 상태 (LIFE-604) — 빠른 생성 모달 · 칸 인라인 추가 · 스페이스별 초안 · 생성 메타. 화면(`QuickCreate.tsx`)은 그리기만.
//
// - **생성 메타(E11)** 는 (연결 세대, 스페이스, 종류)마다 한 번 받아 둔다. 열쇠에 종류가 들어가 늦게 온 다른 종류의 응답이 지금 종류 칸을
//   덮지 못한다(C8 — 늦은 메타 응답은 버림과 같다). 실패는 그 칸에 남고 「다시 시도」 가 지운 뒤 다시 받는다.
// - **중복 방지(C9)** 는 `page.createItem` 의 잠금(진입마다 하나)이 한다 — 모달 `create:modal`, 인라인 `create:inline:<스페이스>`.
//   `late` 면 「확인 중」 으로 두고 다시 보내지 못한다. 모달을 닫아도 잠금은 답이 올 때까지 남는다(닫았다 다시 열어 또 보내지 못함).
// - **결과를 모르는 만들기(R1-A)**: 출처가 「만들어졌을 수 있음」(`maybeApplied`)·세대 바뀜(`stale`)으로 끝나면 그 스페이스는 `unknown` —
//   모달·인라인 모두 「목록 다시 확인」 을 누르기 전에는 다시 만들지 못한다(자동 재전송 0). 확인은 목록 재조회다.
// - **초안(C5)**: 이 실행의 메모리(페이지가 마운트를 유지하는 동안)에만 — (연결, 스페이스)마다 하나. 앱을 다시 시작하면 없다.
//   디스크(ui-prefs)에 쓰지 않는다 — 사용자 글을 평문 파일·로그로 내보내지 않고, 영속 손상 경로를 만들지 않는다(design-notes §초안).
//   제목·설명·필수 필드 값이 있는 채 닫으면 남고, 비어서 닫으면 지운다. 생성 성공이면 지우고, 닫은 뒤 실패로 끝나면 보낸 값을 초안으로 돌린다.
//   진입점이 값을 줘서 연 새 폼(초안이 이미 있을 때)은 닫아도 그 초안을 건드리지 않는다(R1-C). 연결이 **해제**되면 그 연결의 초안을 버린다 —
//   토큰 교체(세대)로는 버리지 않는다(R1-M).
// - **인라인 글(R1-O)**: blur·Esc 로 닫아도 칸마다 친 글을 기억했다가 다시 열면 돌려준다(메모리만).
// - **「전체」 스페이스**: 만들 스페이스를 모달 머리에 보이고 고르게 한다. 기본값 = 이 실행에서 마지막으로 만든 스페이스(아직 보이면) → 보이는 첫 스페이스.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkCall, WorkCapability, WorkItem, WorkKind, WorkPlacement, WorkStatus } from '../../../shared/work.js'
import {
  RECHECK_HINT,
  UNKNOWN_CREATE,
  checkParent,
  chosenStatus,
  createErrorText,
  defaultKind,
  fieldValues,
  hasDraftContent,
  keepParent,
  nextForm,
  parentCandidates,
  submitProblem,
  targetKey,
  type CreateForm,
  type CreateMetaState,
  type CreateTarget,
} from '../quick-create-model.js'
import type { SpaceData, TasksSpace } from '../tasks-model.js'
import type { CreateSettled, TasksPageModel } from './useTasksPage.js'

export const MODAL_LOCK = 'create:modal'

/** `unknown` = 앞 만들기의 결과를 모른다(R1-A) — 「목록 다시 확인」 전에는 보내지 못한다. */
export type ModalPhase = 'idle' | 'sending' | 'late' | 'unknown'

export type QuickCreateModal = {
  session: number
  target: CreateTarget
  form: CreateForm
  another: boolean
  /** 알림 한 줄(부모를 비움 등) — 다음 입력 때까지. */
  notice: string | null
  error: string | null
  phase: ModalPhase
  /** 제목에 포커스를 다시 줄 때마다 오른다(열기 · 하나 더). */
  focusSeq: number
  /** 진입점 값으로 새 폼을 열었고 그 스페이스에 초안이 이미 있다 — 닫거나 만들어도 그 초안을 덮거나 지우지 않는다(R1-C). */
  keepDraft: boolean
}

export type InlineAdd = {
  target: CreateTarget
  statusKey: string
  columnId: string
  text: string
  phase: ModalPhase
  error: string | null
}

/** 칸 「+ 추가」 의 모양 — 숨김 · 흐림(이유) · 켜짐. */
export type InlineAddView = { state: 'hidden' } | { state: 'disabled'; reason: string } | { state: 'on'; open: boolean; draft: InlineAdd | null }

type Pending = { session: number; target: CreateTarget; form: CreateForm; keepDraft: boolean }

/** 만들기가 쓰는 페이지 모델 몫 — 시험이 이것만 갖춘 가짜 페이지로 훅을 돌릴 수 있다. */
export type QuickCreatePage = Pick<TasksPageModel, 'settings' | 'groups' | 'load' | 'createBusy' | 'createItem' | 'reload'>

export function useQuickCreate({ page, space, writeBlockOf, onCreated, openItem, notifyFailure }: {
  page: QuickCreatePage
  space: TasksSpace | null
  /** 그 연결의 쓰기 막힘 이유(T2 배너 규칙) — 없으면 null. */
  writeBlockOf: (connectionId: string) => string | null
  /** 만든 작업 알림(토스트 「KEY 를 만들었습니다」 + 열기). */
  onCreated: (created: { connectionId: string; item: WorkItem }) => void
  /** 생성 뒤 상세 — `setSelectedId`(토글 아님, F17). */
  openItem: (target: { connectionId: string; itemId: string }) => void
  /** 닫힌 뒤 끝난 실패 — 토스트. */
  notifyFailure: (message: string) => void
}) {
  const [modal, setModal] = useState<QuickCreateModal | null>(null)
  const modalRef = useRef(modal)
  modalRef.current = modal
  const [inline, setInline] = useState<InlineAdd | null>(null)
  const inlineRef = useRef(inline)
  inlineRef.current = inline
  const [metas, setMetas] = useState<ReadonlyMap<string, CreateMetaState>>(new Map())
  const metasRef = useRef(metas)
  metasRef.current = metas
  /** 받는 중인 메타 열쇠 — 같은 칸을 두 번 보내지 않는다. */
  const inflight = useRef(new Set<string>())
  /** 초안 — 열쇠 = (연결, 스페이스). */
  const drafts = useRef(new Map<string, CreateForm>())
  /** 결과를 모르는 만들기가 있었던 (연결, 스페이스) — 목록을 다시 확인하면 빠진다(R1-A). */
  const uncertain = useRef(new Set<string>())
  /** 나가는 중인 인라인 만들기의 잠금 열쇠 — 같은 틱 두 번째 Enter 를 조용히 버린다(R2-F). */
  const inlineSending = useRef(new Set<string>())
  /** 칸 인라인 입력에 친 글 — 열쇠 = (연결, 스페이스, 칸)(R1-O). */
  const inlineTexts = useRef(new Map<string, string>())
  const lastTarget = useRef<CreateTarget | null>(null)
  const anotherPref = useRef(false)
  const sessionSeq = useRef(0)
  const pending = useRef<Pending | null>(null)
  const settings = page.settings
  const generationOf = useCallback((connectionId: string): number => settings?.connections.find((connection) => connection.id === connectionId)?.generation ?? 0, [settings])
  const draftKey = targetKey
  // 메타는 연결 세대마다 — 토큰이 바뀌면 다시 받는다.
  const metaKey = useCallback(({ target, kindKey }: { target: CreateTarget; kindKey: string }): string => `${target.connectionId}#${generationOf(target.connectionId)}::${target.spaceKey}::${kindKey}`, [generationOf])

  // 연결 해제 — 그 연결의 초안·인라인 글·「모름」 표시를 버린다. 연결 목록을 아직 못 받았으면(null) 아무것도 버리지 않는다.
  const connectionsId = settings === null ? null : settings.connections.map((connection) => connection.id).join('|')
  useEffect(() => {
    if (connectionsId === null) return
    const live = new Set(connectionsId === '' ? [] : connectionsId.split('|'))
    const gone = (key: string): boolean => !live.has(key.slice(0, key.indexOf('::')))
    for (const key of [...drafts.current.keys()]) if (gone(key)) drafts.current.delete(key)
    for (const key of [...inlineTexts.current.keys()]) if (gone(key)) inlineTexts.current.delete(key)
    for (const key of [...uncertain.current]) if (gone(key)) uncertain.current.delete(key)
  }, [connectionsId])

  /** 만들 수 있는 스페이스(보이는 스페이스) — 「전체」 머리의 고르기 목록. */
  const targets = useMemo((): (CreateTarget & { name: string; color: string | null; colorIndex: number; sourceName: string })[] => page.groups.flatMap((group) => group.rows.map((row) => ({
    connectionId: row.connectionId, spaceKey: row.key, name: row.name, color: row.color, colorIndex: row.colorIndex, sourceName: group.name,
  }))), [page.groups])
  const dataOf = useCallback((target: CreateTarget): SpaceData | null => page.load.data.find((entry) => entry.connectionId === target.connectionId && entry.spaceKey === target.spaceKey) ?? null, [page.load.data])
  const kindsOf = useCallback((target: CreateTarget): WorkKind[] => dataOf(target)?.kinds ?? [], [dataOf])

  // --- 생성 메타 ---
  const fetchMeta = useCallback(({ target, kindKey }: { target: CreateTarget; kindKey: string }) => {
    const key = metaKey({ target, kindKey })
    const known = metasRef.current.get(key)
    if (inflight.current.has(key) || (known !== undefined && known.state !== 'error')) return
    inflight.current.add(key)
    setMetas((current) => new Map(current).set(key, { state: 'loading' }))
    void window.corral.workRequest({ requestId: `meta:${key}:${Date.now()}`, connectionId: target.connectionId, call: { op: 'getCreateMeta', spaceKey: target.spaceKey, kindKey } })
      .catch(() => null)
      .then((response) => {
        const state: CreateMetaState = response === null ? { state: 'error', message: '요청이 끊겼습니다.' }
          : !response.ok ? { state: 'error', message: createErrorText(response.error) }
            : response.result.op !== 'getCreateMeta' ? { state: 'error', message: '출처 응답 모양이 다릅니다.' }
              : { state: 'ready', meta: response.result.meta }
        inflight.current.delete(key)
        setMetas((current) => new Map(current).set(key, state))
      })
  }, [metaKey])
  const metaOf = useCallback(({ target, kindKey }: { target: CreateTarget; kindKey: string }): CreateMetaState => metas.get(metaKey({ target, kindKey })) ?? { state: 'loading' }, [metas, metaKey])
  const retryMeta = useCallback(() => {
    const current = modalRef.current
    if (current === null) return
    // 실패 칸만 다시 보낸다 — fetchMeta 는 error 칸을 다시 받는다.
    fetchMeta({ target: current.target, kindKey: current.form.kindKey })
  }, [fetchMeta])
  // 모달의 (스페이스, 종류) 메타를 받는다 — 종류를 바꾸면 다시.
  const modalMetaKey = modal === null ? null : metaKey({ target: modal.target, kindKey: modal.form.kindKey })
  useEffect(() => {
    const current = modalRef.current
    if (current === null || current.form.kindKey === '') return
    fetchMeta({ target: current.target, kindKey: current.form.kindKey })
  }, [modalMetaKey, fetchMeta])
  // 단일 스페이스의 기본 종류 — 칸 「+ 추가」 가 그 칸 상태로 만들 수 있는지는 이 메타로 안다(C7).
  // 메타는 **만들 뜻을 보일 때만** 받는다(칸 「+ 추가」 에 포인터·포커스·누름) — 페이지를 열 때마다 출처에 요청을 더하지 않는다
  // (LA 생성 메타 = status_list 한 번). 받기 전에는 칸 진입점이 켜져 있고, 받은 뒤 만들 수 없는 칸은 흐림 + 이유가 된다.
  const single: CreateTarget | null = space?.kind === 'space' ? { connectionId: space.connectionId, spaceKey: space.spaceKey } : null
  const singleKind = defaultKind(single === null ? [] : kindsOf(single))
  const prepareInline = useCallback(() => {
    if (single === null || singleKind === null || writeBlockOf(single.connectionId) !== null) return
    fetchMeta({ target: single, kindKey: singleKind.key })
  }, [single?.connectionId, single?.spaceKey, singleKind?.key, writeBlockOf, fetchMeta])

  // --- 모달 열기·닫기 ---
  /** 「전체」 의 기본 스페이스 — 마지막으로 만든 곳(아직 보이면) → 보이는 첫 스페이스. */
  const defaultTarget = useCallback((): CreateTarget | null => {
    if (space === null) return null
    if (space.kind === 'space') return { connectionId: space.connectionId, spaceKey: space.spaceKey }
    const last = lastTarget.current
    if (last !== null && targets.some((entry) => entry.connectionId === last.connectionId && entry.spaceKey === last.spaceKey)) return last
    const first = targets[0]
    return first === undefined ? null : { connectionId: first.connectionId, spaceKey: first.spaceKey }
  }, [space, targets])

  const freshForm = useCallback(({ target, statusKey, placement }: { target: CreateTarget; statusKey: string | null; placement: WorkPlacement | null }): CreateForm => ({
    kindKey: defaultKind(kindsOf(target))?.key ?? '', title: '', body: '', parentId: null, statusKey, priority: null, placement: placement ?? 'board', values: {},
  }), [kindsOf])

  /** 쓰기가 막혔으면 이유 — 진입점이 흐림 + 이유를 보이고, 열지 않는다. */
  const blockedReason = useCallback((): string | null => {
    const target = defaultTarget()
    if (target === null) return '만들 스페이스가 없습니다.'
    return writeBlockOf(target.connectionId)
  }, [defaultTarget, writeBlockOf])

  const openModal = useCallback(({ statusKey = null, placement = null, title = null }: { statusKey?: string | null; placement?: WorkPlacement | null; title?: string | null } = {}): boolean => {
    if (modalRef.current !== null) return false
    const target = defaultTarget()
    if (target === null || writeBlockOf(target.connectionId) !== null) return false
    const key = draftKey(target)
    const draft = drafts.current.get(key) ?? null
    // 진입점이 준 값(칸 상태·섹션 배치·인라인 제목)이 있으면 그것으로 새로 연다 — 초안은 그대로 남는다(닫아도 건드리지 않는다).
    const entry = statusKey !== null || placement !== null || title !== null
    const base = draft !== null && !entry ? draft : { ...freshForm({ target, statusKey, placement }), title: title ?? '' }
    // 초안의 부모가 지금 목록에 없으면 비우고 알린다 — 칩과 요청이 늘 같은 부모(R1-D).
    const checked = checkParent({ form: base, items: dataOf(target)?.items ?? [] })
    const unknown = uncertain.current.has(key)
    sessionSeq.current += 1
    setModal({
      session: sessionSeq.current, target, form: checked.form, another: anotherPref.current, notice: checked.notice, error: unknown ? UNKNOWN_CREATE : null,
      phase: page.createBusy.has(MODAL_LOCK) ? 'late' : unknown ? 'unknown' : 'idle', focusSeq: 1, keepDraft: entry && draft !== null,
    })
    return true
  }, [defaultTarget, writeBlockOf, draftKey, freshForm, dataOf, page.createBusy])

  /**
   * 닫기(Esc·scrim·취소·페이지 닫힘) — 보내는 중·확인 중이면 초안으로 남기지 않는다(결과는 토스트로, 실패면 그때 초안으로 돌린다).
   * 진입점 값으로 연 새 폼이면 기존 초안을 덮지도 지우지도 않는다(R1-C).
   */
  const close = useCallback(() => {
    const current = modalRef.current
    if (current === null) return
    if ((current.phase === 'idle' || current.phase === 'unknown') && !current.keepDraft) {
      const key = draftKey(current.target)
      if (hasDraftContent(current.form)) drafts.current.set(key, current.form)
      else drafts.current.delete(key)
    }
    setModal(null)
  }, [draftKey])

  const update = useCallback((patch: Partial<CreateForm>) => {
    setModal((current) => (current === null ? current : { ...current, form: { ...current.form, ...patch }, notice: null, error: null }))
  }, [])

  const setKind = useCallback((kindKey: string) => {
    setModal((current) => {
      if (current === null || current.form.kindKey === kindKey) return current
      const kind = kindsOf(current.target).find((entry) => entry.key === kindKey)
      const parent = current.form.parentId === null ? null : (dataOf(current.target)?.items.find((item) => item.id === current.form.parentId) ?? null)
      const kept = parent === null && current.form.parentId !== null
        ? { parentId: null, notice: '부모가 지금 목록에 없어 비웠습니다.' }
        : keepParent({ parent, kindKey, kindLabel: kind?.label ?? kindKey })
      return { ...current, form: { ...current.form, kindKey, parentId: kept.parentId }, notice: kept.notice, error: null }
    })
  }, [kindsOf, dataOf])

  /** 「전체」 에서 만들 스페이스 바꾸기 — 그 스페이스 초안이 있으면 그것, 없으면 지금 글은 두고 종류·부모·상태를 새 스페이스 기준으로. */
  const setTarget = useCallback((target: CreateTarget) => {
    setModal((current) => {
      if (current === null || (current.phase !== 'idle' && current.phase !== 'unknown') || targetKey(current.target) === targetKey(target)) return current
      const draft = drafts.current.get(draftKey(target)) ?? null
      const unknown = uncertain.current.has(draftKey(target))
      const phase: ModalPhase = unknown ? 'unknown' : 'idle'
      if (hasDraftContent(current.form) && !current.keepDraft) drafts.current.set(draftKey(current.target), current.form)
      const fresh = freshForm({ target, statusKey: null, placement: current.form.placement })
      if (draft === null) {
        const form = { ...fresh, title: current.form.title, body: current.form.body }
        return { ...current, target, form, keepDraft: false, phase, notice: current.form.parentId === null ? null : '스페이스를 바꿔 부모를 비웠습니다.', error: unknown ? UNKNOWN_CREATE : null }
      }
      // 그 스페이스 초안 — 부모가 지금 목록에 없으면 비운다(R1-D).
      const checked = checkParent({ form: draft, items: dataOf(target)?.items ?? [] })
      return { ...current, target, form: checked.form, keepDraft: false, phase, notice: checked.notice, error: unknown ? UNKNOWN_CREATE : null }
    })
  }, [draftKey, freshForm, dataOf])

  const toggleAnother = useCallback(() => {
    setModal((current) => {
      if (current === null) return current
      anotherPref.current = !current.another
      return { ...current, another: !current.another }
    })
  }, [])

  // --- 모달 만들기 ---
  /** 끝난 만들기 — 모달이 그 회차로 열려 있으면 거기에, 닫혔으면 토스트·초안으로. */
  const settleModal = useCallback(({ settled, sent }: { settled: CreateSettled; sent: Pending }) => {
    pending.current = null
    const current = modalRef.current
    const here = current !== null && current.session === sent.session
    switch (settled.kind) {
      case 'ok': {
        lastTarget.current = sent.target
        if (!sent.keepDraft) drafts.current.delete(draftKey(sent.target))
        onCreated({ connectionId: sent.target.connectionId, item: settled.item })
        if (!here) return
        if (current.another) {
          setModal({ ...current, form: nextForm(current.form), phase: 'idle', error: null, notice: null, focusSeq: current.focusSeq + 1 })
          return
        }
        setModal(null)
        openItem({ connectionId: sent.target.connectionId, itemId: settled.item.id })
        return
      }
      case 'failed':
      case 'stale': {
        // 결과를 모름(출처 `maybeApplied` · 연결 세대 바뀜) — 다시 확인하기 전에는 다시 만들지 못한다(R1-A).
        const unknown = settled.kind === 'stale' || settled.error.maybeApplied === true
        const message = settled.kind === 'stale' ? '연결이 바뀌어 결과를 확인하지 못했습니다.' : createErrorText(settled.error)
        const key = draftKey(sent.target)
        if (unknown) uncertain.current.add(key)
        if (here) { setModal({ ...current, phase: unknown ? 'unknown' : 'idle', error: unknown ? `${message} ${RECHECK_HINT}` : message }); return }
        // 닫은 뒤 끝남 — 보낸 값(고친 값 그대로)을 초안으로 돌린다(R1-H). 진입점 값으로 연 폼이었고 초안이 따로 있으면 그 초안을 지킨다(R1-C).
        if (!sent.keepDraft || !drafts.current.has(key)) drafts.current.set(key, sent.form)
        notifyFailure(unknown ? `${message} ${RECHECK_HINT} (초안으로 남겼습니다)` : `만들지 못했습니다 — ${message} (초안으로 남겼습니다)`)
      }
    }
  }, [draftKey, onCreated, openItem, notifyFailure])

  const submit = useCallback(async () => {
    const current = modalRef.current
    if (current === null || current.phase !== 'idle') return
    // 같은 틱에 두 번 보냄(Enter·⌘↵ 를 한 번에) — 화면 상태가 아직 idle 이어도 이 회차의 요청이 나가는 중이면 조용히 무시한다(R2-F).
    // 둘째를 페이지 잠금까지 보내면 그 실패가 첫 회차의 「보내는 중」 을 idle 로 풀어 버린다.
    if (pending.current !== null && pending.current.session === current.session) return
    const block = writeBlockOf(current.target.connectionId)
    if (block !== null) { setModal({ ...current, error: block }); return }
    const meta = metaOf({ target: current.target, kindKey: current.form.kindKey })
    if (submitProblem({ form: current.form, meta }) !== null || meta.state !== 'ready') return
    // 부모가 지금 목록에 없거나 규칙 밖이면 보내지 않고 비운다 — 칩과 요청이 어긋나지 않게(R1-D).
    const checked = checkParent({ form: current.form, items: dataOf(current.target)?.items ?? [] })
    if (checked.notice !== null) { setModal({ ...current, form: checked.form, notice: checked.notice }); return }
    const caps = settings?.connections.find((connection) => connection.id === current.target.connectionId)?.capabilities ?? null
    const fields = fieldValues({ form: current.form, meta: meta.meta })
    const call: Extract<WorkCall, { op: 'createItem' }> = {
      op: 'createItem', spaceKey: current.target.spaceKey, parentId: current.form.parentId, kindKey: current.form.kindKey, title: current.form.title.trim(),
      statusKey: chosenStatus({ form: current.form, meta: meta.meta }),
    }
    if (current.form.body.trim().length > 0) call.body = current.form.body
    if (current.form.priority !== null) call.priority = current.form.priority
    // 배치는 출처가 켰고(능력) 이 종류에 적용될 때만 싣는다(R2-H) — 적용 안 되는 종류에 실으면 출처가 거절한다.
    if (caps?.placement.state === 'on' && meta.meta.placement === 'applies') call.placement = current.form.placement
    if (fields.length > 0) call.fields = fields
    const sent: Pending = { session: current.session, target: current.target, form: current.form, keepDraft: current.keepDraft }
    setModal({ ...current, phase: 'sending', error: null, notice: null })
    pending.current = sent
    const outcome = await page.createItem({ lockKey: MODAL_LOCK, connectionId: current.target.connectionId, call })
    if (outcome.kind !== 'late') { settleModal({ settled: outcome, sent }); return }
    const now = modalRef.current
    if (now !== null && now.session === sent.session) setModal({ ...now, phase: 'late' })
    settleModal({ settled: await outcome.settled, sent })
  }, [writeBlockOf, metaOf, settings, dataOf, page, settleModal])

  /**
   * 「목록 다시 확인」(R1-A) — 그 스페이스 목록을 **실제로 받았을 때만** 「모름」 을 푼다(R2-A). 재조회 실패·응답이 버려짐(겹친 재조회·세대 바뀜)이면
   * 「확인하지 못했습니다」 로 남기고 계속 막는다 — 확인하지 않은 채 다시 만들면 중복이 된다.
   */
  const recheck = useCallback(async (target: CreateTarget) => {
    const key = draftKey(target)
    const loaded = await page.reload({ quiet: true })
    const confirmed = loaded.includes(key)
    if (confirmed) uncertain.current.delete(key)
    const notice = confirmed ? '목록을 다시 읽었습니다 — 같은 작업이 이미 보이면 다시 만들지 마세요.' : '목록을 받지 못해 확인하지 못했습니다 — 다시 확인하세요.'
    const same = (current: { phase: ModalPhase; target: CreateTarget }): boolean => current.phase === 'unknown' && draftKey(current.target) === key
    setModal((current) => {
      if (current === null || !same(current)) return current
      return confirmed ? { ...current, phase: 'idle', error: null, notice } : { ...current, error: notice }
    })
    setInline((current) => (current === null || !same(current) ? current : { ...current, phase: confirmed ? 'idle' : 'unknown', error: notice }))
  }, [page, draftKey])

  // 다른 회차(닫았다 다시 연 모달)가 「확인 중」 이면 잠금이 풀릴 때 보통으로 돌린다 — 앞 회차 결과를 모르면 「모름」 으로(R1-A).
  const modalLocked = page.createBusy.has(MODAL_LOCK)
  useEffect(() => {
    if (modalLocked) return
    setModal((current) => {
      if (current === null || current.phase !== 'late' || pending.current?.session === current.session) return current
      const unknown = uncertain.current.has(targetKey(current.target))
      return { ...current, phase: unknown ? 'unknown' : 'idle', error: unknown ? UNKNOWN_CREATE : current.error }
    })
  }, [modalLocked])

  // --- 인라인 추가 (C7) ---
  const inlineView = useCallback(({ statusKey, columnId, unmapped }: { statusKey: string | null; columnId: string; unmapped: boolean }): InlineAddView => {
    if (single === null || unmapped || statusKey === null) return { state: 'hidden' }
    const block = writeBlockOf(single.connectionId)
    if (block !== null) return { state: 'disabled', reason: block }
    if (singleKind === null) return { state: 'disabled', reason: '만들 수 있는 종류가 없습니다.' }
    const meta = metas.get(metaKey({ target: single, kindKey: singleKind.key })) ?? null
    if (meta?.state === 'ready' && !meta.meta.statusKeys.includes(statusKey)) return { state: 'disabled', reason: '이 출처는 이 상태로 바로 만들 수 없습니다 — 만들 수 있는 칸에서 추가하세요.' }
    const current = inline !== null && inline.columnId === columnId && targetKey(inline.target) === targetKey(single) ? inline : null
    return { state: 'on', open: current !== null, draft: current }
  }, [single?.connectionId, single?.spaceKey, singleKind?.key, writeBlockOf, metas, metaKey, inline])

  const openInline = useCallback(({ statusKey, columnId }: { statusKey: string; columnId: string }) => {
    if (single === null) return
    const current = inlineRef.current
    if (current !== null && current.phase !== 'idle' && current.phase !== 'unknown') return
    prepareInline()
    const key = targetKey(single)
    const unknown = uncertain.current.has(key)
    setInline({
      target: single, statusKey, columnId, text: inlineTexts.current.get(`${key}::${columnId}`) ?? '',
      phase: page.createBusy.has(`create:inline:${key}`) ? 'late' : unknown ? 'unknown' : 'idle', error: unknown ? UNKNOWN_CREATE : null,
    })
  }, [single?.connectionId, single?.spaceKey, page.createBusy, prepareInline])
  const setInlineText = useCallback((text: string) => setInline((current) => (current === null || current.phase !== 'idle' ? current : { ...current, text, error: null })), [])
  /** Esc·blur·페이지 닫힘 — 닫고 친 글은 칸마다 기억한다(R1-O). 보내는 중·확인 중이면 닫지 않는다(결과를 그 자리에 보인다). */
  const closeInline = useCallback(() => {
    const current = inlineRef.current
    if (current === null || (current.phase !== 'idle' && current.phase !== 'unknown')) return
    const key = `${targetKey(current.target)}::${current.columnId}`
    if (current.text.trim().length > 0) inlineTexts.current.set(key, current.text)
    else inlineTexts.current.delete(key)
    setInline(null)
  }, [])

  const submitInline = useCallback(async () => {
    const current = inlineRef.current
    if (current === null || current.phase !== 'idle' || current.text.trim().length === 0) return
    const kind = defaultKind(kindsOf(current.target))
    if (kind === null) return
    const meta = metaOf({ target: current.target, kindKey: kind.key })
    if (meta.state === 'loading') { setInline({ ...current, error: '만들기 정보를 받는 중… 잠시 뒤 다시 Enter' }); return }
    if (meta.state === 'error') { prepareInline(); setInline({ ...current, error: `만들기 정보를 받지 못했습니다 — ${meta.message} (다시 Enter 로 재시도)` }); return }
    if (!meta.meta.statusKeys.includes(current.statusKey)) return
    const block = writeBlockOf(current.target.connectionId)
    if (block !== null) { setInline({ ...current, error: block }); return }
    // 기본 종류에 필수 필드가 있으면 그 값으로 모달을 연다 — 빈 값을 보내지 않는다(C7).
    if (meta.meta.fields.length > 0) {
      if (openModal({ statusKey: current.statusKey, placement: 'board', title: current.text.trim() })) {
        inlineTexts.current.delete(`${targetKey(current.target)}::${current.columnId}`)
        setInline(null)
      }
      return
    }
    const caps = settings?.connections.find((connection) => connection.id === current.target.connectionId)?.capabilities ?? null
    const call: Extract<WorkCall, { op: 'createItem' }> = { op: 'createItem', spaceKey: current.target.spaceKey, parentId: null, kindKey: kind.key, title: current.text.trim(), statusKey: current.statusKey }
    if (caps?.placement.state === 'on' && meta.meta.placement === 'applies') call.placement = 'board'
    const lockKey = `create:inline:${targetKey(current.target)}`
    if (inlineSending.current.has(lockKey)) return
    inlineSending.current.add(lockKey)
    setInline({ ...current, phase: 'sending', error: null })
    const outcome = await page.createItem({ lockKey, connectionId: current.target.connectionId, call })
    if (outcome.kind !== 'late') inlineSending.current.delete(lockKey)
    const same = (): InlineAdd | null => {
      const now = inlineRef.current
      return now !== null && now.columnId === current.columnId && targetKey(now.target) === targetKey(current.target) ? now : null
    }
    const textKey = `${targetKey(current.target)}::${current.columnId}`
    const settle = (settled: CreateSettled): void => {
      const now = same()
      if (settled.kind === 'ok') {
        lastTarget.current = current.target
        inlineTexts.current.delete(textKey)
        onCreated({ connectionId: current.target.connectionId, item: settled.item })
        // 연속 추가 — 입력은 비우고 열린 채.
        if (now !== null) setInline({ ...now, text: '', phase: 'idle', error: null })
        return
      }
      const unknown = settled.kind === 'stale' || settled.error.maybeApplied === true
      const message = settled.kind === 'stale' ? '연결이 바뀌어 결과를 확인하지 못했습니다.' : createErrorText(settled.error)
      if (unknown) uncertain.current.add(targetKey(current.target))
      const shown = unknown ? `${message} ${RECHECK_HINT}` : message
      // 친 글은 남는다 — 열려 있으면 그 자리에, 닫혔으면 다음에 열 때.
      if (now !== null) { setInline({ ...now, phase: unknown ? 'unknown' : 'idle', error: shown }); return }
      inlineTexts.current.set(textKey, current.text)
      notifyFailure(unknown ? shown : `만들지 못했습니다 — ${message}`)
    }
    if (outcome.kind !== 'late') { settle(outcome); return }
    const now = same()
    if (now !== null) setInline({ ...now, phase: 'late' })
    const settled = await outcome.settled
    inlineSending.current.delete(lockKey)
    settle(settled)
  }, [kindsOf, metaOf, writeBlockOf, openModal, settings, page, onCreated, notifyFailure, prepareInline])

  // --- 모달 그림 자료 ---
  const modalView = useMemo(() => {
    if (modal === null) return null
    const data = dataOf(modal.target)
    const kinds = data?.kinds ?? []
    const statuses: WorkStatus[] = data?.statuses ?? []
    const noKind: CreateMetaState = { state: 'error', message: '만들 수 있는 종류가 없습니다.' }
    const meta = modal.form.kindKey === '' ? noKind : metaOf({ target: modal.target, kindKey: modal.form.kindKey })
    const parents = parentCandidates({ items: data?.items ?? [], kindKey: modal.form.kindKey })
    const parent = modal.form.parentId === null ? null : (data?.items.find((item) => item.id === modal.form.parentId) ?? null)
    const caps = settings?.connections.find((connection) => connection.id === modal.target.connectionId)?.capabilities ?? null
    const block = writeBlockOf(modal.target.connectionId)
    const problem = modal.phase === 'sending' ? '만드는 중…'
      : modal.phase === 'late' ? '확인 중 — 출처 답을 기다립니다'
        : modal.phase === 'unknown' ? '만들어졌는지 모릅니다 — 목록을 다시 확인하세요'
          : block ?? submitProblem({ form: modal.form, meta })
    const info = targets.find((entry) => entry.connectionId === modal.target.connectionId && entry.spaceKey === modal.target.spaceKey)
    // 이 종류에 배치가 적용되지 않으면(메타) 칩은 흐림 + 이유(R2-H). 능력이 숨김이면 그대로 숨김.
    const ignored = meta.state === 'ready' && meta.meta.placement === 'ignored' && caps !== null && caps.placement.state !== 'hidden'
    const placement: WorkCapability | null = ignored ? { state: 'disabled', reason: '이 종류는 보드/백로그 배치를 받지 않습니다' } : caps?.placement ?? null
    return { kinds, statuses, meta, parents, parent, placement, problem, info, chooseTarget: space?.kind === 'all' }
  }, [modal, dataOf, metaOf, settings, writeBlockOf, targets, space])

  return {
    modal, modalView, targets, openModal, close, update, setKind, setTarget, toggleAnother, submit, retryMeta, blockedReason, recheck,
    inline, inlineView, openInline, prepareInline, setInlineText, closeInline, submitInline,
    /** 시험·진단용 — 지금 초안 키(연결 · 스페이스). */
    draftKeys: () => [...drafts.current.keys()],
  }
}

export type QuickCreateModel = ReturnType<typeof useQuickCreate>
