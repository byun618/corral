// 작업 만들기 상태 (LIFE-604) — 빠른 생성 모달 · 칸 인라인 추가 · 스페이스별 초안 · 생성 메타. 화면(`QuickCreate.tsx`)은 그리기만.
//
// - **생성 메타(E11)** 는 (연결 세대, 스페이스, 종류)마다 한 번 받아 둔다. 열쇠에 종류가 들어가 늦게 온 다른 종류의 응답이 지금 종류 칸을
//   덮지 못한다(C8 — 늦은 메타 응답은 버림과 같다). 실패는 그 칸에 남고 「다시 시도」 가 지운 뒤 다시 받는다.
// - **중복 방지(C9)** 는 `page.createItem` 의 잠금(진입마다 하나)이 한다 — 모달 `create:modal`, 인라인 `create:inline:<스페이스>`.
//   `late` 면 「확인 중」 으로 두고 다시 보내지 못한다. 모달을 닫아도 잠금은 답이 올 때까지 남는다(닫았다 다시 열어 또 보내지 못함).
// - **초안(C5)**: 이 실행의 메모리(페이지가 마운트를 유지하는 동안)에만 — (연결 세대, 스페이스)마다 하나. 앱을 다시 시작하면 없다.
//   디스크(ui-prefs)에 쓰지 않는다 — 사용자 글을 평문 파일·로그로 내보내지 않고, 영속 손상 경로를 만들지 않는다(design-notes §초안).
//   제목·설명·필수 필드 값이 있는 채 닫으면 남고, 비어서 닫으면 지운다. 생성 성공이면 지우고, 닫은 뒤 실패로 끝나면 보낸 값을 초안으로 돌린다.
//   연결이 해제되거나 토큰이 바뀌면(세대) 그 연결의 초안을 버린다.
// - **「전체」 스페이스**: 만들 스페이스를 모달 머리에 보이고 고르게 한다. 기본값 = 이 실행에서 마지막으로 만든 스페이스(아직 보이면) → 보이는 첫 스페이스.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkCall, WorkItem, WorkKind, WorkPlacement, WorkStatus } from '../../../shared/work.js'
import {
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

export type ModalPhase = 'idle' | 'sending' | 'late'

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

type Pending = { session: number; target: CreateTarget; form: CreateForm; generation: number }

export function useQuickCreate({ page, space, writeBlockOf, onCreated, openItem, notifyFailure }: {
  page: TasksPageModel
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
  const drafts = useRef(new Map<string, CreateForm>())
  const lastTarget = useRef<CreateTarget | null>(null)
  const anotherPref = useRef(false)
  const sessionSeq = useRef(0)
  const pending = useRef<Pending | null>(null)
  const settings = page.settings
  const generationOf = useCallback((connectionId: string): number => settings?.connections.find((connection) => connection.id === connectionId)?.generation ?? 0, [settings])
  const draftKey = useCallback((target: CreateTarget): string => `${target.connectionId}#${generationOf(target.connectionId)}::${target.spaceKey}`, [generationOf])
  const metaKey = useCallback(({ target, kindKey }: { target: CreateTarget; kindKey: string }): string => `${draftKey(target)}::${kindKey}`, [draftKey])

  // 연결 해제·토큰 교체 — 그 연결(세대)의 초안을 버린다.
  const generationsId = settings === null ? '' : settings.connections.map((connection) => `${connection.id}#${connection.generation}`).join('|')
  useEffect(() => {
    const live = new Set(generationsId === '' ? [] : generationsId.split('|'))
    for (const key of [...drafts.current.keys()]) if (!live.has(key.slice(0, key.indexOf('::')))) drafts.current.delete(key)
  }, [generationsId])

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
    const draft = drafts.current.get(draftKey(target)) ?? null
    // 진입점이 준 값(칸 상태·섹션 배치·인라인 제목)이 있으면 그것으로 새로 연다 — 초안은 그대로 남는다.
    const entry = statusKey !== null || placement !== null || title !== null
    const form = draft !== null && !entry ? draft : { ...freshForm({ target, statusKey, placement }), title: title ?? '' }
    sessionSeq.current += 1
    setModal({ session: sessionSeq.current, target, form, another: anotherPref.current, notice: null, error: null, phase: page.createBusy.has(MODAL_LOCK) ? 'late' : 'idle', focusSeq: 1 })
    return true
  }, [defaultTarget, writeBlockOf, draftKey, freshForm, page.createBusy])

  /** 닫기(Esc·scrim·취소) — 보내는 중·확인 중이면 초안으로 남기지 않는다(결과는 토스트로, 실패면 그때 초안으로 돌린다). */
  const close = useCallback(() => {
    const current = modalRef.current
    if (current === null) return
    if (current.phase === 'idle') {
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
      const kept = keepParent({ parent, kindKey, kindLabel: kind?.label ?? kindKey })
      return { ...current, form: { ...current.form, kindKey, parentId: kept.parentId }, notice: kept.notice, error: null }
    })
  }, [kindsOf, dataOf])

  /** 「전체」 에서 만들 스페이스 바꾸기 — 그 스페이스 초안이 있으면 그것, 없으면 지금 글은 두고 종류·부모·상태를 새 스페이스 기준으로. */
  const setTarget = useCallback((target: CreateTarget) => {
    setModal((current) => {
      if (current === null || current.phase !== 'idle' || targetKey(current.target) === targetKey(target)) return current
      const draft = drafts.current.get(draftKey(target)) ?? null
      if (hasDraftContent(current.form)) drafts.current.set(draftKey(current.target), current.form)
      const fresh = freshForm({ target, statusKey: null, placement: current.form.placement })
      const form = draft ?? { ...fresh, title: current.form.title, body: current.form.body }
      return { ...current, target, form, notice: current.form.parentId === null ? null : '스페이스를 바꿔 부모를 비웠습니다.', error: null }
    })
  }, [draftKey, freshForm])

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
        drafts.current.delete(draftKey(sent.target))
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
      case 'failed': {
        const message = createErrorText(settled.error)
        if (here) { setModal({ ...current, phase: 'idle', error: message }); return }
        // 닫은 뒤 실패 — 보낸 값을 초안으로 돌린다(더 새 초안이 있으면 그대로).
        const key = draftKey(sent.target)
        if (!drafts.current.has(key)) drafts.current.set(key, sent.form)
        notifyFailure(`만들지 못했습니다 — ${message} (초안으로 남겼습니다)`)
        return
      }
      case 'stale':
        if (here) setModal({ ...current, phase: 'idle', error: '연결이 바뀌어 결과를 확인하지 못했습니다 — 목록에서 확인한 뒤 다시 만드세요.' })
        else notifyFailure('연결이 바뀌어 만들기 결과를 확인하지 못했습니다 — 목록에서 확인하세요.')
    }
  }, [draftKey, onCreated, openItem, notifyFailure])

  const submit = useCallback(async () => {
    const current = modalRef.current
    if (current === null || current.phase !== 'idle') return
    const block = writeBlockOf(current.target.connectionId)
    if (block !== null) { setModal({ ...current, error: block }); return }
    const meta = metaOf({ target: current.target, kindKey: current.form.kindKey })
    if (submitProblem({ form: current.form, meta }) !== null || meta.state !== 'ready') return
    const caps = settings?.connections.find((connection) => connection.id === current.target.connectionId)?.capabilities ?? null
    const fields = fieldValues({ form: current.form, meta: meta.meta })
    const call: Extract<WorkCall, { op: 'createItem' }> = {
      op: 'createItem', spaceKey: current.target.spaceKey, parentId: current.form.parentId, kindKey: current.form.kindKey, title: current.form.title.trim(),
      statusKey: chosenStatus({ form: current.form, meta: meta.meta }),
    }
    if (current.form.body.trim().length > 0) call.body = current.form.body
    if (current.form.priority !== null) call.priority = current.form.priority
    if (caps?.placement.state === 'on') call.placement = current.form.placement
    if (fields.length > 0) call.fields = fields
    const sent: Pending = { session: current.session, target: current.target, form: current.form, generation: generationOf(current.target.connectionId) }
    setModal({ ...current, phase: 'sending', error: null, notice: null })
    pending.current = sent
    const outcome = await page.createItem({ lockKey: MODAL_LOCK, connectionId: current.target.connectionId, call })
    switch (outcome.kind) {
      case 'busy': {
        const now = modalRef.current
        if (now !== null && now.session === sent.session) setModal({ ...now, phase: 'late', error: null })
        return
      }
      case 'late': {
        const now = modalRef.current
        if (now !== null && now.session === sent.session) setModal({ ...now, phase: 'late' })
        settleModal({ settled: await outcome.settled, sent })
        return
      }
      default:
        settleModal({ settled: outcome, sent })
    }
  }, [writeBlockOf, metaOf, settings, generationOf, page, settleModal])

  // 다른 회차(닫았다 다시 연 모달)가 「확인 중」 이면 잠금이 풀릴 때 보통으로 돌린다.
  const modalLocked = page.createBusy.has(MODAL_LOCK)
  useEffect(() => {
    if (modalLocked) return
    setModal((current) => (current !== null && current.phase === 'late' && pending.current?.session !== current.session ? { ...current, phase: 'idle' } : current))
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
    if (current !== null && current.phase !== 'idle') return
    prepareInline()
    setInline({ target: single, statusKey, columnId, text: '', phase: page.createBusy.has(`create:inline:${targetKey(single)}`) ? 'late' : 'idle', error: null })
  }, [single?.connectionId, single?.spaceKey, page.createBusy, prepareInline])
  const setInlineText = useCallback((text: string) => setInline((current) => (current === null || current.phase !== 'idle' ? current : { ...current, text, error: null })), [])
  /** Esc·blur — 보내는 중이면 닫지 않는다(결과를 그 자리에 보인다). */
  const closeInline = useCallback(({ force }: { force: boolean }) => setInline((current) => (current === null || (!force && current.phase !== 'idle') ? current : null)), [])

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
      if (openModal({ statusKey: current.statusKey, placement: 'board', title: current.text.trim() })) setInline(null)
      return
    }
    const caps = settings?.connections.find((connection) => connection.id === current.target.connectionId)?.capabilities ?? null
    const call: Extract<WorkCall, { op: 'createItem' }> = { op: 'createItem', spaceKey: current.target.spaceKey, parentId: null, kindKey: kind.key, title: current.text.trim(), statusKey: current.statusKey }
    if (caps?.placement.state === 'on') call.placement = 'board'
    setInline({ ...current, phase: 'sending', error: null })
    const lockKey = `create:inline:${targetKey(current.target)}`
    const outcome = await page.createItem({ lockKey, connectionId: current.target.connectionId, call })
    const same = (): InlineAdd | null => {
      const now = inlineRef.current
      return now !== null && now.columnId === current.columnId && targetKey(now.target) === targetKey(current.target) ? now : null
    }
    const settle = (settled: CreateSettled): void => {
      const now = same()
      if (settled.kind === 'ok') {
        lastTarget.current = current.target
        onCreated({ connectionId: current.target.connectionId, item: settled.item })
        // 연속 추가 — 입력은 비우고 열린 채.
        if (now !== null) setInline({ ...now, text: '', phase: 'idle', error: null })
        return
      }
      const message = settled.kind === 'stale' ? '연결이 바뀌어 결과를 확인하지 못했습니다 — 목록에서 확인하세요.' : createErrorText(settled.error)
      if (now !== null) setInline({ ...now, phase: 'idle', error: message })
      else notifyFailure(`만들지 못했습니다 — ${message}`)
    }
    switch (outcome.kind) {
      case 'busy': { const now = same(); if (now !== null) setInline({ ...now, phase: 'late' }); return }
      case 'late': {
        const now = same()
        if (now !== null) setInline({ ...now, phase: 'late' })
        settle(await outcome.settled)
        return
      }
      default: settle(outcome)
    }
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
        : block ?? submitProblem({ form: modal.form, meta })
    const info = targets.find((entry) => entry.connectionId === modal.target.connectionId && entry.spaceKey === modal.target.spaceKey)
    return { kinds, statuses, meta, parents, parent, placement: caps?.placement ?? null, problem, info, chooseTarget: space?.kind === 'all' }
  }, [modal, dataOf, metaOf, settings, writeBlockOf, targets, space])

  return {
    modal, modalView, targets, openModal, close, update, setKind, setTarget, toggleAnother, submit, retryMeta, blockedReason,
    inline, inlineView, openInline, prepareInline, setInlineText, closeInline, submitInline,
    /** 시험·진단용 — 지금 초안 키(연결 세대 · 스페이스). */
    draftKeys: () => [...drafts.current.keys()],
  }
}

export type QuickCreateModel = ReturnType<typeof useQuickCreate>
