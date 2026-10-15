// 작업 만들기 화면 (LIFE-604 · 목업 C) — 빠른 생성 모달과 칸 인라인 추가. 상태는 `useQuickCreate`, 이 파일은 그리기·키만.
//
// - 키: ⌘↵(또는 Ctrl+↵, 모달 어디서나) · 제목에서 Enter = 만들기. IME 조합 중 Enter 는 조합만. Esc = 열린 메뉴 → 모달 닫기 —
//   document capture 로 받아 페이지 Esc 단계로 내려가지 않는다(StartWorkModal 선례). 페이지 키(`C`·`/`·`1–4`)는 TasksPage 가 모달이 열린 동안 받지 않는다.
// - 출처 이름으로 분기하지 않는다 — 상태 각주·필수 필드 상자는 생성 메타로만 그린다.
import { useEffect, useRef, useState } from 'react'
import type { WorkCreateField, WorkPlacement, WorkPriority } from '../../../shared/work.js'
import type { InlineAddView, QuickCreateModel } from '../hooks/useQuickCreate.js'
import { PRIORITY_CYCLE, hasDraftContent, statusNote, statusOptions } from '../quick-create-model.js'
import { PRIORITY_GLYPH, PRIORITY_LABEL, imeComposing } from '../tasks-model.js'
import { KindIcon, SpaceDot, StatusCircle } from './TasksViews.js'
import './quick-create.css'

const PLACEMENTS: WorkPlacement[] = ['board', 'backlog']
const priorityText = (priority: WorkPriority | null): string => (priority === null ? '우선순위 없음' : PRIORITY_LABEL[priority])

export function QuickCreateModal({ model }: { model: QuickCreateModel }): React.JSX.Element | null {
  const { modal, modalView } = model
  const [menu, setMenu] = useState<'parent' | 'status' | 'target' | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef(menu)
  menuRef.current = menu
  const open = modal !== null
  const focusSeq = modal?.focusSeq ?? 0
  const session = modal?.session ?? 0
  useEffect(() => {
    if (open) titleRef.current?.focus()
  }, [open, focusSeq, session])
  useEffect(() => {
    if (!open) { setMenu(null); return }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 조합 중 Esc 는 조합만 끝낸다 — 그래도 페이지 Esc 로는 내려가지 않는다.
      event.stopPropagation()
      if (imeComposing(event)) return
      event.preventDefault()
      if (menuRef.current !== null) { setMenu(null); return }
      model.close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, model.close])
  if (modal === null || modalView === null) return null

  const { form } = modal
  const { kinds, statuses, meta, parents, parent, placement, problem, info } = modalView
  const ready = meta.state === 'ready' ? meta.meta : null
  const options = ready === null ? [] : statusOptions({ statuses, meta: ready })
  const note = ready === null ? null : statusNote({ statuses, meta: ready })
  const statusKey = ready === null ? form.statusKey : (form.statusKey !== null && ready.statusKeys.includes(form.statusKey) ? form.statusKey : ready.defaultStatusKey)
  const status = statuses.find((entry) => entry.key === statusKey) ?? null
  const locked = modal.phase !== 'idle'
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Enter' || imeComposing(event.nativeEvent)) return
    const inTitle = event.target === titleRef.current
    if (!(event.metaKey || event.ctrlKey) && !inTitle) return
    event.preventDefault()
    void model.submit()
  }

  return (
    <div className="modal-scrim quick-create-scrim" data-modal-scrim="" onClick={() => model.close()}>
      <div
        className="modal modal-quick-create"
        data-quick-create=""
        data-quick-create-phase={modal.phase}
        role="dialog"
        aria-label="새 작업"
        aria-busy={locked}
        onClick={(event) => { event.stopPropagation(); if (menu !== null && !(event.target instanceof Element && event.target.closest('.qc-anchor'))) setMenu(null) }}
        onKeyDown={onKeyDown}
      >
        <header className="qc-head">
          {modalView.chooseTarget ? (
            <span className="qc-anchor">
              <button type="button" className="qc-target" data-quick-create-target="" disabled={locked} onClick={() => setMenu(menu === 'target' ? null : 'target')} title="만들 스페이스">
                {info === undefined ? null : <SpaceDot color={info.color} index={info.colorIndex} />}
                <span className="qc-space">{info?.name ?? modal.target.spaceKey}</span>
                <span className="tasks-caret" aria-hidden>▾</span>
              </button>
              {menu === 'target' ? (
                <div className="tasks-menu qc-menu" data-qc-menu="target" role="menu">
                  {model.targets.map((entry) => (
                    <button key={`${entry.connectionId}::${entry.spaceKey}`} type="button" className="tasks-menu-row" data-quick-create-target-row={entry.spaceKey} onClick={() => { model.setTarget(entry); setMenu(null) }}>
                      <SpaceDot color={entry.color} index={entry.colorIndex} />
                      <span className="tasks-menu-name">{entry.name}</span>
                      <span className="tasks-menu-count">{entry.sourceName}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          ) : (
            <>
              {info === undefined ? null : <SpaceDot color={info.color} index={info.colorIndex} />}
              <span className="qc-space">{info?.name ?? modal.target.spaceKey}</span>
            </>
          )}
          <span className="qc-crumb">{info?.sourceName ?? ''} ›</span>
          <span>새 작업</span>
          <span className="tasks-head-spacer" />
          {hasDraftContent(form) ? <span className="qc-draft-note" data-quick-create-draft="">닫아도 초안이 남습니다</span> : null}
        </header>

        <div className="qc-body">
          <div className="qc-kinds" role="radiogroup" aria-label="종류">
            {kinds.map((kind) => (
              <button key={kind.key} type="button" role="radio" aria-checked={form.kindKey === kind.key} className={`qc-kind${form.kindKey === kind.key ? ' is-on' : ''}`} data-quick-create-kind={kind.key} disabled={locked} onClick={() => model.setKind(kind.key)}>
                <KindIcon kind={kind} />{kind.label}
              </button>
            ))}
          </div>
          <input
            ref={titleRef}
            className="qc-title"
            data-quick-create-title=""
            placeholder="제목"
            value={form.title}
            readOnly={locked}
            onChange={(event) => model.update({ title: event.target.value })}
            spellCheck={false}
          />
          <textarea className="qc-desc" data-quick-create-body="" placeholder="설명 (markdown, 비워도 됩니다)" rows={3} value={form.body} readOnly={locked} onChange={(event) => model.update({ body: event.target.value })} />
          <div className="qc-chips">
            <span className="qc-anchor">
              <button type="button" className="qc-chip qc-chip-parent" data-quick-create-parent="" disabled={locked} onClick={() => setMenu(menu === 'parent' ? null : 'parent')}>
                부모 · {parent === null ? '부모 없음' : `${parent.key} ${parent.title}`}
              </button>
              {menu === 'parent' ? (
                <div className="tasks-menu qc-menu qc-menu-wide" data-qc-menu="parent" role="menu">
                  <button type="button" className="tasks-menu-row" data-quick-create-parent-row="" onClick={() => { model.update({ parentId: null }); setMenu(null) }}><span className="tasks-menu-name">부모 없음</span></button>
                  {parents.length === 0 ? <div className="tasks-menu-note">이 종류를 자식으로 받는 작업이 없습니다</div> : null}
                  {parents.map((item) => (
                    <button key={item.id} type="button" className="tasks-menu-row" data-quick-create-parent-row={item.key} onClick={() => { model.update({ parentId: item.id }); setMenu(null) }}>
                      <span className="qc-key">{item.key}</span>
                      <span className="tasks-menu-name">{item.title}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
            <span className="qc-anchor">
              <button type="button" className="qc-chip" data-quick-create-status={statusKey ?? ''} disabled={locked || ready === null} onClick={() => setMenu(menu === 'status' ? null : 'status')}>
                {status === null ? null : <StatusCircle category={status.category} fill={0.5} size={9} />}
                {status?.label ?? '상태'}
              </button>
              {menu === 'status' ? (
                <div className="tasks-menu qc-menu" data-qc-menu="status" role="menu">
                  {options.map((entry) => (
                    <button key={entry.key} type="button" className={`tasks-menu-row${entry.key === statusKey ? ' is-on' : ''}`} data-quick-create-status-row={entry.key} onClick={() => { model.update({ statusKey: entry.key }); setMenu(null) }}>
                      <StatusCircle category={entry.category} fill={0.5} size={9} />
                      <span className="tasks-menu-name">{entry.label}</span>
                    </button>
                  ))}
                  {note === null ? null : <div className="tasks-menu-note" data-quick-create-status-note="">{note}</div>}
                </div>
              ) : null}
            </span>
            <button
              type="button"
              className="qc-chip"
              data-quick-create-priority={form.priority ?? 'none'}
              title="누를 때마다 바뀜"
              disabled={locked}
              onClick={() => model.update({ priority: PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(form.priority) + 1) % PRIORITY_CYCLE.length] ?? null })}
            >
              <span className="qc-prio-glyph">{form.priority === null ? '–' : (PRIORITY_GLYPH[form.priority] ?? '=')}</span>{priorityText(form.priority)}
            </button>
            {placement === null || placement.state === 'hidden' ? null : (
              <span className="qc-place" role="radiogroup" aria-label="배치" title={placement.state === 'disabled' ? placement.reason : undefined}>
                {PLACEMENTS.map((entry) => (
                  <button key={entry} type="button" role="radio" aria-checked={form.placement === entry} className={`qc-place-opt${form.placement === entry ? ' is-on' : ''}`} data-quick-create-placement={entry} disabled={locked || placement.state === 'disabled'} onClick={() => model.update({ placement: entry })}>
                    {entry === 'board' ? '보드' : '백로그'}
                  </button>
                ))}
              </span>
            )}
          </div>
          {ready !== null && ready.fields.length > 0 ? (
            <div className="qc-required" data-quick-create-required="">
              <div className="qc-required-head">필수 필드 · 이 종류는 아래 칸이 있어야 만들어집니다</div>
              {ready.fields.map((field) => <RequiredField key={field.key} field={field} value={form.values[field.key] ?? ''} locked={locked} onChange={(value) => model.update({ values: { ...form.values, [field.key]: value } })} />)}
            </div>
          ) : null}
          {meta.state === 'error' ? (
            <div className="qc-meta-error" data-quick-create-meta-error="">
              <span>{meta.message}</span>
              <button type="button" className="qc-link" data-quick-create-meta-retry="" onClick={model.retryMeta}>다시 시도</button>
            </div>
          ) : null}
          {modal.notice === null ? null : <div className="qc-notice" data-quick-create-notice="">{modal.notice}</div>}
          {modal.error === null ? null : <div className="qc-error" data-quick-create-error="" role="alert">{modal.error}</div>}
        </div>

        <footer className="qc-foot">
          <button type="button" className="qc-switch" role="switch" aria-checked={modal.another} data-quick-create-another={modal.another ? 'on' : 'off'} onClick={model.toggleAnother}>
            <span className={`qc-track${modal.another ? ' is-on' : ''}`}><span className="qc-thumb" /></span>하나 더 만들기
          </button>
          <span className="tasks-head-spacer" />
          {problem === null ? null : <span className="qc-problem" data-quick-create-problem="">{problem}</span>}
          <button type="button" className="qc-cancel" data-quick-create-cancel="" onClick={() => model.close()}>취소</button>
          <button type="button" className="qc-submit" data-quick-create-submit="" disabled={problem !== null} title={problem ?? undefined} onClick={() => void model.submit()}>
            만들기<span className="qc-kbd">⌘↵</span>
          </button>
        </footer>
      </div>
    </div>
  )
}

function RequiredField({ field, value, locked, onChange }: { field: WorkCreateField; value: string; locked: boolean; onChange: (value: string) => void }): React.JSX.Element {
  return (
    <div className="qc-field" data-quick-create-field={field.key} data-quick-create-field-shape={field.shape}>
      <span className="qc-field-label">{field.label} <span className="qc-star">*</span></span>
      {field.shape === 'text' ? <input className="qc-field-input" value={value} readOnly={locked} onChange={(event) => onChange(event.target.value)} /> : null}
      {field.shape === 'option' ? (
        <span className="qc-place" role="radiogroup" aria-label={field.label}>
          {field.options.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={`qc-place-opt${value === option.id ? ' is-on' : ''}`} data-quick-create-option={option.id} disabled={locked} onClick={() => onChange(option.id)}>{option.label}</button>
          ))}
        </span>
      ) : null}
      {field.shape === 'unsupported' ? <span className="qc-unsupported" data-quick-create-unsupported="">corral 에서 채울 수 없음 — 출처에서 만드세요</span> : null}
    </div>
  )
}

/** 칸 끝의 「+ 추가」 와 한 줄 입력(C7). */
export function InlineAddSlot({ view, model, statusKey, columnId }: { view: InlineAddView; model: QuickCreateModel; statusKey: string; columnId: string }): React.JSX.Element | null {
  if (view.state === 'hidden') return null
  if (view.state === 'disabled') {
    return <button type="button" className="qc-inline-open is-disabled" data-inline-add-open="" aria-disabled title={view.reason} data-inline-add-reason={view.reason} onClick={(event) => event.preventDefault()}>+ 추가</button>
  }
  const draft = view.draft
  if (!view.open || draft === null) {
    return <button type="button" className="qc-inline-open" data-inline-add-open="" onPointerEnter={model.prepareInline} onFocus={model.prepareInline} onClick={() => model.openInline({ statusKey, columnId })}>+ 추가</button>
  }
  const busy = draft.phase !== 'idle'
  return (
    <div className="qc-inline" data-inline-add-wrap="">
      <input
        autoFocus
        className="qc-inline-input"
        data-inline-add=""
        data-inline-add-phase={draft.phase}
        placeholder="제목 — Enter 로 추가, Esc 로 닫기"
        value={draft.text}
        readOnly={busy}
        onChange={(event) => model.setInlineText(event.target.value)}
        onKeyDown={(event) => {
          if (imeComposing(event.nativeEvent)) return
          if (event.key === 'Escape') {
            // 페이지 Esc 단계로 내려가지 않는다 — 입력만 닫는다(보내는 중이면 결과를 보일 때까지 남는다).
            event.preventDefault()
            event.nativeEvent.stopPropagation()
            model.closeInline({ force: !busy })
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            void model.submitInline()
          }
        }}
        onBlur={() => { if (draft.text.trim().length === 0) model.closeInline({ force: false }) }}
      />
      {busy ? <div className="qc-inline-note" data-inline-add-busy="">{draft.phase === 'late' ? '확인 중 — 출처 답을 기다립니다' : '만드는 중…'}</div> : null}
      {draft.error === null ? null : <div className="qc-inline-error" data-inline-add-error="" role="alert">{draft.error}</div>}
    </div>
  )
}
