// 작업 상세 (LIFE-602 · LIFE-372 묶음 T3 · design-handoff B) — 작업 페이지 안 오른쪽 560 패널 ↔ ⤢ 페이지 전체(본문 820).
//
// 그리기만 한다 — 읽기·쓰기·충돌·활동은 `useTaskDetail`. 화면은 출처 이름으로 분기하지 않는다: 능력 표(`hidden` = 없음 · `disabled` = 흐림 + 이유)와
// descriptor(이름·키 모양)만 본다. 실행 영역·「열기 / ▶ 시작」 은 그리지 않는다(게이트 ⓪ D4 — T5).
// `Esc` 단계(C1): 열린 메뉴·확인 팝오버(여기 `escapeRef`) → 입력 blur → 상세 닫기 → 페이지 닫기(앞 셋은 작업 페이지 키 처리기가 차례로 묻는다).
// 편집기·제목 칸의 Esc 는 그 칸이 먼저 받아 「버림」 으로 끝낸다(기본 동작을 막아 페이지가 다시 처리하지 않는다).
import { useEffect, useMemo, useRef, useState } from 'react'
import { WORK_PRIORITIES, type WorkCall, type WorkFieldPatch, type WorkItem, type WorkRelation, type WorkRelationKind, type WorkStatus } from '../../../shared/work.js'
import type { TaskDetailModel } from '../hooks/useTaskDetail.js'
import {
  ACTIVITY_FILTERS,
  ACTIVITY_FILTER_LABEL,
  CONFLICT_FIELD_LABEL,
  RELATION_LABEL,
  RELATION_ORDER,
  activityCounts,
  activityRows,
  checkRelationKey,
  dueFromInput,
  dueInputValue,
  passesActivity,
  relativeTime,
  statusFill,
  statusMenuRows,
  statusText,
  type ActivityFilter,
  type StatusMenuRow,
} from '../task-detail-model.js'
import { toggleCheckLine } from '../markdown.js'
import { PRIORITY_GLYPH, PRIORITY_LABEL, UNRESTORABLE_RESOLUTION, dueTone, imeComposing, restorableResolution } from '../tasks-model.js'
import { MarkdownEditor } from './MarkdownEditor.js'
import { MarkdownView } from './MarkdownView.js'
import { KindIcon, SpaceDot, StatusCircle } from './TasksViews.js'

type Menu = 'status' | 'priority' | null

export function TaskDetail({ detail, full, now, escapeRef, onToggleFull, onClose, spaceOf }: {
  detail: TaskDetailModel
  full: boolean
  now: number
  /** 작업 페이지 키 처리기가 Esc 첫 단계로 묻는다 — 열린 메뉴·팝오버를 닫았으면 true. */
  escapeRef: React.MutableRefObject<(() => boolean) | null>
  onToggleFull: () => void
  onClose: () => void
  /** 스페이스 키 → 이름·색(설정의 스페이스 목록). 모르면 null. */
  spaceOf: (spaceKey: string) => { name: string; color: string | null; index: number } | null
}): React.JSX.Element | null {
  const { item, base, phase, statuses, descriptor, connection, blocked, conflict } = detail
  const [menu, setMenu] = useState<Menu>(null)
  const [confirm, setConfirm] = useState<StatusMenuRow | null>(null)
  const [editing, setEditing] = useState(false)
  const [bodySaving, setBodySaving] = useState(false)
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [bodyNote, setBodyNote] = useState<string | null>(null)
  const keyPattern = descriptor?.keyPattern ?? null
  const sourceName = descriptor?.name ?? connection?.name ?? '출처'

  // 다른 작업으로 바뀌면 열린 메뉴·편집을 버린다.
  useEffect(() => {
    setMenu(null)
    setConfirm(null)
    setEditing(false)
    setBodySaving(false)
    setBodyError(null)
    setBodyNote(null)
  }, [detail.uid])
  // 같은 작업의 새 열기 회차(연결 세대 변경) — 앞 회차의 저장은 결과를 받지 않으므로 「저장 중」 만 풀고 초안은 둔다(R2-C).
  const savingRef = useRef(bodySaving)
  savingRef.current = bodySaving
  useEffect(() => {
    if (!savingRef.current) return
    setBodySaving(false)
    setBodyNote(null)
    setBodyError('연결이 바뀌어 저장 결과를 확인하지 못했습니다 — 초안은 그대로입니다. 다시 저장하세요.')
  }, [detail.session])
  /** 본문 편집기의 지금 초안 — 보낸 값과 비교한다(R2-B). */
  const bodyDraft = useRef('')

  escapeRef.current = () => {
    if (confirm !== null) { setConfirm(null); return true }
    if (menu !== null) { setMenu(null); return true }
    return false
  }

  if (item === null) {
    return (
      <aside className={`issue-detail${full ? ' is-full' : ''}`} data-issue-detail="" aria-label="작업 상세">
        <div className="issue-detail-head">
          <span className="issue-detail-head-spacer" />
          <button type="button" className="issue-detail-icon" onClick={onClose} aria-label="상세 닫기">✕</button>
        </div>
        <div className="issue-detail-scroll">
          <div className="issue-detail-inner">
            {phase.state === 'error' ? <div className="issue-detail-error" role="status">작업을 열지 못했습니다 — {phase.message}</div> : <div className="issue-detail-loading">불러오는 중…</div>}
          </div>
        </div>
      </aside>
    )
  }

  const status = statuses?.find((entry) => entry.key === item.statusKey) ?? null
  const space = spaceOf(item.spaceKey)
  const versionOf = detail.versionOf
  const writable = blocked === null
  /** 상세(본문 포함)를 출처에서 받았는가 — 받기 전에는 본문 편집·체크 칸을 막는다(R1-B: 목록 값엔 본문이 없어 빈 본문을 저장할 수 있다). */
  const bodyReady = base !== null

  const pickStatus = (row: StatusMenuRow): void => {
    setMenu(null)
    if (row.current) return
    if (row.back) { setConfirm(row); return }
    applyStatus(row)
  }
  const applyStatus = (row: StatusMenuRow): void => {
    setConfirm(null)
    const before = { statusKey: item.statusKey, category: item.category, resolution: item.resolution }
    const resolution = row.category === 'done' ? row.resolution : null
    // 원래 완료 갈래를 다시 쓸 수 없으면(LA archived·duplicate 등) 되돌리기를 내지 않고 그 사실을 알린다 — 완료함으로 바꿔 끼우지 않는다(R1-G).
    const restorable = restorableResolution(before)
    void detail.write({
      call: { op: 'changeStatus', itemId: item.id, statusKey: row.statusKey, ifVersion: versionOf(base), resolution: row.resolution },
      optimistic: (value) => ({ ...value, statusKey: row.statusKey, category: row.category, resolution }),
      label: restorable.restorable ? `${item.key} → ${row.label}` : `${item.key} → ${row.label} · ${UNRESTORABLE_RESOLUTION}`,
      undo: restorable.restorable
        ? (now) => ({
          call: { op: 'changeStatus', itemId: item.id, statusKey: before.statusKey, ifVersion: versionOf(now), resolution: restorable.resolution },
          optimistic: (value) => ({ ...value, ...before }),
          label: null,
          undo: null,
        })
        : null,
    })
  }
  const saveFields = ({ fields, label, optimistic, undoFields }: { fields: WorkFieldPatch; label: string; optimistic: (value: WorkItem) => WorkItem; undoFields: WorkFieldPatch }): Promise<unknown> => detail.write({
    call: fieldCall({ itemId: item.id, fields, ifVersion: versionOf(base) }),
    optimistic,
    label,
    undo: (now) => ({ call: fieldCall({ itemId: item.id, fields: undoFields, ifVersion: versionOf(now) }), optimistic: (value) => ({ ...value, ...undoFields }), label: null, undo: null }),
  })

  const toggleCheck = ({ line, checked }: { line: number; checked: boolean }): void => {
    if (!writable || !bodyReady) return
    const source = item.body ?? ''
    const next = toggleCheckLine({ source, line, checked })
    if (next === null) return
    void saveFields({ fields: { body: next }, label: `${item.key} 체크 칸`, optimistic: (value) => ({ ...value, body: next }), undoFields: { body: source } })
  }
  const saveBody = async (text: string): Promise<void> => {
    if (!bodyReady) return
    setBodySaving(true)
    setBodyError(null)
    setBodyNote(null)
    const outcome = await detail.write({ call: fieldCall({ itemId: item.id, fields: { body: text }, ifVersion: versionOf(base) }), optimistic: (value) => ({ ...value, body: text }), label: null, undo: null, quiet: true })
    // 확인 지연 — 편집기(초안)를 둔 채 기다린다. 늦게 거절되면 초안이 남는다(R1-C). 늦은 결과도 아래 같은 정리로 간다.
    if (outcome.kind === 'late') setBodyNote('출처 확인이 늦어지고 있습니다 — 답이 오면 닫습니다. 초안은 그대로 둡니다.')
    const final = await detail.finalOf(outcome)
    // 떠난 회차의 결과는 지금 상세(새 회차의 편집기·초안)를 건드리지 않는다(R1-A·R2-A). 「저장 중」 은 회차 변경이 푼다.
    if (final.kind === 'left') return
    setBodySaving(false)
    setBodyNote(null)
    if (final.kind === 'ok') {
      // 보낸 값과 지금 초안이 같을 때만 닫는다 — 저장 중 더 고쳤으면 편집기를 두고 알린다(R2-B).
      if (bodyDraft.current === text) setEditing(false)
      else setBodyNote('보낸 내용은 저장했습니다 — 그 뒤 고친 내용은 아직 저장하지 않았습니다.')
      return
    }
    if (final.kind === 'failed') setBodyError(final.error.kind === 'conflict' ? '저장하지 않았습니다 — 위 충돌을 먼저 정하세요.' : `저장하지 못했습니다 — ${final.error.message}`)
    else if (final.kind === 'busy') setBodyError('앞 변경을 출처가 확인하는 중입니다 — 잠시 뒤 다시 저장하세요.')
    else setBodyError('상세를 다시 받는 중입니다 — 잠시 뒤 다시 저장하세요.')
  }

  return (
    <aside
      className={`issue-detail${full ? ' is-full' : ''}`}
      data-issue-detail={item.key}
      aria-label={`${item.key} 상세`}
      onKeyDownCapture={(event) => {
        // Esc 단계: 열린 메뉴·확인 팝오버가 입력보다 먼저 닫힌다 — 포커스가 제목·편집기에 있어도(R1-I). 입력 칸은 이 Esc 를 받지 않는다.
        if (event.key !== 'Escape' || imeComposing(event.nativeEvent) || (menu === null && confirm === null)) return
        event.preventDefault()
        event.stopPropagation()
        setMenu(null)
        setConfirm(null)
      }}
    >
      <div className="issue-detail-head">
        <KindIcon kind={item.kind} />
        <span className="issue-detail-key">{item.key}</span>
        <span className="issue-detail-kind">{item.kind.label}</span>
        <span className="issue-detail-space" data-issue-space={item.spaceKey}>
          {space === null ? null : <SpaceDot color={space.color} index={space.index} />}
          {space?.name ?? item.spaceKey} · {sourceName}
        </span>
        <span className="issue-detail-head-spacer" />
        <button type="button" className="issue-detail-icon" data-issue-full={full ? 'full' : 'panel'} onClick={onToggleFull} title={full ? '패널로' : '페이지 전체로'} aria-label={full ? '패널로' : '페이지 전체로'}>⤢</button>
        <button type="button" className="issue-detail-icon" data-issue-close="" onClick={onClose} title="닫기 (Esc)" aria-label="상세 닫기">✕</button>
      </div>
      <div className="issue-detail-scroll">
        <div className="issue-detail-inner" onMouseDown={(event) => { if (menu !== null && !(event.target instanceof Element && event.target.closest('[data-detail-menu]'))) setMenu(null) }}>
          {conflict === null ? null : (
            <div className="issue-conflict" data-issue-conflict="" role="status">
              <div className="issue-conflict-text">
                <strong>{conflict.by ?? '다른 곳에서'}</strong> 가 {relativeTime({ at: conflict.at, now })} 이 작업을 바꿔 저장하지 않았습니다 —{' '}
                {conflict.fields.length === 0 ? '바뀐 칸을 알 수 없습니다' : conflict.fields.map((field) => <span key={field} className="issue-conflict-field" data-conflict-field={field}>{CONFLICT_FIELD_LABEL[field]}</span>)}
              </div>
              {editing ? <div className="issue-conflict-note">새로 불러오면 편집 중인 본문은 버려집니다.</div> : null}
              <div className="issue-conflict-actions">
                <button type="button" className="issue-btn is-primary" data-conflict-reload="" onClick={() => { setEditing(false); setBodyError(null); detail.reloadFromServer() }}>새로 불러오기</button>
                <button type="button" className="issue-btn" data-conflict-override="" onClick={() => { void detail.overrideConflict().then((final) => { if (final?.kind === 'ok') { setEditing(false); setBodyError(null) } }) }}>내 값으로 덮기</button>
              </div>
            </div>
          )}

          {detail.parents.length === 0 ? null : (
            <nav className="issue-parents" data-issue-parents="" aria-label="부모 경로">
              {detail.parents.map((parent, index) => (
                <span key={parent.id} className="issue-parent">
                  {index > 0 ? <span className="issue-parent-sep" aria-hidden>‹</span> : null}
                  <button type="button" className="issue-parent-link" data-issue-parent={parent.key} onClick={() => detail.openItem(parent.id)} title={parent.title}>
                    <span className="issue-parent-key">{parent.key}</span> {parent.title}
                  </button>
                </span>
              ))}
            </nav>
          )}

          <TitleField item={item} writable={writable} blocked={blocked} onSave={(title) => saveFields({ fields: { title }, label: `${item.key} 제목을 바꿨습니다`, optimistic: (value) => ({ ...value, title }), undoFields: { title: item.title } })} />

          <div className="issue-status-row">
            <div className="issue-status-anchor" data-detail-menu="">
              <button
                type="button"
                className={`issue-status-btn${writable ? '' : ' is-blocked'}${item.category === 'done' && item.resolution === 'cancelled' ? ' is-cancel' : ''}`}
                data-issue-status={item.statusKey}
                data-issue-resolution={item.resolution ?? ''}
                title={blocked ?? undefined}
                aria-disabled={writable ? undefined : true}
                aria-expanded={menu === 'status'}
                onClick={() => {
                  if (!writable) return
                  if (menu === 'status') { setMenu(null); return }
                  setMenu('status')
                  void detail.loadTransitions()
                }}
              >
                <StatusCircle category={item.category} fill={statusFill({ statuses: statuses ?? [], statusKey: item.statusKey })} />
                <span>{statusText({ status, item })}</span>
                <span className="tasks-caret" aria-hidden>▾</span>
              </button>
              {menu === 'status' ? <StatusMenu detail={detail} statuses={statuses ?? []} item={item} onPick={pickStatus} /> : null}
              {confirm === null ? null : (
                <div className="issue-confirm" data-issue-confirm="" role="dialog" aria-label="되돌리기 확인">
                  <div className="issue-confirm-text">{statusText({ status, item })} → {confirm.label} 로 되돌릴까요?</div>
                  <div className="issue-confirm-actions">
                    <button type="button" className="issue-btn" data-confirm-cancel="" onClick={() => setConfirm(null)}>취소</button>
                    <button type="button" className="issue-btn is-primary" data-confirm-ok="" onClick={() => applyStatus(confirm)}>되돌리기</button>
                  </div>
                </div>
              )}
            </div>
            {detail.busy ? <span className="issue-busy" data-issue-busy="">확인하는 중…</span> : null}
          </div>

          <Fields detail={detail} item={item} now={now} menu={menu} setMenu={setMenu} writable={writable} saveFields={saveFields} />

          <section className="issue-section" data-issue-body="">
            <div className="issue-section-head">
              <span>본문</span>
              <span className="issue-detail-head-spacer" />
              {editing ? null : <button type="button" className="issue-link-btn" data-issue-body-edit="" disabled={!writable || !bodyReady} title={blocked ?? (bodyReady ? undefined : '본문을 불러오는 중…')} onClick={() => setEditing(true)}>편집</button>}
            </div>
            {editing ? (
              <MarkdownEditor key={detail.uid ?? ''} initial={item.body ?? ''} keyPattern={keyPattern} saving={bodySaving} error={bodyError ?? bodyNote} draftRef={bodyDraft} onSave={(text) => void saveBody(text)} onCancel={() => { setEditing(false); setBodyError(null); setBodyNote(null) }} />
            ) : (
              <div
                className="issue-body-view"
                onClick={(event) => {
                  if (!writable || !bodyReady || (event.target instanceof Element && event.target.closest('a, input, button'))) return
                  if ((window.getSelection()?.toString() ?? '') !== '') return
                  setEditing(true)
                }}
              >
                {(item.body ?? '').trim().length === 0
                  ? <div className="md-empty">{base === null ? '본문을 불러오는 중…' : '본문이 없습니다 — 눌러서 쓰기'}</div>
                  : <MarkdownView source={item.body ?? ''} keyPattern={keyPattern} onOpenKey={(key) => void detail.openKey(key)} onToggleCheck={writable && bodyReady ? toggleCheck : undefined} />}
              </div>
            )}
          </section>

          <Relations detail={detail} item={item} spaceOf={spaceOf} />
          <Children detail={detail} item={item} />
          <Activity detail={detail} statuses={statuses ?? []} sourceName={sourceName} now={now} keyPattern={keyPattern} />
        </div>
      </div>
    </aside>
  )
}

function fieldCall({ itemId, fields, ifVersion }: { itemId: string; fields: WorkFieldPatch; ifVersion: string | null }): WorkCall {
  return { op: 'updateItem', itemId, fields, ifVersion }
}

function StatusMenu({ detail, statuses, item, onPick }: { detail: TaskDetailModel; statuses: WorkStatus[]; item: WorkItem; onPick: (row: StatusMenuRow) => void }): React.JSX.Element {
  const mode = detail.caps?.transition.mode ?? 'any'
  const known = detail.transitions
  const allowed = mode === 'allowed' ? (known?.state === 'ready' ? known.value : []) : null
  const rows = statusMenuRows({ statuses, item, allowed })
  return (
    <div className="tasks-menu issue-status-menu" data-tasks-menu="status" data-detail-menu="" role="menu">
      {mode === 'allowed' && known?.state === 'loading' ? <div className="tasks-menu-note">허용 전이를 받는 중…</div> : null}
      {mode === 'allowed' && known?.state === 'error' ? <div className="tasks-menu-note">허용 전이를 받지 못했습니다 — {known.message}</div> : null}
      {rows.map((row) => (
        <button
          key={`${row.statusKey}:${row.resolution ?? ''}`}
          type="button"
          role="menuitem"
          className={`tasks-menu-row${row.current ? ' is-on' : ''}${row.resolution === 'cancelled' ? ' is-cancel' : ''}`}
          data-status-row={row.statusKey}
          data-status-resolution={row.resolution ?? ''}
          onClick={() => onPick(row)}
        >
          <StatusCircle category={row.category} fill={statusFill({ statuses, statusKey: row.statusKey })} />
          <span className="tasks-menu-name">{row.label}</span>
          {row.back ? <span className="issue-status-back">되돌리기</span> : null}
        </button>
      ))}
      {mode === 'allowed' && known?.state === 'ready' ? <div className="issue-status-foot" data-status-foot="">허용 전이 {known.value.length}개만</div> : null}
    </div>
  )
}

function TitleField({ item, writable, blocked, onSave }: { item: WorkItem; writable: boolean; blocked: string | null; onSave: (title: string) => Promise<unknown> }): React.JSX.Element {
  const [draft, setDraft] = useState(item.title)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(item.title) }, [item.title, item.id])
  const commit = (): void => {
    const title = draft.trim()
    if (title.length === 0 || title === item.title) { setDraft(item.title); return }
    void onSave(title)
  }
  return (
    <input
      className="issue-title"
      data-issue-title=""
      value={draft}
      readOnly={!writable}
      title={blocked ?? undefined}
      aria-label="제목"
      onFocus={() => { focused.current = true }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { focused.current = false; if (writable) commit() }}
      onKeyDown={(event) => {
        if (imeComposing(event.nativeEvent)) return
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(item.title)
          focused.current = false
          // blur 가 저장하지 않게 — 값을 먼저 되돌린 뒤 흐린다.
          const element = event.currentTarget
          requestAnimationFrame(() => element.blur())
        }
      }}
    />
  )
}

function Fields({ detail, item, now, menu, setMenu, writable, saveFields }: {
  detail: TaskDetailModel
  item: WorkItem
  now: number
  menu: Menu
  setMenu: (menu: Menu) => void
  writable: boolean
  saveFields: (input: { fields: WorkFieldPatch; label: string; optimistic: (value: WorkItem) => WorkItem; undoFields: WorkFieldPatch }) => Promise<unknown>
}): React.JSX.Element {
  const placement = detail.caps?.placement ?? { state: 'on' as const }
  const tone = dueTone({ dueAt: item.dueAt, now })
  const setPlacement = (next: 'board' | 'backlog'): void => {
    if (item.placement === next) return
    const before = item.placement ?? 'board'
    void detail.write({
      call: { op: 'setPlacement', itemId: item.id, placement: next, ifVersion: detail.versionOf(detail.base) },
      optimistic: (value) => ({ ...value, placement: next }),
      label: `${item.key} → ${next === 'board' ? '보드' : '백로그'}`,
      undo: (now) => ({ call: { op: 'setPlacement', itemId: item.id, placement: before, ifVersion: detail.versionOf(now) }, optimistic: (value) => ({ ...value, placement: before }), label: null, undo: null }),
    })
  }
  return (
    <div className="issue-fields" data-issue-fields="">
      <span className="issue-field-label">우선순위</span>
      <span className="issue-field-value issue-status-anchor" data-detail-menu="">
        <button type="button" className="issue-field-btn" data-field="priority" disabled={!writable} title={detail.blocked ?? undefined} onClick={() => setMenu(menu === 'priority' ? null : 'priority')}>
          {item.priority === null ? <span className="issue-muted">없음</span> : <><span className={`tasks-prio prio-${item.priority}`}>{PRIORITY_GLYPH[item.priority] ?? '–'}</span> {PRIORITY_LABEL[item.priority]}</>}
        </button>
        {menu === 'priority' ? (
          <div className="tasks-menu issue-priority-menu" data-tasks-menu="priority-field" data-detail-menu="" role="menu">
            {[...WORK_PRIORITIES, null].map((priority) => (
              <button
                key={priority ?? 'none'}
                type="button"
                role="menuitem"
                className={`tasks-menu-row${item.priority === priority ? ' is-on' : ''}`}
                data-priority-row={priority ?? 'none'}
                onClick={() => {
                  setMenu(null)
                  if (priority === item.priority) return
                  const before = item.priority
                  void saveFields({ fields: { priority }, label: `${item.key} 우선순위 → ${priority === null ? '없음' : PRIORITY_LABEL[priority]}`, optimistic: (value) => ({ ...value, priority }), undoFields: { priority: before } })
                }}
              >
                <span className={`tasks-prio${priority === null ? '' : ` prio-${priority}`}`}>{priority === null ? '' : PRIORITY_GLYPH[priority] ?? '–'}</span>
                <span className="tasks-menu-name">{priority === null ? '없음' : PRIORITY_LABEL[priority]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </span>
      <span className="issue-field-label">마감</span>
      <span className="issue-field-value">
        <input
          type="date"
          className={`issue-due${tone === 'over' || tone === 'soon' ? ` due-${tone}` : ''}`}
          data-field="due"
          value={dueInputValue(item.dueAt)}
          disabled={!writable}
          title={detail.blocked ?? undefined}
          onChange={(event) => {
            const dueAt = dueFromInput(event.target.value)
            if (dueAt === undefined || dueInputValue(dueAt) === dueInputValue(item.dueAt)) return
            const before = item.dueAt
            void saveFields({ fields: { dueAt }, label: `${item.key} 마감 → ${dueAt === null ? '없음' : event.target.value}`, optimistic: (value) => ({ ...value, dueAt }), undoFields: { dueAt: before } })
          }}
        />
      </span>
      {placement.state === 'hidden' ? null : (
        <>
          <span className="issue-field-label">배치</span>
          <span className={`issue-field-value issue-segment${placement.state === 'disabled' ? ' is-disabled' : ''}`} data-field="placement" title={placement.state === 'disabled' ? placement.reason : detail.blocked ?? undefined}>
            {(['board', 'backlog'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={(item.placement ?? 'board') === value ? 'is-on' : ''}
                data-placement={value}
                disabled={placement.state !== 'on' || !writable}
                onClick={() => setPlacement(value)}
              >
                {value === 'board' ? '보드' : '백로그'}
              </button>
            ))}
          </span>
        </>
      )}
    </div>
  )
}

function Relations({ detail, item, spaceOf }: { detail: TaskDetailModel; item: WorkItem; spaceOf: (spaceKey: string) => { name: string; color: string | null; index: number } | null }): React.JSX.Element | null {
  const capability = detail.caps?.relations ?? { state: 'on' as const }
  const [form, setForm] = useState(false)
  const [kind, setKind] = useState<WorkRelationKind>('relates_to')
  const [key, setKey] = useState('')
  const keyRef = useRef(key)
  keyRef.current = key
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => { setForm(false); setKey(''); setError(null); setSending(false) }, [detail.uid])
  // 새 열기 회차(세대 변경) — 앞 회차의 요청은 결과를 받지 않는다. 보내는 중만 풀고 입력은 둔다(R2-C).
  useEffect(() => { setSending(false) }, [detail.session])
  if (capability.state === 'hidden') return null
  const enabled = capability.state === 'on' && detail.blocked === null
  const relations = item.relations ?? []
  const groups = RELATION_ORDER.map((relationKind) => ({ kind: relationKind, rows: relations.filter((relation) => relation.kind === relationKind) })).filter((group) => group.rows.length > 0)

  const remove = (relation: WorkRelation): void => {
    void detail.write({
      call: { op: 'removeRelation', itemId: item.id, relationId: relation.id },
      optimistic: (value) => ({ ...value, relations: value.relations === null ? null : value.relations.filter((entry) => entry.id !== relation.id) }),
      label: `${item.key} 연결 뗌 · ${RELATION_LABEL[relation.kind]} ${relation.other.key}`,
      undo: () => ({ call: { op: 'addRelation', itemId: item.id, kind: relation.kind, otherKey: relation.other.key }, optimistic: null, label: null, undo: null }),
    })
  }
  const submit = async (): Promise<void> => {
    const checked = checkRelationKey({ input: key, selfKey: item.key, keyPattern: detail.descriptor?.keyPattern ?? null })
    if (!checked.ok) { setError(checked.message); return }
    setSending(true)
    setError(null)
    // 대상이 있는지 읽어 본 뒤에만 쓴다 — 없는 키에는 출처 쓰기를 보내지 않는다(R1-H). 떠났으면(null) 아무것도 하지 않는다.
    const found = await detail.lookupKey(checked.key)
    if (found === null) return
    if (!found.found) { setSending(false); setError(found.message); return }
    const sent = key
    const final = await detail.finalOf(await detail.write({ call: { op: 'addRelation', itemId: item.id, kind, otherKey: found.item.key }, optimistic: null, label: null, undo: null, quiet: true }))
    if (final.kind === 'left') return
    setSending(false)
    if (final.kind === 'ok') {
      // 보낸 키 그대로일 때만 칸을 비우고 닫는다 — 그 사이 다른 키를 쳤으면 둔다(R2-B 같은 규칙).
      if (keyRef.current === sent) { setKey(''); setForm(false) }
      return
    }
    if (final.kind === 'failed') setError(final.error.message)
    else if (final.kind === 'busy') setError('앞 변경을 출처가 확인하는 중입니다.')
  }

  return (
    <section className={`issue-section${capability.state === 'disabled' ? ' is-disabled' : ''}`} data-issue-links="" title={capability.state === 'disabled' ? capability.reason : undefined}>
      <div className="issue-section-head"><span>연결</span></div>
      {capability.state === 'disabled' ? <div className="issue-muted issue-reason">{capability.reason}</div> : null}
      {groups.map((group) => (
        <div key={group.kind} className="issue-link-group" data-link-group={group.kind}>
          <div className="issue-link-group-label">{RELATION_LABEL[group.kind]}</div>
          {group.rows.map((relation) => {
            const resolved = relation.other.category === 'done'
            const otherSpace = relation.other.spaceKey !== null && relation.other.spaceKey !== item.spaceKey ? spaceOf(relation.other.spaceKey) : null
            return (
              <div key={relation.id} className={`issue-link-row${resolved ? ' is-resolved' : ''}`} data-link-row={relation.other.key}>
                <StatusCircle category={relation.other.category} fill={0.5} />
                <button type="button" className="issue-link-open" onClick={() => detail.openItem(relation.other.id)} title={relation.other.statusLabel}>
                  <span className="issue-row-key">{relation.other.key}</span>
                  <span className="issue-row-title">{relation.other.title}</span>
                </button>
                {otherSpace === null ? null : (
                  <span className="issue-link-space" data-link-space={relation.other.spaceKey ?? ''}><SpaceDot color={otherSpace.color} index={otherSpace.index} />{otherSpace.name}</span>
                )}
                {enabled ? <button type="button" className="issue-row-remove" data-link-remove={relation.id} title="연결 떼기" aria-label="연결 떼기" onClick={() => remove(relation)}>✕</button> : null}
              </div>
            )
          })}
        </div>
      ))}
      {capability.state !== 'on' ? null : form ? (
        <div className="issue-link-form" data-link-form="">
          <div className="issue-segment" role="radiogroup" aria-label="연결 종류">
            {RELATION_ORDER.map((relationKind) => (
              <button key={relationKind} type="button" role="radio" aria-checked={kind === relationKind} className={kind === relationKind ? 'is-on' : ''} data-link-kind={relationKind} onClick={() => setKind(relationKind)}>{RELATION_LABEL[relationKind]}</button>
            ))}
          </div>
          <input
            className="issue-inline-input"
            data-link-key=""
            placeholder="작업 키"
            value={key}
            autoFocus
            spellCheck={false}
            onChange={(event) => { setKey(event.target.value); setError(null) }}
            onKeyDown={(event) => {
              if (imeComposing(event.nativeEvent)) return
              if (event.key === 'Enter') { event.preventDefault(); if (!sending) void submit() }
            }}
          />
          <button type="button" className="issue-btn is-primary" data-link-submit="" disabled={sending || !enabled} onClick={() => void submit()}>추가</button>
          <button type="button" className="issue-btn" onClick={() => { setForm(false); setError(null) }}>취소</button>
          {error === null ? null : <div className="issue-inline-error" data-link-error="" role="status">{error}</div>}
        </div>
      ) : (
        <button type="button" className="issue-add" data-link-add="" disabled={!enabled} title={detail.blocked ?? undefined} onClick={() => setForm(true)}>+ 연결 추가</button>
      )}
    </section>
  )
}

function Children({ detail, item }: { detail: TaskDetailModel; item: WorkItem }): React.JSX.Element | null {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const titleRef = useRef(title)
  titleRef.current = title
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => { setAdding(false); setTitle(''); setError(null); setSending(false) }, [detail.uid])
  useEffect(() => { setSending(false) }, [detail.session])
  const children = detail.children
  const canAdd = item.kind.childKinds.length > 0
  const rows = children.state === 'ready' ? children.value : []
  if (!canAdd && rows.length === 0) return null
  const done = rows.filter((row) => row.category === 'done').length

  const submit = async (): Promise<void> => {
    const value = title.trim()
    const kindKey = item.kind.childKinds[0]
    if (value.length === 0 || kindKey === undefined) return
    setSending(true)
    setError(null)
    const sent = title
    // 즉시든 30초 뒤든 확정까지 기다린다 — 자식 목록·부모 판·활동은 hook 이 다시 읽는다(R2-E·F). 여기서는 입력만 정리한다.
    const final = await detail.finalOf(await detail.write({ call: { op: 'createItem', spaceKey: item.spaceKey, parentId: item.id, kindKey, title: value }, optimistic: null, label: null, undo: null, quiet: true }))
    if (final.kind === 'left') return
    setSending(false)
    if (final.kind === 'ok') {
      if (titleRef.current === sent) { setTitle(''); setAdding(false) }
      return
    }
    if (final.kind === 'failed') setError(final.error.message)
    else if (final.kind === 'busy') setError('앞 변경을 출처가 확인하는 중입니다.')
  }

  return (
    <section className="issue-section" data-issue-children="">
      <div className="issue-section-head">
        <span>자식</span>
        {children.state === 'ready' ? <span className="issue-count" data-children-count="">{done}/{rows.length}</span> : null}
      </div>
      {children.state === 'error' ? <div className="issue-inline-error">자식을 불러오지 못했습니다 — {children.message}</div> : null}
      {rows.map((child) => (
        <button key={child.id} type="button" className="issue-child-row" data-child-row={child.key} onClick={() => detail.openItem(child.id)}>
          <StatusCircle category={child.category} fill={0.5} />
          <span className="issue-row-key">{child.key}</span>
          <span className="issue-row-title">{child.title}</span>
        </button>
      ))}
      {!canAdd ? null : adding ? (
        <div className="issue-child-form" data-child-form="">
          <input
            className="issue-inline-input"
            data-child-title=""
            placeholder="자식 제목 — Enter"
            value={title}
            autoFocus
            onChange={(event) => { setTitle(event.target.value); setError(null) }}
            onKeyDown={(event) => {
              if (imeComposing(event.nativeEvent)) return
              if (event.key === 'Enter') { event.preventDefault(); if (!sending) void submit() }
            }}
          />
          <button type="button" className="issue-btn" onClick={() => { setAdding(false); setError(null) }}>취소</button>
          {error === null ? null : <div className="issue-inline-error" data-child-error="" role="status">{error}</div>}
        </div>
      ) : (
        <button type="button" className="issue-add" data-child-add="" disabled={detail.blocked !== null} title={detail.blocked ?? undefined} onClick={() => setAdding(true)}>+ 자식 추가</button>
      )}
    </section>
  )
}

function Activity({ detail, statuses, sourceName, now, keyPattern }: { detail: TaskDetailModel; statuses: WorkStatus[]; sourceName: string; now: number; keyPattern: string | null }): React.JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => { setDraft(''); setError(null); setSending(false) }, [detail.uid])
  useEffect(() => { setSending(false) }, [detail.session])
  const history = detail.history.state === 'ready' ? detail.history.value : []
  const comments = detail.comments.state === 'ready' ? detail.comments.value : []
  const rows = useMemo(() => activityRows({ records: detail.records, history, comments, statuses, sourceName }), [detail.records, history, comments, statuses, sourceName])
  const counts = activityCounts(rows)
  const shown = rows.filter((row) => passesActivity({ row, filter }))
  const gate = detail.commentsGate
  const item = detail.item

  const submit = async (): Promise<void> => {
    if (item === null || draft.trim().length === 0) return
    setSending(true)
    setError(null)
    const sent = draft
    // 즉시든 30초 뒤든 확정까지 기다린다 — 코멘트 목록은 hook 이 다시 읽는다(R2-F).
    const final = await detail.finalOf(await detail.write({ call: { op: 'addComment', itemId: item.id, body: sent }, optimistic: null, label: null, undo: null, quiet: true }))
    // 떠난 회차(다른 작업·같은 작업 다시 열기·세대 변경)의 응답은 새 회차의 초안을 건드리지 않는다(R1-A·R2-A).
    if (final.kind === 'left') return
    setSending(false)
    if (final.kind === 'ok') {
      // 보낸 초안 그대로일 때만 비운다 — 보내는 중 더 쓴 초안은 둔다(R2-B 같은 규칙).
      setDraft((current) => (current === sent ? '' : current))
      return
    }
    if (final.kind === 'failed') setError(`남기지 못했습니다 — ${final.error.message}`)
    else if (final.kind === 'busy') setError('앞 변경을 출처가 확인하는 중입니다.')
  }

  return (
    <section className="issue-section issue-activity" data-issue-activity="">
      <div className="issue-section-head"><span>활동</span></div>
      <div className="issue-segment issue-activity-filters" role="tablist">
        {ACTIVITY_FILTERS.map((entry) => (
          <button key={entry} type="button" role="tab" aria-selected={filter === entry} className={filter === entry ? 'is-on' : ''} data-activity-filter={entry} onClick={() => setFilter(entry)}>
            {ACTIVITY_FILTER_LABEL[entry]} <span className="issue-count">{counts[entry]}</span>
          </button>
        ))}
      </div>
      {gate === null ? (
        <div className="issue-composer" data-comment-composer="">
          <textarea
            data-editor-keys=""
            className="issue-composer-input"
            placeholder="코멘트 — markdown, ⌘↵ 로 남기기"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setError(null) }}
            onKeyDown={(event) => {
              if (imeComposing(event.nativeEvent)) return
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!sending) void submit() }
            }}
          />
          {error === null ? null : <div className="issue-inline-error" data-comment-error="" role="status">{error}</div>}
        </div>
      ) : gate.state === 'off' && gate.reason !== null ? (
        <div className="issue-muted issue-reason" data-comment-off="">{gate.reason}</div>
      ) : null}
      {filter === 'agent' || filter === 'run' ? <div className="issue-muted issue-empty" data-activity-empty={filter}>아직 없습니다 — 작업을 시작하면 채워집니다.</div> : null}
      {shown.length === 0 && (filter === 'all' || filter === 'change' || filter === 'comment') ? <div className="issue-muted issue-empty">아직 활동이 없습니다.</div> : null}
      <ol className="issue-activity-list">
        {shown.map((row) => (
          <li key={row.id} className={`issue-activity-row is-${row.kind}`} data-activity-row={row.kind} data-activity-origin={row.kind === 'change' ? row.origin : 'comment'}>
            <div className="issue-activity-meta"><span className="issue-activity-who">{row.who}</span> · <span title={new Date(row.at).toLocaleString()}>{relativeTime({ at: row.at, now })}</span></div>
            {row.kind === 'change'
              ? <div className="issue-activity-text">{row.text}</div>
              : <div className="issue-activity-comment"><MarkdownView source={row.body} keyPattern={keyPattern} onOpenKey={(key) => void detail.openKey(key)} /></div>}
          </li>
        ))}
      </ol>
    </section>
  )
}
