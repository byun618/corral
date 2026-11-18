// 설정 › 단축키 (LIFE-511 K6) — 옛 `ShortcutSettings` 모달을 옮겼다. 동작은 그대로 두고(칸별 기록·「없음」·창 blur 시 기록 취소·
// 기록 중 키는 앱 단축키로 안 감) 198 `ShortcutsPane` 의 꼴을 입혔다: 필터 레일(검색 + All/Modified/Unassigned/Conflicts 카운트) +
// 그룹별 목록 + **저장 전 충돌 표시** + 액션별 기본값·끄기. 영속은 `keybindings.json` 그대로(main `KeybindingStore`).
// Esc 는 기록 중일 때만 여기서 먹는다(기록 취소). 기록 중이 아닐 때의 Esc 는 설정 페이지의 2단계 닫기가 받는다.
import { useEffect, useRef, useState } from 'react'
import { bindingFromEvent, formatBinding, type ActionId, type Keybindings } from '../../../shared/keybindings.js'
import { candidateStatus, SHORTCUT_FILTERS, shortcutFilterCounts, shortcutRows, visibleShortcutGroups, type CandidateStatus, type ShortcutFilter } from '../shortcut-rows.js'
import { SettingsSubsectionHeader } from './SettingsControls.js'
import { SearchIcon } from './SidebarIcons.js'

type Slot = { id: ActionId; variant: number }

export function ShortcutsSection({ overrides, onChange }: { overrides: Keybindings; onChange: (value: Keybindings) => void }): React.JSX.Element {
  const [recording, setRecording] = useState<Slot | null>(null)
  const [candidate, setCandidate] = useState<(Slot & { binding: string }) | null>(null)
  const [status, setStatus] = useState<{ tone: 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ShortcutFilter>('all')
  const recordingRef = useRef<Slot | null>(null)

  const stopRecording = (): void => {
    recordingRef.current = null
    setRecording(null)
    void window.corral.setShortcutRecording(false)
  }

  useEffect(() => {
    // 창 캡처 단계 — 문서 캡처의 앱 단축키 dispatch(useKeybindings)보다 먼저 받아 기록 중 키를 삼킨다.
    const onKey = (event: KeyboardEvent): void => {
      const current = recordingRef.current
      if (current === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') { stopRecording(); return }
      const binding = bindingFromEvent(event)
      if (binding === null) return
      setCandidate({ ...current, binding })
      stopRecording()
    }
    const onBlur = (): void => { if (recordingRef.current !== null) stopRecording() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      if (recordingRef.current !== null) stopRecording()
    }
  }, [])

  const save = async (input: { next: Keybindings; done: string }): Promise<void> => {
    const { next, done } = input
    setBusy(true)
    try {
      const result = await window.corral.saveKeybindings(next)
      if (!result.ok) { setStatus({ tone: 'error', text: result.error }); return }
      onChange(result.overrides)
      setCandidate(null)
      setStatus({ tone: 'info', text: done })
    } catch (failure) {
      setStatus({ tone: 'error', text: String(failure) })
    } finally {
      setBusy(false)
    }
  }

  const rows = shortcutRows(overrides)
  const counts = shortcutFilterCounts({ rows, query })
  const groups = visibleShortcutGroups({ rows, filter, query })
  const visibleCount = groups.reduce((sum, group) => sum + group.rows.length, 0)
  const pending: CandidateStatus | null = candidate === null ? null : candidateStatus({ overrides, ...candidate })

  return (
    <div className="shortcuts-pane" data-shortcuts-section>
      <SettingsSubsectionHeader title="키보드 단축키" description="키를 눌러 새 조합을 기록하세요. 터미널에 포커스가 있어도 등록된 단축키가 실행됩니다." />
      <div className="shortcuts-layout">
        <aside className="shortcuts-rail" data-shortcuts-rail>
          <div className="shortcuts-rail-search">
            <div className="shortcuts-rail-head">
              <label htmlFor="shortcut-filter-search">단축키 검색</label>
              <span data-shortcuts-visible-count>{visibleCount}/{rows.length}</span>
            </div>
            <div className="settings-search-field is-small">
              <SearchIcon className="settings-search-icon" />
              <input id="shortcut-filter-search" data-shortcuts-search value={query} placeholder="명령 또는 키 검색" onChange={(event) => setQuery(event.target.value)} />
            </div>
          </div>
          <nav className="shortcuts-filters" aria-label="단축키 상태 필터">
            <p className="shortcuts-filters-title">상태</p>
            {SHORTCUT_FILTERS.map((option) => (
              <button key={option.id} type="button" aria-pressed={filter === option.id} className={`shortcuts-filter${filter === option.id ? ' is-active' : ''}`} data-shortcuts-filter={option.id} onClick={() => setFilter(option.id)}>
                <span>{option.label}</span>
                <span className="shortcuts-filter-count" data-shortcuts-filter-count={option.id}>{counts[option.id]}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="shortcuts-list" data-shortcuts-list>
          {groups.length === 0 ? <div className="shortcuts-empty" data-shortcuts-empty>그 조건에 맞는 단축키가 없습니다.</div> : groups.map((group) => (
            <div key={group.title} className="shortcuts-group" data-shortcut-group={group.title}>
              <h3>{group.title}</h3>
              {group.rows.map((row) => {
                const id = row.action.id
                const rowPending = candidate !== null && candidate.id === id ? pending : null
                return (
                  <div key={id} className="shortcut-block" data-shortcut-action={id}>
                    <div className="shortcut-block-head">
                      <span className={`shortcut-title${row.unassigned ? ' is-off' : ''}`}>{row.action.title}</span>
                      {row.modified ? <span className="shortcut-badge" data-shortcut-modified>Modified</span> : null}
                      {row.unassigned ? <span className="shortcut-badge is-muted" data-shortcut-unassigned>없음</span> : null}
                      <span className="shortcut-block-actions">
                        <button type="button" className="shortcut-text-button" data-disable={id} disabled={busy || recording !== null || row.unassigned || row.slots.length === 0} onClick={() => void save({ next: { ...overrides, [id]: row.slots.map(() => null) }, done: `「${row.action.title}」 단축키를 껐습니다.` })}>끄기</button>
                        <button type="button" className="shortcut-text-button" data-reset={id} disabled={busy || recording !== null || !row.modified} onClick={() => {
                          const next = { ...overrides }
                          delete next[id]
                          void save({ next, done: `「${row.action.title}」 을 기본값으로 되돌렸습니다.` })
                        }}>기본값</button>
                      </span>
                    </div>
                    <div className="shortcut-slots">
                      {row.slots.map((slot) => {
                        const capturing = recording?.id === id && recording.variant === slot.variant
                        const slotPending = candidate !== null && candidate.id === id && candidate.variant === slot.variant ? candidate : null
                        const shown = capturing ? '키 입력… (Esc 취소)' : slotPending !== null ? formatBinding(slotPending.binding) : slot.binding !== null ? formatBinding(slot.binding) : '없음'
                        return (
                          <div key={slot.variant} className="shortcut-slot">
                            {row.slots.length > 1 ? <span className="shortcut-slot-label">{slot.label}</span> : null}
                            <button
                              type="button"
                              className={`shortcut-recorder${capturing ? ' is-recording' : ''}${slotPending !== null ? ' is-pending' : ''}${slot.binding === null && slotPending === null ? ' is-empty' : ''}`}
                              disabled={busy}
                              data-record={id}
                              data-variant={slot.variant}
                              aria-label={`${row.action.title} ${slot.label} 키 기록`}
                              onClick={async () => {
                                setCandidate(null)
                                setStatus(null)
                                // 렌더 상태와 동기 ref 를 IPC 왕복 전에 같이 켠다 — 그 사이 키가 와도 기록으로 간다.
                                recordingRef.current = { id, variant: slot.variant }
                                setRecording(recordingRef.current)
                                try { await window.corral.setShortcutRecording(true) } catch (failure) { stopRecording(); setStatus({ tone: 'error', text: String(failure) }) }
                              }}
                            >
                              {shown}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                    {rowPending === null || candidate === null ? null : (
                      <div className={`shortcut-pending${rowPending.kind === 'conflict' ? ' is-conflict' : ''}`} data-shortcut-pending={rowPending.kind}>
                        <span className="shortcut-pending-text" data-shortcut-conflict={rowPending.kind === 'conflict' ? '' : undefined}>
                          {rowPending.kind === 'conflict' ? `${rowPending.message} — 이대로는 저장되지 않습니다.` : rowPending.kind === 'displaces' ? `${formatBinding(candidate.binding)} 를 쓰면 「${rowPending.title}」 기본값은 「없음」 이 됩니다.` : rowPending.kind === 'same' ? '지금 조합과 같습니다.' : `${formatBinding(candidate.binding)} 로 바꿉니다.`}
                        </span>
                        <button type="button" className="shortcut-text-button is-primary" data-save-binding disabled={busy || (rowPending.kind !== 'ok' && rowPending.kind !== 'displaces')} onClick={() => {
                          if (rowPending.kind === 'ok' || rowPending.kind === 'displaces') void save({ next: rowPending.next, done: `「${row.action.title}」 = ${formatBinding(candidate.binding)} 저장했습니다.` })
                        }}>저장</button>
                        <button type="button" className="shortcut-text-button" data-cancel-binding onClick={() => setCandidate(null)}>취소</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div role="status" className={`shortcuts-status${status?.tone === 'error' ? ' is-error' : ''}`} data-shortcuts-status>{status?.text ?? ''}</div>
    </div>
  )
}
