// 설정 행 그래마 (LIFE-511 K4) — Orca 198 `SettingsFormControls.tsx`·`SettingsSection.tsx` 의 해부를 옮겼다.
//   SettingsSection        섹션 헤더(h2 + 설명 + 아래 테두리) + 카드
//   SettingsRow            2열 행: 왼쪽 라벨+설명(min-w-0), 오른쪽 컨트롤(shrink-0)
//   SettingsSubsectionHeader  h3 + 옅은 설명 + 오른쪽 액션 자리
//   SettingsSwitch         role=switch 토글 (Space/Enter)
//   SettingsSegmented      role=radiogroup 세그먼트 (←→ 로 옮기며 고른다)
//   SettingsNumberField    숫자 입력 — 입력 중엔 초안, Enter/blur 에 확정·범위 고정, 잘못된 값·Esc 는 직전 값으로(Orca `NumberField`)
//   SettingsColorField     견본(type=color) + hex 입력 — 잘못된 hex 는 확정하지 않는다(Orca `ColorField` + 거부)
//   SettingsDisclosure     「고급」 접기(Orca `AppearanceAdvancedDisclosure`) — 검색 중엔 펼친 채로 둔다
//   SettingsCollapsibleCard 섹션 안 접이 카드(Orca `AppearanceSection` — 아이콘·제목·접힘 요약·화살표)
// T1 소비처: Section·SubsectionHeader(단축키 섹션). Number·Color·Disclosure·CollapsibleCard 는 T2 외관 › 터미널(LIFE-512 K5ⓑ)이 첫 소비처다.
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronRightIcon as ChevronRight } from './SidebarIcons.js'

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

/**
 * 숫자 칸 (LIFE-512 K5ⓑ) — 입력하는 동안은 초안만 바뀌고 **Enter·blur 에서만 확정**한다. 확정 값은 범위에 고정하고 단위에 맞춘다.
 * 확정 순간만 갱신하는 이유: 「1」「6」 을 칠 때 1 이 확정되면 글꼴 1px → 16px 처럼 셀이 두 번 바뀌고 herdr 격자 요청이 두 번 나간다
 * (herdr 는 resize 를 디바운스 없이 PTY 에 바로 적용한다 — 00-analysis §11 W3). 빈 값·숫자 아님·Esc 는 직전 값으로 돌린다.
 */
export function SettingsNumberField({ value, min, max, step, integer = false, onCommit, field, label, suffix, width = 'md' }: {
  value: number
  min: number
  max: number
  step: number
  integer?: boolean
  /** 확정. 저장 결과(Promise<boolean>)를 돌려주면 실패 때 초안을 저장값으로 돌린다(r1 R1-03). */
  onCommit: (next: number) => void | Promise<boolean>
  /** 고정 식별자(`data-settings-number`) — 측정·드라이버의 손잡이. 표시 문구(`label`)와 따로 둔다(r1 R1-06). */
  field: string
  label: string
  suffix?: string
  width?: 'sm' | 'md'
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setDraft(String(value))
  }
  const commit = (): void => {
    const trimmed = draft.trim()
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed)
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    const snapped = integer ? Math.round(clamped) : Math.round(clamped * 1000) / 1000
    setDraft(String(snapped))
    if (snapped === value) return
    const pending = onCommit(snapped)
    if (pending !== undefined) void pending.then((saved) => { if (!saved) setDraft(String(value)) })
  }
  return (
    <span className="settings-number">
      <input
        type="number"
        className={`settings-input settings-number-input is-${width}`}
        data-settings-number={field}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(String(value)) }
        }}
      />
      {suffix === undefined ? null : <span className="settings-suffix">{suffix}</span>}
    </span>
  )
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** `#abc` → `#aabbcc` — `<input type=color>` 는 6자리만 받는다. */
function expandHex(value: string): string {
  return value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : value
}

/**
 * 색 칸 (LIFE-512 K5ⓑ) — 견본(`type=color`)과 hex 입력. hex 는 Enter·blur 에 확정하고 **잘못된 값은 확정하지 않고** 직전 값으로 돌린다
 * (입력 중 잘못된 값이면 `aria-invalid`). 견본은 OS 색 패널이 닫힐 때(네이티브 `change`) 한 번만 확정한다 — 패널을 끄는 동안의
 * 연속 `input` 마다 저장하지 않는다.
 * 견본 노드는 **하나를 계속 쓴다** — 값이 바뀌면 노드를 갈지 않고 `value` 만 맞춘다. 노드를 갈면(예전 `key={value}`) 리스너가 첫 노드에만
 * 붙어 두 번째 선택부터 저장되지 않았다(r1 R1-01).
 */
export function SettingsColorField({ value, onCommit, field, label }: { value: string; onCommit: (next: string) => void | Promise<boolean>; field: string; label: string }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setDraft(value)
  }
  const swatch = useRef<HTMLInputElement>(null)
  const latest = useRef({ value, onCommit })
  latest.current = { value, onCommit }
  useEffect(() => {
    const input = swatch.current
    if (input === null) return
    const onChange = (): void => {
      const next = input.value.toLowerCase()
      if (!HEX.test(next) || next === latest.current.value.toLowerCase()) return
      const pending = latest.current.onCommit(next)
      // 저장 실패면 견본을 저장값으로 돌린다(r1 R1-03) — 저장소가 값을 되돌려도 prop 이 그대로라 동기화 effect 가 안 돈다.
      if (pending !== undefined) void pending.then((saved) => { if (!saved) input.value = expandHex(latest.current.value) })
    }
    input.addEventListener('change', onChange)
    return () => input.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    const input = swatch.current
    if (input !== null && input.value.toLowerCase() !== expandHex(value).toLowerCase()) input.value = expandHex(value)
  }, [value])
  const valid = HEX.test(draft.trim())
  const commit = (): void => {
    const next = draft.trim().toLowerCase()
    if (!HEX.test(next)) { setDraft(value); return }
    setDraft(next)
    if (next === value.toLowerCase()) return
    const pending = onCommit(next)
    if (pending !== undefined) void pending.then((saved) => { if (!saved) setDraft(value) })
  }
  return (
    <span className="settings-color">
      <input ref={swatch} type="color" className="settings-color-swatch" data-settings-color-swatch={field} aria-label={`${label} 견본`} defaultValue={expandHex(value)} />
      <input
        type="text"
        className="settings-input settings-color-input"
        data-settings-color={field}
        aria-label={label}
        aria-invalid={valid ? undefined : true}
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(value) }
        }}
      />
    </span>
  )
}

/** 「고급」 접기 — 닫힌 채 시작한다. `forceOpen`(검색 중)이면 펼친 채 두고 접기를 막는다(Orca 와 같다). */
export function SettingsDisclosure({ label = '고급', forceOpen = false, id, children }: { label?: string; forceOpen?: boolean; id: string; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = open || forceOpen
  return (
    <div className="settings-disclosure" data-settings-disclosure={id}>
      <button type="button" className="settings-disclosure-toggle" aria-expanded={expanded} disabled={forceOpen} onClick={() => setOpen((prev) => !prev)}>
        <ChevronRight className={`settings-disclosure-chevron${expanded ? ' is-open' : ''}`} />
        {label}
      </button>
      {expanded ? <div className="settings-disclosure-body">{children}</div> : null}
    </div>
  )
}

/** 섹션 안 접이 카드 — 펼친 채 시작한다. 접히면 요약 한 줄을 보인다. 검색 중엔 접기를 막는다. */
export function SettingsCollapsibleCard({ id, icon, title, summary, forceOpen = false, children }: { id: string; icon: React.ReactNode; title: string; summary: string; forceOpen?: boolean; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const expanded = open || forceOpen
  const contentId = `settings-card-${id}`
  return (
    <div className={`settings-collapsible${expanded ? ' is-open' : ''}`} data-settings-collapsible={id}>
      <button type="button" className="settings-collapsible-toggle" aria-expanded={expanded} aria-controls={contentId} disabled={forceOpen} onClick={() => setOpen((prev) => !prev)}>
        <span className="settings-collapsible-icon">{icon}</span>
        <span className="settings-collapsible-text">
          <span className="settings-collapsible-title">{title}</span>
          {expanded ? null : <span className="settings-collapsible-summary">{summary}</span>}
        </span>
        <ChevronRight className={`settings-collapsible-chevron${expanded ? ' is-open' : ''}`} />
      </button>
      {expanded ? <div id={contentId} role="region" className="settings-collapsible-body">{children}</div> : null}
    </div>
  )
}
