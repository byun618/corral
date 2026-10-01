// Workspace options 메뉴 (LIFE-470 · D29a) — 198 `SidebarWorkspaceOptionsMenu.tsx` + `workspace-options-menu-items.tsx:109-239`.
//
// 구획 순서 = 198: 라벨 · Show(Projects) · Group by · Sort by · Project order · [Card layout·Show properties = B 조각 LIFE-477 자리] · Filters.
// 메뉴 라이브러리가 없어(react·xterm 만) 자체 부품이다(00-analysis U6). 198 Radix DropdownMenu 의 동작 중 지키는 것:
//   · `side="right" align="start" sideOffset 8 w-72` — 버튼 오른쪽에 붙고 화면 밖이면 안으로 민다
//   · 라디오·스위치·토글은 고른 뒤에도 메뉴가 열려 있다(198 `:147-190` `onSelect preventDefault`)
//   · 키보드: ↑↓ 항목 이동(끝에서 돈다) · → 서브메뉴 열고 첫 항목 · ← 서브메뉴 닫고 그 트리거로 · Esc 메뉴 전체 닫고 버튼으로 ·
//     Enter/Space = 누르기(항목이 <button> 이라 기본 동작)
//   · 바깥 mousedown 으로 닫힌다. 서브메뉴는 트리거에 마우스를 올리면 열린다
//
// B 조각(Card layout·Show properties·Agent activity layout)은 Project order 와 Filters 사이(198 `:235` 자리, 아래 「B 조각 자리」
// 주석)에 구획을 더한다 — 서브메뉴는 `Submenu` 에 id 를 더하고 `subTrigger`·`RadioItem` 을 그대로 쓴다. RESULT 「B·C 인계」.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RepoRow } from '../../../shared/types.js'
import type { SidebarGroupBy, SidebarProjectOrder, SidebarSortBy, SidebarView } from '../../../shared/sidebar-view.js'
import { activeFilterCount, effectiveRepoFilter, filterBadgeLabel } from '../sidebar-sections.js'
import { CheckIcon, ChevronRightIcon, GitBranchIcon, GitCommitIcon, SlidersIcon } from './SidebarIcons.js'

/** 문구 표 — RESULT 「문구 표」와 같은 값. 198 은 영문 하드코딩, corral 은 한국어 UI(D17). */
export const SORT_OPTIONS: readonly { id: SidebarSortBy; label: string; description: string | null }[] = [
  { id: 'name', label: '이름', description: null },
  { id: 'smart', label: '에이전트 활동', description: '주의가 필요한 에이전트 먼저, 그다음 최근 활동 순.' },
  { id: 'recent', label: '최근', description: null },
  { id: 'repo', label: '프로젝트', description: null },
  { id: 'manual', label: '수동', description: '끌어서 각 그룹 안의 순서를 정한다.' },
]
export const PROJECT_ORDER_OPTIONS: readonly { id: SidebarProjectOrder; label: string; description: string }[] = [
  { id: 'manual', label: '수동', description: '프로젝트를 끌어서 순서를 정한다' },
  { id: 'recent', label: '최근', description: '가장 최근 워크스페이스 활동 순' },
]
export const GROUP_BY_OPTIONS: readonly { id: SidebarGroupBy; label: string }[] = [
  { id: 'none', label: '없음' },
  { id: 'repo', label: '프로젝트' },
]

/** Show › Projects 트리거 값 — 전체 / 한 개면 이름 / N개(198 `SidebarRepositoryFilterSection.tsx:86-100`). */
export function projectFilterLabel(input: { view: SidebarView; repos: readonly RepoRow[] }): string {
  const selected = effectiveRepoFilter(input)
  if (selected.length === 0) return '전체 프로젝트'
  if (selected.length === 1) return input.repos.find((repo) => repo.root === selected[0])?.name ?? '1개 프로젝트'
  return `${selected.length}개 프로젝트`
}

type Submenu = 'projects' | 'sort' | 'project-order'

const ITEM_SELECTOR = '[data-menu-item]:not([disabled])'

export function SidebarOptionsMenu({
  view,
  repos,
  onChange,
}: {
  view: SidebarView
  repos: readonly RepoRow[]
  onChange: (patch: Partial<SidebarView>) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<Submenu | null>(null)
  /** 서브메뉴를 키보드(→·Enter)로 열었으면 첫 항목에 포커스를 옮긴다 — 마우스로 열면 옮기지 않는다(Radix 와 같다). */
  const focusSubmenuRef = useRef(false)
  /** 키보드로 열었으면 첫 항목, 마우스로 열었으면 메뉴 틀에 포커스(Radix DropdownMenu 와 같다 — 마우스 열기에 포커스 링이 안 뜬다). */
  const openedByKeyboardRef = useRef(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<{ left: number; top: number } | null>(null)
  const count = activeFilterCount({ view, repos })

  const close = useCallback((input: { focusButton: boolean }) => {
    setOpen(false)
    setSubmenu(null)
    if (input.focusButton) buttonRef.current?.focus()
  }, [])

  // 바깥 mousedown 으로 닫는다(버튼 자신은 onClick 토글이 맡는다).
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      close({ focusButton: false })
    }
    const onBlur = (): void => close({ focusButton: false })
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, close])

  // 자리 — 198 `side="right" align="start" sideOffset 8`. 화면 아래·오른쪽으로 넘치면 안으로 민다(K2ⓒ).
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const button = buttonRef.current
    const menu = menuRef.current
    if (button === null || menu === null) return
    const anchor = button.getBoundingClientRect()
    const box = menu.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(anchor.right + 8, window.innerWidth - box.width - margin))
    const top = Math.max(margin, Math.min(anchor.top, window.innerHeight - box.height - margin))
    setPosition((prev) => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }))
  })

  useLayoutEffect(() => {
    if (submenu === null) {
      setSubmenuPosition(null)
      return
    }
    const trigger = menuRef.current?.querySelector(`[data-submenu-trigger="${submenu}"]`)
    const panel = submenuRef.current
    if (!(trigger instanceof HTMLElement) || panel === null) return
    const anchor = trigger.getBoundingClientRect()
    const box = panel.getBoundingClientRect()
    const margin = 8
    // 오른쪽에 자리가 없으면 왼쪽으로 뒤집는다(Radix collision).
    const right = anchor.right + 4
    const left = right + box.width + margin <= window.innerWidth ? right : Math.max(margin, anchor.left - 4 - box.width)
    const top = Math.max(margin, Math.min(anchor.top - 4, window.innerHeight - box.height - margin))
    setSubmenuPosition((prev) => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }))
  })

  // 열리면 첫 항목, 키보드로 서브메뉴를 열면 그 첫 항목.
  // 자리가 잡힌 뒤에 옮긴다 — 첫 그림은 자리를 재려고 `visibility: hidden` 이라 그때의 focus() 는 무시된다(격리 run1 실측).
  const positioned = position !== null
  useEffect(() => {
    if (!open || !positioned) return
    if (openedByKeyboardRef.current) menuRef.current?.querySelector<HTMLElement>(`[data-menu-level="main"] ${ITEM_SELECTOR}`)?.focus()
    else menuRef.current?.focus()
  }, [open, positioned])

  // Esc 는 포커스가 어디 있든 받아 메뉴 전체를 닫고 버튼으로 포커스(Radix DropdownMenu 와 같다 — 서브메뉴만 닫는 것은 ←).
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      close({ focusButton: true })
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, close])
  useEffect(() => {
    if (submenu === null || submenuPosition === null || !focusSubmenuRef.current) return
    focusSubmenuRef.current = false
    submenuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus()
  }, [submenu, submenuPosition])

  const openSubmenu = (input: { id: Submenu; focus: boolean }): void => {
    focusSubmenuRef.current = input.focus
    setSubmenu(input.id)
  }

  const moveFocus = (input: { level: HTMLElement; delta: number }): void => {
    const items = [...input.level.querySelectorAll<HTMLElement>(ITEM_SELECTOR)]
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    const next = index < 0 ? (input.delta > 0 ? 0 : items.length - 1) : (index + input.delta + items.length) % items.length
    items[next]?.focus()
  }

  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    const active = document.activeElement
    const inSubmenu = active instanceof Node && submenuRef.current?.contains(active) === true
    const level = inSubmenu ? submenuRef.current : menuRef.current?.querySelector<HTMLElement>('[data-menu-level="main"]')
    if (level === null || level === undefined) return
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        moveFocus({ level, delta: event.key === 'ArrowDown' ? 1 : -1 })
        return
      case 'ArrowRight': {
        if (inSubmenu || !(active instanceof HTMLElement)) return
        const id = active.getAttribute('data-submenu-trigger')
        if (id === 'projects' || id === 'sort' || id === 'project-order') {
          event.preventDefault()
          // hover 로 이미 열린 그 서브메뉴면 상태가 그대로라 포커스 effect 가 다시 돌지 않는다 — 바로 첫 항목으로 옮긴다(R1-07).
          const firstItem = submenu === id && submenuPosition !== null ? submenuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR) : null
          if (firstItem !== null && firstItem !== undefined) firstItem.focus()
          else openSubmenu({ id, focus: true })
        }
        return
      }
      case 'ArrowLeft':
        if (!inSubmenu) return
        event.preventDefault()
        focusTriggerOf(submenu)
        setSubmenu(null)
        return
      case 'Tab':
        // 메뉴 안에 Tab 포커스를 가두지 않는다 — Radix 처럼 메뉴를 닫는다.
        close({ focusButton: false })
        return
    }
  }

  const focusTriggerOf = (id: Submenu | null): void => {
    if (id === null) return
    menuRef.current?.querySelector<HTMLElement>(`[data-submenu-trigger="${id}"]`)?.focus()
  }

  const toggleRepo = (root: string): void => {
    const current = effectiveRepoFilter({ view, repos })
    onChange({ repoFilter: current.includes(root) ? current.filter((item) => item !== root) : [...current, root] })
  }

  const sortLabel = SORT_OPTIONS.find((option) => option.id === view.sortBy)?.label ?? '수동'
  const projectOrderLabel = PROJECT_ORDER_OPTIONS.find((option) => option.id === view.projectOrderBy)?.label ?? '수동'
  const showProjects = repos.length > 1
  const selectedRepos = new Set(effectiveRepoFilter({ view, repos }))

  const subTrigger = (input: { id: Submenu; label: string; value: string }): React.JSX.Element => (
    <button
      type="button"
      className={`options-menu-item options-menu-subtrigger ${submenu === input.id ? 'is-open' : ''}`}
      data-menu-item=""
      data-submenu-trigger={input.id}
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={submenu === input.id}
      onMouseEnter={() => openSubmenu({ id: input.id, focus: false })}
      onClick={() => (submenu === input.id ? setSubmenu(null) : openSubmenu({ id: input.id, focus: true }))}
    >
      <span className="options-menu-label">{input.label}</span>
      <span className="options-menu-value">{input.value}</span>
      <ChevronRightIcon className="options-menu-chevron" />
    </button>
  )

  /** 서브메뉴가 아닌 항목에 마우스가 오면 열린 서브메뉴를 닫는다(Radix 와 같다). */
  const closeSubmenuOnHover = { onMouseEnter: () => setSubmenu(null) }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`repos-header-glyph options-trigger ${open ? 'is-open' : ''}`}
        data-sidebar-options=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={count > 0 ? `워크스페이스 옵션 (필터 ${count}개 켜짐)` : '워크스페이스 옵션'}
        title={count > 0 ? `워크스페이스 옵션 (필터 ${count}개)` : '워크스페이스 옵션'}
        onKeyDown={(event) => {
          // Enter·Space 는 버튼 기본 click 으로 온다(아래 `detail === 0`). ↓ 만 여기서 연다(Radix 트리거와 같다).
          if (open || event.key !== 'ArrowDown') return
          event.preventDefault()
          openedByKeyboardRef.current = true
          setOpen(true)
        }}
        onClick={(event) => {
          if (open) {
            close({ focusButton: false })
            return
          }
          // 키보드로 누른 click 은 detail 이 0 이다 — 그때만 첫 항목에 포커스를 옮긴다.
          openedByKeyboardRef.current = event.detail === 0
          setOpen(true)
        }}
      >
        <SlidersIcon className="options-trigger-icon" />
        {count > 0 ? (
          <span className="options-trigger-badge" data-sidebar-options-badge="" aria-hidden>
            {filterBadgeLabel(count)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="options-menu"
          data-sidebar-options-menu=""
          role="menu"
          aria-label="워크스페이스 옵션"
          tabIndex={-1}
          style={position === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: position.left, top: position.top }}
          onKeyDown={onMenuKeyDown}
        >
          <div data-menu-level="main">
            <div className="options-menu-title">워크스페이스 옵션</div>
            {showProjects ? (
              <>
                <div className="options-menu-section-label">표시</div>
                {subTrigger({ id: 'projects', label: '프로젝트', value: projectFilterLabel({ view, repos }) })}
                <div className="options-menu-sep" role="separator" />
              </>
            ) : null}
            <div className="options-menu-section-label">그룹</div>
            <div className="options-group-toggle" role="radiogroup" aria-label="그룹" data-options-group-by="">
              {GROUP_BY_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`options-group-toggle-item ${view.groupBy === option.id ? 'is-on' : ''}`}
                  data-menu-item=""
                  data-group-by={option.id}
                  role="radio"
                  aria-checked={view.groupBy === option.id}
                  {...closeSubmenuOnHover}
                  onClick={() => onChange({ groupBy: option.id })}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="options-menu-sep" role="separator" />
            {subTrigger({ id: 'sort', label: '정렬', value: sortLabel })}
            {view.groupBy === 'repo' ? subTrigger({ id: 'project-order', label: '프로젝트 순서', value: projectOrderLabel }) : null}
            {/* B 조각 자리 — Card layout · Show properties(198 `WorktreeCardDisplayMenuSection`) */}
            <div className="options-menu-sep" role="separator" />
            <div className="options-menu-section-label">필터</div>
            <FilterSwitch
              icon={<GitBranchIcon className="options-menu-icon" />}
              label="기본 브랜치 숨기기"
              testId="hide-default-branch"
              checked={view.hideDefaultBranch}
              onChange={(next) => onChange({ hideDefaultBranch: next })}
              {...closeSubmenuOnHover}
            />
            <FilterSwitch
              icon={<GitCommitIcon className="options-menu-icon" />}
              label="detached HEAD 숨기기"
              testId="hide-detached-head"
              checked={view.hideDetachedHead}
              onChange={(next) => onChange({ hideDetachedHead: next })}
              {...closeSubmenuOnHover}
            />
          </div>
          {submenu !== null ? (
            <div
              ref={submenuRef}
              className={`options-menu options-submenu ${submenu === 'projects' ? 'is-wide' : ''}`}
              data-options-submenu={submenu}
              role="menu"
              style={submenuPosition === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: submenuPosition.left, top: submenuPosition.top }}
            >
              {submenu === 'sort'
                ? SORT_OPTIONS.map((option) => (
                    <RadioItem
                      key={option.id}
                      label={option.label}
                      title={option.description}
                      checked={view.sortBy === option.id}
                      dataKey={`sort-${option.id}`}
                      onSelect={() => onChange({ sortBy: option.id })}
                    />
                  ))
                : null}
              {submenu === 'project-order'
                ? PROJECT_ORDER_OPTIONS.map((option) => (
                    <RadioItem
                      key={option.id}
                      label={option.label}
                      title={option.description}
                      checked={view.projectOrderBy === option.id}
                      dataKey={`project-order-${option.id}`}
                      onSelect={() => onChange({ projectOrderBy: option.id })}
                    />
                  ))
                : null}
              {submenu === 'projects' ? (
                <>
                  <div className="options-submenu-head">
                    <span>프로젝트</span>
                    <button
                      type="button"
                      className="options-submenu-clear"
                      data-menu-item=""
                      data-options-projects-clear=""
                      disabled={selectedRepos.size === 0}
                      onClick={() => onChange({ repoFilter: [] })}
                    >
                      지우기
                    </button>
                  </div>
                  {repos.map((repo) => (
                    <button
                      key={repo.root}
                      type="button"
                      className="options-menu-item options-check-item"
                      data-menu-item=""
                      data-options-project={repo.root}
                      role="menuitemcheckbox"
                      aria-checked={selectedRepos.has(repo.root)}
                      title={repo.root}
                      onClick={() => toggleRepo(repo.root)}
                    >
                      <span className="options-check-box">{selectedRepos.has(repo.root) ? <CheckIcon className="options-check-icon" /> : null}</span>
                      <span className="options-menu-label">{repo.name}</span>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function RadioItem(props: { label: string; title: string | null; checked: boolean; dataKey: string; onSelect: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="options-menu-item options-radio-item"
      data-menu-item=""
      data-options-radio={props.dataKey}
      role="menuitemradio"
      aria-checked={props.checked}
      title={props.title ?? undefined}
      onClick={props.onSelect}
    >
      <span className="options-radio-mark">{props.checked ? <span className="options-radio-dot" /> : null}</span>
      <span className="options-menu-label">{props.label}</span>
    </button>
  )
}

/** 198 `FilterToggleRow.tsx:30-60` — role="switch", 12px, 오른쪽 스위치. */
function FilterSwitch(props: {
  icon: React.ReactNode
  label: string
  testId: string
  checked: boolean
  onChange: (next: boolean) => void
  onMouseEnter: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="options-menu-item options-switch-row"
      data-menu-item=""
      data-options-filter={props.testId}
      role="switch"
      aria-checked={props.checked}
      onMouseEnter={props.onMouseEnter}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="options-switch-label">
        {props.icon}
        {props.label}
      </span>
      <span className={`options-switch ${props.checked ? 'is-on' : ''}`} aria-hidden>
        <span className="options-switch-thumb" />
      </span>
    </button>
  )
}
