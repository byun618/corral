// 설정 행 그래마 (LIFE-511 K4) — Orca 198 `SettingsFormControls.tsx`·`SettingsSection.tsx` 의 해부를 옮겼다.
//   SettingsSection        섹션 헤더(h2 + 설명 + 아래 테두리) + 카드
//   SettingsRow            2열 행: 왼쪽 라벨+설명(min-w-0), 오른쪽 컨트롤(shrink-0)
//   SettingsSubsectionHeader  h3 + 옅은 설명 + 오른쪽 액션 자리
//   SettingsSwitch         role=switch 토글 (Space/Enter)
//   SettingsSegmented      role=radiogroup 세그먼트 (←→ 로 옮기며 고른다)
// T1 소비처: Section·SubsectionHeader(단축키 섹션). Row·Switch·Segmented 는 T2(일반·외관) 첫 소비처를 위해 지금 둔다(K4ⓐ) —
// Color·Number 필드는 소비처가 없어 T2 로 미뤘다(K4ⓑ, RESULT).
import { useId, useRef } from 'react'

export function SettingsSection({ id, title, description, fill = false, children }: { id: string; title: string; description: string; fill?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className={`settings-section${fill ? ' is-fill' : ''}`} data-settings-section={id} aria-labelledby={`settings-section-${id}`}>
      <header className="settings-section-header" data-settings-section-header>
        <div className="settings-section-heading">
          <h2 id={`settings-section-${id}`}>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div className="settings-card" data-settings-card>
        {children}
      </div>
    </section>
  )
}

export function SettingsRow({ label, description, control, labelId }: { label: React.ReactNode; description?: React.ReactNode; control: React.ReactNode; labelId?: string }): React.JSX.Element {
  return (
    <div className={`settings-row${description === undefined ? '' : ' has-description'}`} data-settings-row>
      <div className="settings-row-text">
        <div className="settings-row-label" id={labelId}>{label}</div>
        {description === undefined ? null : <p className="settings-row-description">{description}</p>}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  )
}

export function SettingsSubsectionHeader({ title, description, action }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="settings-subsection-header" data-settings-subsection-header>
      <div className="settings-subsection-text">
        <h3>{title}</h3>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {action === undefined ? null : <div className="settings-subsection-action">{action}</div>}
    </div>
  )
}

export function SettingsSwitch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`settings-switch${checked ? ' is-on' : ''}`}
      data-settings-switch
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch-thumb" />
    </button>
  )
}

export type SegmentedOption<T extends string> = { value: T; label: React.ReactNode; disabled?: boolean }

/**
 * 라디오 그룹 — 선택된 칸만 Tab 정지점이고(roving tabindex), ←→ 가 다음 고를 수 있는 칸으로 옮겨 고른다.
 * 비활성 칸은 Orca 처럼 `aria-disabled` 로 둔다(native disabled 는 포커스를 못 받아 이유 설명을 못 본다).
 */
export function SettingsSegmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly SegmentedOption<T>[]; onChange: (next: T) => void; label: string }): React.JSX.Element {
  const group = useRef<HTMLDivElement>(null)
  const name = useId()
  const enabled = options.filter((option) => option.disabled !== true)
  const move = (delta: number): void => {
    const index = enabled.findIndex((option) => option.value === value)
    const next = enabled[(index + delta + enabled.length) % enabled.length]
    if (next === undefined) return
    onChange(next.value)
    group.current?.querySelector<HTMLButtonElement>(`[data-segment-value="${next.value}"]`)?.focus()
  }
  return (
    <div ref={group} role="radiogroup" aria-label={label} className="settings-segmented" data-settings-segmented={name}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={option.disabled === true ? true : undefined}
            tabIndex={active ? 0 : -1}
            data-segment-value={option.value}
            className={`settings-segment${active ? ' is-active' : ''}`}
            onClick={() => { if (option.disabled !== true) onChange(option.value) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(1) }
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
