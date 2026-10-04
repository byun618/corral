// LIFE-496 T4 — 탭바 `+` 드롭다운 (D36 검색 omnibox · D37 정적 생성 메뉴 · D38 에이전트 Quick-launch).
//
// 기준 = Orca v1.4.219 `tab-bar-surface.tsx:201-286`(구성 순서·w-72·닫을 때 포커스) · `TabBarCreateEntry.tsx`(omnibox·키보드) ·
// `TabBarCreateEntryRow.tsx`(결과 행) · `tab-bar-static-create-menu.tsx`(New Terminal) · `QuickLaunchButton.tsx`(에이전트 행).
// 순수 계산(검색·정렬·결과 조립·키보드 이동)은 `tab-create-menu.ts` 에 있고 이 파일은 그리기·이벤트만 한다.
//
// 구성 (Orca 와 같은 순서):
//   [omnibox 입력] [질의 결과 행: 열린 탭 → 메뉴 매칭 → 에이전트 매칭]
//   ── (빈 질의일 때만) ── 새 터미널 ⌘T ── Claude · Codex · Grok
// "Agent settings…"·기본 에이전트 맨 앞·단축키 라벨은 LIFE-450 보류. 파일·URL·히스토리·브라우저·Simulator 는 corral 에 없다(의도적).
//
// 메뉴 라이브러리가 없어 직접 만든다(`ContextMenu.tsx` 와 같은 사정). Radix 에서 가져오는 동작:
//   · 열리면 입력창 포커스(rAF) · Escape 닫기 · 바깥 mousedown·창 blur·다른 메뉴 열림(`menu-bus`)에 닫힌다
//   · 닫을 때 포커스를 `+` 로 **되돌리지 않는다**(Orca `onCloseAutoFocus` preventDefault) — 새 탭이면 새 터미널(493 G1 마운트 포커스)이,
//     Escape 면 이 영역의 터미널이 포커스를 받는다(여는 쪽 `onDismiss`).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMenuBus } from '../menu-bus.js'
import { AGENT_ICON, agentIcon } from '../session-glyphs.js'
import {
  activeOptionId,
  buildActiveOptions,
  buildAgentLaunchOptions,
  selectedIndex,
  showStaticCreateMenu,
  stepSelection,
  stepStaticItem,
  type ActiveOption,
  type LaunchAgent,
  type OpenTabSearchEntry,
  type OpenTabSearchResult,
} from '../tab-create-menu.js'
import { AgentIcon, ShellTileIcon } from './AgentIcon.js'

/** Orca `getTabEntryOmniboxPlaceholder` 의 Orca 한국어 번역(`열린 탭, 방문 기록, 파일, URL, agent 검색…`)에서 corral 에 없는 갈래(방문 기록·파일·URL)를 뺀 문구(K1ⓕ, 의도적 — 범위). */
export const OMNIBOX_PLACEHOLDER = '열린 탭, 에이전트 검색…'
const MARGIN = 8
const RESULT_LISTBOX_ID = 'tab-create-entry-results'
const resultOptionDomId = (index: number): string => `tab-create-entry-result-${index}`

export type TabCreateMenuDismiss = 'escape' | 'outside' | 'blur' | 'menu-bus' | 'action'

/** 정적 메뉴 행 아이콘 — Orca `TerminalSquare` 자리. corral 은 같은 뜻의 기존 셸 타일을 쓴다(새 아이콘 0). */
function TerminalGlyph({ size }: { size: number }): React.JSX.Element {
  return (
    <span className="tab-create-glyph" aria-hidden>
      <ShellTileIcon size={size} />
    </span>
  )
}

function OpenTabIcon({ option }: { option: OpenTabSearchResult }): React.JSX.Element {
  const icon = agentIcon(option.agent)
  if (icon !== null && icon.kind !== 'shell')
    return (
      <span className={`tab-create-agent agent-${icon.kind}`} data-agent-icon={icon.kind} aria-hidden>
        <AgentIcon kind={icon.kind} glyph={icon.glyph} size={14} />
      </span>
    )
  return <TerminalGlyph size={14} />
}

function EntryRow({ option, index, selected, onClick }: { option: ActiveOption; index: number; selected: boolean; onClick: () => void }): React.JSX.Element {
  const presentation = ((): { icon: React.JSX.Element; label: string; detail: string | null } => {
    switch (option.kind) {
      case 'tab':
        return { icon: <OpenTabIcon option={option.option} />, label: '탭으로 전환', detail: option.option.title }
      case 'menu':
        return { icon: <TerminalGlyph size={14} />, label: option.option.label, detail: null }
      case 'agent':
        return {
          icon: (
            <span className={`tab-create-agent agent-${option.option.agent}`} aria-hidden>
              <AgentIcon kind={option.option.agent} glyph={AGENT_ICON[option.option.agent].glyph} size={14} />
            </span>
          ),
          label: '에이전트 실행',
          detail: option.option.label,
        }
    }
  })()
  return (
    <button
      type="button"
      id={resultOptionDomId(index)}
      role="option"
      aria-selected={selected}
      className={`tab-create-entry-row ${selected ? 'is-selected' : ''}`}
      data-tab-create-result={activeOptionId(option)}
      // 입력창 포커스를 지킨다 — 행은 클릭으로만 실행된다(Orca 행도 입력창에서 키보드가 움직인다).
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {presentation.icon}
      <span className={`tab-create-entry-label ${presentation.detail !== null ? 'has-detail' : ''}`}>{presentation.label}</span>
      {presentation.detail !== null ? (
        <>
          <span className="tab-create-entry-dot" aria-hidden>
            ·
          </span>
          <span className="tab-create-entry-detail">{presentation.detail}</span>
        </>
      ) : null}
    </button>
  )
}

export function TabCreateMenu({
  groupId,
  anchor,
  entries,
  newTerminalShortcut,
  onNewTerminal,
  onLaunchAgent,
  onActivateTab,
  onDismiss,
}: {
  groupId: string
  /** `+` 의 화면 사각형 — 그 아래 왼쪽 정렬로 연다(Orca `align="start" sideOffset={6}`). */
  anchor: { left: number; bottom: number }
  /** 현재 worktree 의 열린 탭(모든 영역). */
  entries: readonly OpenTabSearchEntry[]
  newTerminalShortcut: string
  onNewTerminal: () => void
  onLaunchAgent: (agent: LaunchAgent) => void
  onActivateTab: (target: { tabId: string; groupId: string }) => void
  onDismiss: (reason: TabCreateMenuDismiss) => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom + 6 })
  const [query, setQuery] = useState('')
  /** null = 순위를 따른다. 화살표로만 고정한다(Orca `pinnedOptionId`). */
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const agents = useMemo(() => buildAgentLaunchOptions(), [])
  const options = useMemo(() => buildActiveOptions({ query, entries, agents, retainedResultId: pinnedId }), [query, entries, agents, pinnedId])
  const selected = selectedIndex(options, pinnedId)
  const showStatic = showStaticCreateMenu(query)
  const hasQuery = query.trim().length > 0

  const dismiss = useCallback((reason: TabCreateMenuDismiss) => onDismiss(reason), [onDismiss])
  useMenuBus({ open: true, close: () => dismiss('menu-bus') })

  useLayoutEffect(() => {
    const element = rootRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPosition({
      left: Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - rect.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(anchor.bottom + 6, window.innerHeight - rect.height - MARGIN)),
    })
  }, [anchor.left, anchor.bottom, showStatic, options.length])

  // 열리면 입력창으로 (Orca: rAF 뒤 `inputRef.focus()`).
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  // 바깥 mousedown · 창 blur · resize 에 닫힌다. `+` 위 mousedown 은 빼고 `+` 의 click 토글에 맡긴다(닫고 곧바로 다시 여는 것을 막는다).
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target)) return
      if (event.target instanceof Element && event.target.closest(`[data-main-tabbar-add="${CSS.escape(groupId)}"]`) !== null) return
      dismiss('outside')
    }
    const onBlur = (): void => dismiss('blur')
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [dismiss, groupId])

  const run = (option: ActiveOption): void => {
    dismiss('action')
    switch (option.kind) {
      case 'tab':
        onActivateTab({ tabId: option.option.tabId, groupId: option.option.groupId })
        return
      case 'menu':
        onNewTerminal()
        return
      case 'agent':
        onLaunchAgent(option.option.agent)
        return
    }
  }

  const submit = (): void => {
    const option = selected === null ? null : options[selected]
    if (option !== undefined && option !== null) {
      run(option)
      return
    }
    // 빈 질의 Enter = 기본 터미널(Orca `onOpenDefaultTerminal`). 질의가 있는데 결과가 없으면 아무것도 안 한다.
    if (!hasQuery) {
      dismiss('action')
      onNewTerminal()
    }
  }

  const staticItems = (): HTMLButtonElement[] => [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      if (options.length > 0) {
        const next = stepSelection({ count: options.length, current: selected, delta })
        if (next !== null) setPinnedId(activeOptionId(options[next]!))
        return
      }
      // 결과 행이 없으면 아래 정적 메뉴로 포커스를 옮긴다(Orca `focusTabEntryMenuItemAtEdge`) — 입력창에 갇히지 않게.
      const items = staticItems()
      const target = delta === 1 ? items[0] : items.at(-1)
      target?.focus()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  const onItemKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const items = staticItems()
      const at = items.indexOf(event.currentTarget)
      items[stepStaticItem({ count: items.length, current: at, delta: event.key === 'ArrowDown' ? 1 : -1 })]?.focus()
      return
    }
    // 글자를 치면 입력창으로 돌아가 그 글자가 질의가 된다(Radix 의 typeahead 자리 — corral 은 검색이 그 일을 한다).
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) inputRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      className="tab-create-menu"
      role="menu"
      data-tab-create-menu={groupId}
      style={{ left: position.left, top: position.top }}
      // 헤더의 mousedown(영역 활성 → 터미널 포커스)·우클릭 메뉴로 새지 않게 여기서 끊는다. 바깥 닫기는 document 캡처라 영향이 없다.
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={(event) => {
        // 메뉴가 열린 동안 키는 메뉴의 것이다 — 위로 새지 않게(Orca: Escape 만 Radix 로 보낸다).
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          dismiss('escape')
        }
      }}
    >
      <form
        className="tab-create-entry"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="tab-create-entry-input-wrap">
          <input
            ref={inputRef}
            className="tab-create-entry-input"
            data-tab-create-input={groupId}
            value={query}
            placeholder={OMNIBOX_PLACEHOLDER}
            aria-label={OMNIBOX_PLACEHOLDER}
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={options.length > 0 ? RESULT_LISTBOX_ID : undefined}
            aria-autocomplete="list"
            aria-activedescendant={selected !== null ? resultOptionDomId(selected) : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value)
              setPinnedId(null)
            }}
            onKeyDown={onInputKey}
          />
        </div>
        {options.length > 0 || hasQuery ? (
          <div className="tab-create-entry-results" id={RESULT_LISTBOX_ID} role={options.length > 0 ? 'listbox' : undefined}>
            {options.length > 0 ? (
              options.map((option, index) => (
                <EntryRow key={activeOptionId(option)} option={option} index={index} selected={index === selected} onClick={() => run(option)} />
              ))
            ) : (
              // Orca: 결과가 없으면 같은 안내 문구를 상태 행으로 보인다.
              <div className="tab-create-entry-status" data-tab-create-status="">
                {OMNIBOX_PLACEHOLDER}
              </div>
            )}
          </div>
        ) : null}
      </form>
      {showStatic ? (
        <>
          <div className="tab-create-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="tab-create-item"
            data-tab-create-item="new-terminal"
            onClick={() => {
              dismiss('action')
              onNewTerminal()
            }}
            onKeyDown={onItemKey}
          >
            <TerminalGlyph size={16} />
            <span className="tab-create-item-text">새 터미널</span>
            <span className="tab-create-shortcut">{newTerminalShortcut}</span>
          </button>
          <div className="tab-create-sep" role="separator" />
          {agents.map((option) => (
            <button
              key={option.agent}
              type="button"
              role="menuitem"
              className="tab-create-item"
              data-tab-create-item={`agent:${option.agent}`}
              title={`새 터미널에서 ${option.label} 실행`}
              onClick={() => {
                dismiss('action')
                onLaunchAgent(option.agent)
              }}
              onKeyDown={onItemKey}
            >
              <span className={`tab-create-agent agent-${option.agent}`} aria-hidden>
                <AgentIcon kind={option.agent} glyph={AGENT_ICON[option.agent].glyph} size={14} />
              </span>
              <span className="tab-create-item-text">{option.label}</span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  )
}
