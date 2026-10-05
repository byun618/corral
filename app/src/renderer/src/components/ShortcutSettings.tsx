import { useEffect, useRef, useState } from 'react'
import { ACTIONS, bindingFromEvent, bindingsFor, formatBinding, type ActionId, type Keybindings } from '../../../shared/keybindings.js'

export function ShortcutSettings({ overrides, onChange, onClose }: { overrides: Keybindings; onChange: (value: Keybindings) => void; onClose: () => void }): React.JSX.Element {
  const [recording, setRecording] = useState<{ id: ActionId; variant: number } | null>(null)
  const [candidate, setCandidate] = useState<{ id: ActionId; variant: number; binding: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const recordingRef = useRef(recording)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const firstButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    firstButton.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      const current = recordingRef.current
      if (current === null) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current() }
        // Keep keyboard navigation inside the dialog.
        if (event.key === 'Tab') {
          const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-shortcut-settings] button:not(:disabled)')]
          const index = buttons.findIndex((button) => button === document.activeElement)
          event.preventDefault()
          buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
        }
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        recordingRef.current = null
        setRecording(null)
        void window.corral.setShortcutRecording(false)
        return
      }
      const binding = bindingFromEvent(event)
      if (binding === null) return
      setCandidate({ ...current, binding })
      recordingRef.current = null
      setRecording(null)
      void window.corral.setShortcutRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    const cancel = (): void => {
      recordingRef.current = null
      setRecording(null)
      void window.corral.setShortcutRecording(false)
    }
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancel)
      void window.corral.setShortcutRecording(false)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const save = async (next: Keybindings): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.corral.saveKeybindings(next)
      if (!result.ok) { setError(result.error); return }
      onChange(result.overrides)
      setCandidate(null)
      setError(null)
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  return <div className="shortcut-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="shortcut-settings" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" data-shortcut-settings>
      <header><h2 id="shortcut-title">단축키</h2><button ref={firstButton} onClick={onClose}>닫기</button></header>
      <p>키를 선택해 새 조합을 누르세요. Esc는 기록 취소 · 방향별로 변경할 수 있습니다.</p>
      <div className="shortcut-list">{ACTIONS.map((action) => <div className="shortcut-row" key={action.id} data-shortcut-action={action.id}>
        <strong>{action.title}</strong>
        {/* 칸 수는 기본 조합 수 — 비켜 선 기본값(LIFE-470 ⌘J)은 빈 칸(「없음」)으로 남아 다시 배정할 수 있다. */}
        <div className="shortcut-bindings">{action.defaultBinding.map((_, variant) => bindingsFor(action.id, overrides)[variant] ?? null).map((binding, variant) => {
          const capturing = recording?.id === action.id && recording.variant === variant
          const pending = candidate?.id === action.id && candidate.variant === variant ? candidate : null
          return <div key={variant}>
            <span>{action.variants[action.bindingVariants[variant] ?? 0]}</span>
            <button disabled={busy} data-record={action.id} data-variant={variant} aria-label={`${action.title} ${action.variants[action.bindingVariants[variant] ?? 0]} 키 기록`} onClick={async () => {
              setCandidate(null); setError(null)
              // Arm both renderer state and its synchronous ref before the IPC round trip.
              recordingRef.current = { id: action.id, variant }
              setRecording(recordingRef.current)
              try { await window.corral.setShortcutRecording(true) }
              catch (failure) { recordingRef.current = null; setRecording(null); setError(String(failure)) }
            }}>{capturing ? '키 입력… (Esc 취소)' : pending !== null ? formatBinding(pending.binding) : binding !== null ? formatBinding(binding) : '없음'}</button>
            {pending ? <button disabled={busy} data-save-binding onClick={() => {
              // 비켜 선 빈 칸(null)은 빈 칸 그대로 저장한다 — 기본값으로 채우면 그 조합을 쓰는 재정의와 충돌해 저장이 거절된다(fix2 R2-01).
              const bindings = [...bindingsFor(action.id, overrides)]; bindings[variant] = pending.binding
              void save({ ...overrides, [action.id]: bindings })
            }}>저장</button> : null}
          </div>
        })}</div>
        <button data-reset={action.id} disabled={busy || recording !== null || overrides[action.id] === undefined} onClick={() => {
          const next = { ...overrides }; delete next[action.id]; void save(next)
        }}>기본값</button>
      </div>)}</div>
      <div role="status" className="shortcut-error">{error ?? (candidate ? '새 조합을 저장하면 바로 적용됩니다.' : '터미널에 포커스가 있어도 등록된 단축키가 실행됩니다.')}</div>
    </section>
  </div>
}
