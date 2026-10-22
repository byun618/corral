import { useBindingLabel } from '../hooks/BindingLabels.js'
// design-handoff.md §2 MainTabBar — **활성 workspace 가 있으면 탭 수와 무관하게 존재**한다
// (01-criteria.md 부록 C5′ / 11-gate1-fix3.md I-5). 마운트 조건은 `App.tsx` 의
// `activeWorkspace !== null` 하나뿐이고, 이 파일엔 탭 수 조건이 **없다**.
//
// 전 버전 주석은 "`sessionCount >= 2` 일 때만 존재(Orca 규칙)" 였는데 **그 근거가 사실이 아니었다.**
// 부록이 인용한 Orca `use-app-chrome-layout.ts:74` 의 `hasTabBar = tabCount >= 2` 는 같은 파일
// `:139` 의 타이틀바 확장 버튼 조건에만 쓰인다 — 탭 스트립을 가르는 상수가 아니다. Orca 는 탭
// 1개에서도 스트립을 그린다. 사용자 지시(*"하나만 있어도 저런식으로 나올 수 있게"*)와 이 사실
// 정정으로 C5 가 C5′ 로 개정됐다. 증명해야 할 상태는 2개(1/N)에서 **3개(0/1/N)** 로 늘었다.
//
// 활성 탭은 배경이 터미널과 이어지고, 비활성은 톤 차이로만. 우측 고정 `+`(빈 탭) · 활성 worktree 라벨.
//
// 닫기(×)는 탭 자체에 둔다 — 수정 1회차(07-fix-orca1.md M-2) 코디네이터 결정: freeze 된 C5 본문이
// "전환·생성(+)·닫기" 를 메인 탭바 위에서 요구하는데 1차 구현은 SessionRow(사이드바)의 닫기로
// 갈음했다. 그건 고정 문구 재해석이라 관문 ③ 위반 — `-claude` 형제 브랜치는 탭바에 닫기가 있어
// 같은 저울로 비교되지 않는다. 항상 DOM 에 있다(조건부 렌더링하면 좌표 클릭 계측이 hover 없이는 못 찾는다).
//
// **탭 모양·선두·닫기 = Orca 1.4.198** (LIFE-493 T1, 값 출처 `specs/LIFE-493-tabbar/raw/coordinator/c4-orca198-tabbar-inventory.md` §2~§4):
// 고정 폭 180(≥1280 220)·최소 72 · 높이 = 탭바 줄 · 활성 = fg 6% + 하단 2px(fg 100% — LIFE-494 #24010, T1 은 60%) · 비활성은 글자만 흐리다(hover 시 밝게) ·
// 선두 = 벨 → 상태 점(+로고) → 로고 → 셸 아이콘(`tab-status.ts`) · 닫기 16px 는 활성 탭 상시, 비활성은 hover · 중클릭 닫기.
// 좁아도 탭을 접지 않는다(compact 폐지) — 대신 스트립이 가로로 스크롤된다.
//
// **넘침 = Orca v1.4.219 + #24276** (LIFE-494 T2, `hooks/useTabStripOverflow.ts`): chevron(넘칠 때만) · 페이드 1.5rem · 끝에 붙기 + 스크롤 앵커 ·
// 스크롤 썸 · 활성 탭 dock(시야 밖이면 지나간 가장자리에 붙는다).
//
// **인라인 리네임**(11-gate1-fix3.md I-7): 탭을 더블클릭하면 제목 자리에서 바로 고친다.
// 이름은 herdr 가 들고 있다 — `tab.rename` 한 번 보내면 `tab_renamed` 로 돌아오고 재기동해도
// 남는다. corral 쪽 저장 계층은 없다. 사이드바 세션 행에는 **안 달았다**: 그 행은 단일 클릭이
// 이미 "이 세션 활성화"를 쓰고 있어 더블클릭이 그 위에 겹치고, 무엇보다 `sessionTitle` 을
// 공유하므로 탭에서 바꾼 이름이 사이드바에 **그대로 따라 나온다** — 입구를 두 개 둘 이유가 없다.
//
// 탭 제목은 사이드바 SessionRow 와 **같은 함수**를 쓴다(`session-title.ts`) — 09-gate1-fix.md C-3
// "세션 제목이 곧 탭 제목이다". 탭바가 받는 목록 자체는 사이드바와 다르다: 여기는 그 worktree 의
// **전체 탭**(셸 포함), 사이드바는 에이전트 세션만 (01-criteria.md 부록 "세션 용어 확정").
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TabRow } from '../../../shared/types.js'
import { AGENT_ICON, agentIcon } from '../session-glyphs.js'
import { tabLeading, type TabAgentKind, type TabLeading } from '../tab-status.js'
import { AgentIcon, ShellTileIcon } from './AgentIcon.js'
import { AgentStateDot, PlusIcon } from './AgentStateDot.js'
import { FILLED_BELL_PATH } from './WorktreeStatusSlot.js'
import { sessionTitle, tabAgent, userLabel } from '../session-title.js'
import { tabOrdinals } from '../fallback-ordinal.js'
import { TabContextMenu, type MoveDirection, type TabMenuAnchor } from './TabContextMenu.js'
import { TabMenuIcon } from './TabMenuIcon.js'
import { closeScopeTargets, tabMenuModel, type CloseScope } from '../tab-actions.js'
import { SplitIcon } from './SplitIcon.js'
import { TabStripScrollIndicator } from './TabStripScrollIndicator.js'
import { useTabStripOverflow, type TabStripOverflow } from '../hooks/useTabStripOverflow.js'
import { tabStripMaskClassName } from '../tab-strip-metrics.js'
import type { LaunchAgent, OpenTabSearchEntry } from '../tab-create-menu.js'
import { TabCreateMenu } from './TabCreateMenu.js'
import { FileIcon } from './ExplorerIcons.js'
import { ContextMenu, type MenuEntry } from './ContextMenu.js'
import { fileTabDescriptions, fileTabLabel } from '../file-tabs.js'
import './file-view.css'

/**
 * 활성 터미널로 포커스를 돌려준다 (J-1).
 *
 * xterm 은 자기 **보조 textarea** 가 포커스를 쥐어야 키를 받는다. `TerminalPane` 은 선택된
 * pane 하나만 마운트하므로(`.term-host` 가 화면에 하나) 셀렉터 하나로 찾는다 — 여기서
 * `term.focus()` 를 부를 길이 없다(그 인스턴스는 `TerminalPane` 안에 갇혀 있다).
 * 터미널이 없는 상태(빈 workspace)면 아무것도 안 한다 — 그때는 포커스가 body 로 가고
 * 문서 단축키는 살아 있다.
 */
function focusActiveTerminal(): void {
  const textarea = document.querySelector('.term-host textarea')
  if (textarea instanceof HTMLTextAreaElement) textarea.focus()
}

/**
 * 선두의 에이전트 로고 — Orca `TerminalTabAgentIdentityIcon`: 12px, 비활성 탭은 70%(`opacity-70`).
 * 로고만 서는 탭(`solo`)은 Orca 처럼 묶음 없이 로고 자신이 `mr-1` 을 갖는다(`TerminalTabLeadingIcon.tsx:87-91`).
 */
function TabAgentLogo({ agent, solo = false }: { agent: TabAgentKind; solo?: boolean }): React.JSX.Element {
  return (
    <span className={`main-tab-agent agent-${agent} ${solo ? 'is-solo' : ''}`} data-agent-kind={agent} aria-hidden>
      <AgentIcon kind={agent} glyph={AGENT_ICON[agent].glyph} size={12} />
    </span>
  )
}

/**
 * 탭 선두 (Orca `TerminalTabLeadingIcon.tsx:46-104`) — 벨(+로고) → 상태 점 md(+로고) → 로고만 → 셸 아이콘.
 * 표식 속성은 Orca 의 것과 짝이 되게 단다(측정 도구가 같은 의미끼리 짝짓는다): 벨 `data-tab-unread-bell` ↔ `tab-activity-bell`,
 * 상태 묶음 `data-tab-activity` ↔ `tab-agent-activity-indicator`, 로고 `data-agent-kind` ↔ `data-agent-icon`, 셸 `data-shell-icon`.
 */
function TabLeadingIcon({ leading }: { leading: TabLeading }): React.JSX.Element {
  switch (leading.kind) {
    case 'bell':
      return (
        <span className="main-tab-leading" data-tab-unread-bell="" aria-label="확인 안 된 완료">
          <svg className="main-tab-bell" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={FILLED_BELL_PATH} />
          </svg>
          {leading.agent === null ? null : <TabAgentLogo agent={leading.agent} />}
        </span>
      )
    case 'dot':
      return (
        <span className="main-tab-leading" data-tab-activity={leading.dot}>
          <AgentStateDot dot={leading.dot} />
          {leading.agent === null ? null : <TabAgentLogo agent={leading.agent} />}
        </span>
      )
    case 'agent':
      return <TabAgentLogo agent={leading.agent} solo />
    case 'shell':
      return (
        <span className="main-tab-shell" data-shell-icon="generic" aria-hidden>
          <ShellTileIcon size={12} />
        </span>
      )
  }
}

function MainTab({
  tab,
  tabCount,
  home,
  selectedPane,
  active,
  dock,
  unreadPanes,
  hasTabsToRight,
  groupTabOrder,
  pinnedTabs,
  color,
  renameRequest,
  onSelect,
  onClose,
  onRename,
  onRequestRename,
  onClearName,
  onSplitPane,
  onMoveToGroup,
  otherGroups,
  onMoveToOtherGroup,
  onTogglePin,
  onCloseScope,
  onSetColor,
  onDragStart,
  menuHost,
}: {
  tab: TabRow
  /**
   * 이 워크스페이스의 **탭 수** — herdr 기본 label(`1..탭수` 의 자리 번호) 판별에 쓴다 (G7).
   * 자리 하나가 아니라 수인 이유는 `session-title.userLabel` 주석에 있다(닫는 과도기).
   */
  tabCount: number
  /** 셸 폴백이 경로를 접는 데 쓴다 (C9). `AppState.home` 그대로다. */
  home: string
  /** 지금 화면에 뜬 pane (C14) — 그 pane 이 제목을 몬다. */
  selectedPane: string | null
  active: boolean
  /**
   * 활성 탭이 스트립 가장자리에 붙는가 (LIFE-494 D27, Orca #24010 `useTabStripSlotProps`) — sticky 라 스크롤 밖으로 나가면
   * 지나간 쪽 가장자리에 붙는다. 드래그 중엔 끈다: 드롭 자리는 화면 사각형에서 오는데 붙은 탭은 이웃 탭과 겹친다.
   */
  dock: boolean
  /** 확인 안 된 완료가 있는 pane (LIFE-471 장부) — 탭 벨·워시·done 점의 출처. */
  unreadPanes: ReadonlySet<string>
  /** 오른쪽에 탭이 더 있나 — Orca 처럼 탭 사이 세로 줄을 마지막 탭에는 안 긋는다(`getTabStripBorderClasses`). */
  hasTabsToRight: boolean
  /** LIFE-495 — 이 영역의 시각 순서·핀 탭(메뉴 항목 상태 `tabMenuModel` 의 입력). */
  groupTabOrder: readonly string[]
  pinnedTabs: ReadonlySet<string>
  /** LIFE-495 K4 — 탭 색(없으면 null). 제목 뒤 8px 점. */
  color: string | null
  /** LIFE-495 — 이름 편집 요청(⌘R·헤더 메뉴 「제목 바꾸기」). 값이 바뀔 때마다 편집을 연다 — 0 은 요청 없음. */
  renameRequest: number
  onSelect: () => void
  onClose: () => void
  onRename: (label: string) => void
  /** 메뉴 「제목 바꾸기」 — 편집은 `renameRequest` 로 연다(⌘R 과 같은 길). 탭 선택은 바꾸지 않는다(더블클릭과 같다). */
  onRequestRename: () => void
  /** LIFE-366 F1 — 사용자가 준 이름 지우기. 메뉴에서만 닿는다. */
  onClearName: () => void
  /** LIFE-373 ② — 이 탭 안에서 pane 분할 (herdr). LIFE-495 F7 — **이 탭**을 쪼갠다(비활성이면 먼저 활성으로). */
  onSplitPane: (direction: 'right' | 'down') => void
  /** LIFE-373 ① — 이 탭을 빼내 새 영역으로 (화면). LIFE-495 K1ⓒ — 4방향. */
  onMoveToGroup: (direction: MoveDirection) => void
  /** LIFE-387 A1 — 다른 영역 목록("다른 영역으로 옮기기" 메뉴 섹션). */
  otherGroups: { groupId: string; label: string }[]
  onMoveToOtherGroup: (targetGroupId: string) => void
  /** LIFE-495 K3 — 핀/핀 해제. */
  onTogglePin: () => void
  /** LIFE-495 K2 — 다른/오른쪽/왼쪽 탭 닫기. */
  onCloseScope: (scope: CloseScope) => void
  /** LIFE-495 K4 — 탭 색(null = 없음). */
  onSetColor: (color: string | null) => void
  /** LIFE-387 A1 — 드래그 무장(mousedown). 6px 넘기 전엔 평소 클릭과 다르지 않다. */
  onDragStart: (event: React.MouseEvent) => void
  /**
   * 우클릭 메뉴를 그릴 DOM 자리 = 탭바 줄(`[data-main-tabbar]`, 헤더 메뉴와 같은 자리) — LIFE-494. 탭 안(스트립 안)에 그리면
   * 스트립의 페이드 마스크가 스트립 밖으로 나간 메뉴(`position: fixed`)를 잘라 보이지도 눌리지도 않는다(격리 예행 k4-iso/2 실측).
   * 포털이라 React 이벤트 버블링(탭의 onClick·onMouseDown 등)은 그대로다.
   */
  menuHost: HTMLElement | null
}): React.JSX.Element {
  // LIFE-366 F2 — 우클릭 메뉴. 좌표를 들고 있는다(탭바에는 `⋯` 버튼을 놓을 폭이 없다).
  const [menu, setMenu] = useState<TabMenuAnchor | null>(null)
  // 인라인 리네임 (I-7). **입력칸은 항상 DOM 에 있다** — 조건부 렌더링하면 좌표 클릭 계측이
  // 없는 요소를 못 누른다(MainTab 닫기 버튼·SessionRow 와 같은 결). 대신 평소엔 투명하고
  // `pointer-events: none` 이라 라벨 클릭을 가로채지 않는다.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // 편집 중인가를 **ref 로도** 들고 있는다 — Esc 로 끈 직후 blur 가 한 박자 늦게 오는데,
  // state 는 그 시점에 아직 옛값일 수 있다. blur 가 취소를 확정으로 되돌리면 안 된다.
  const editingRef = useRef(false)

  /**
   * **편집을 시작한 시점의** 씨앗 (J-2). `seed` 는 렌더마다 다시 계산되므로 확정 시점 값과
   * 비교하면 안 된다 — 에이전트 탭은 제목이 계속 바뀌어서(`Claude Code` → `NOTES.md 파일 생성`,
   * I-3 실측), 아무것도 안 친 확정이 "그때 보이던 제목"을 사용자 이름으로 **굳혀** 버린다.
   * 가드가 막으려던 일이 가드를 통과해 일어나던 자리다.
   */
  const seedAtEditRef = useRef('')

  // 폴백 번호는 **사이드바와 같은 배정표**에서 온다 (C10) — 두 목록이 다른 번호를 그리면
  // 같은 세션이 두 이름으로 보인다 (B6).
  const ordinal = tabOrdinals.ordinalFor({ tabId: tab.tabId, groupId: tab.workspaceId })
  const seed = sessionTitle({ tab, tabCount, ordinal, home, selectedPaneId: selectedPane })
  const beginEdit = (): void => {
    seedAtEditRef.current = seed
    setDraft(seed)
    editingRef.current = true
    setEditing(true)
  }
  /**
   * 편집을 끝내고 **키보드를 돌려준다** (J-1, fix3 리뷰 H1).
   *
   * 입력칸이 `opacity:0; pointer-events:none` 이 돼도 **DOM 포커스는 남는다.** 그대로 두면
   * 터미널 입력과 문서 단축키(⌘T)가 죽는다 — xterm 은 자기 textarea 가 포커스여야 받고,
   * `TerminalPane` 의 `term.focus()` 는 `[paneId]` effect 안이라 같은 탭을 리네임하면 다시 안 돈다.
   *
   * ⚠ 포커스를 **조건부로** 되돌린다: 지금 포커스를 쥔 게 이 입력칸일 때만. blur 확정 경로는
   * 사용자가 다른 데를 **일부러 누른** 것이라(사이드바 검색칸 등) 거기서 포커스를 뺏으면 안 된다.
   */
  const endEdit = (): void => {
    editingRef.current = false
    setEditing(false)
    const input = inputRef.current
    if (input === null || document.activeElement !== input) return
    input.blur()
    focusActiveTerminal()
  }
  /**
   * 확정. 공백만이면 **취소**다 (이름 지우기는 별개 기능 — I-7 ③ 범위 밖).
   * **편집 시작 시점의** 씨앗과 같으면 요청을 보내지 않는다 (J-2).
   *
   * `endEdit()` 이 `blur()` 를 부르므로 `editingRef` 를 **먼저** 내린다 — 안 그러면 그 blur 가
   * `onBlur` → `commit` 으로 되돌아와 두 번 확정된다.
   */
  const commit = (): void => {
    if (!editingRef.current) return
    const next = draft.trim()
    endEdit()
    if (next.length === 0 || next === seedAtEditRef.current) return
    onRename(next)
  }

  useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [editing])
  // LIFE-495 — ⌘R·헤더 메뉴의 「제목 바꾸기」. 요청이 올 때마다(값이 바뀔 때) 더블클릭과 같은 `beginEdit` 으로 연다.
  // 처리한 요청 값을 기억한다 — 탭이 다른 영역으로 옮겨 다시 마운트돼도 지난 요청으로 편집이 저절로 열리지 않게.
  // 0 = 요청 없음(다른 탭이 요청을 받으면 이 탭 값은 0 으로 돌아온다) — 열지 않는다(fix1 R1-01: 0 복귀를 새 요청으로 읽어
  // 앞 탭 편집이 다시 열리고 뒤 탭의 편집 포커스를 빼앗았다). 토큰은 App 이 단조 증가로 준다.
  const beginEditRef = useRef(beginEdit)
  beginEditRef.current = beginEdit
  const handledRenameRef = useRef(renameRequest)
  useEffect(() => {
    if (renameRequest === 0 || renameRequest === handledRenameRef.current) return
    handledRenameRef.current = renameRequest
    beginEditRef.current()
  }, [renameRequest])
  const pinned = pinnedTabs.has(tab.tabId)
  // H-6 을 탭바에도 적용한다(구현자 판단) — 사이드바와 탭바가 같은 세션을 다른 기호로 보이면
  // 두 목록을 짝지어 읽을 수 없다. 그래서 선두의 상태 점은 사이드바 행과 **같은 함수**로 고른다(`tab-status.ts`).
  // 탭바는 **셸 탭도** 보여주므로 에이전트가 없는 탭은 셸 아이콘으로 떨어뜨린다(Orca `ShellIcon`).
  const kind = agentIcon(tabAgent(tab) ?? 'shell')
  const leading = tabLeading({ tab, unreadPanes })
  // LIFE-387 B1 F-B1-5 — 툴팁이 드래그를 안내한다(§2 "탭 툴팁"). 상태 라벨은 사용자 카피라 한글로 —
  // AgentStatus 자체(herdr 타입)를 노출하지 않는다.
  const statusLabel: Record<typeof tab.agentStatus, string> = { idle: '대기', working: '작업 중', blocked: '막힘', done: '완료', unknown: '알 수 없음' }
  const tooltip = editing ? undefined : `${seed} · ${kind?.label ?? '셸'} · ${statusLabel[tab.agentStatus]} — 끌어서 옮기기`
  return (
    <div
      className={`main-tab ${active ? 'is-active' : ''} ${hasTabsToRight ? 'has-right' : ''}`}
      data-main-tab={tab.tabId}
      data-active={active ? 'true' : 'false'}
      data-active-tab-dock={dock ? '' : undefined}
      title={tooltip}
      data-tab-editing={editing ? 'true' : 'false'}
      data-tab-pinned={pinned ? 'true' : 'false'}
      data-tab-color={color ?? undefined}
      // LIFE-387 A1 — 편집 중엔 무장하지 않는다(캐럿 드래그와 겹친다). 문턱(6px)을 안 넘기면
      // 이 mousedown 은 그냥 뒤따르는 click 으로 남는다 — `preventDefault` 를 안 쓰는 이유.
      onMouseDown={(event) => {
        // 중클릭 — 자동 스크롤을 막기만 하고 **여기서 닫지 않는다**(Orca `SortableTab.tsx:206-211`: 떼기 전에 요소를 지우면
        // Linux X11 붙여넣기가 난다). 닫기는 `onAuxClick`.
        if (event.button === 1) {
          event.preventDefault()
          return
        }
        if (editingRef.current) return
        // 닫기(×) 위 mousedown 은 무장하지 않는다 — 안 그러면 누르고 6px 밀린 뒤 떼는
        // 손짓이 닫기 대신 드래그로 잡힌다(keepFocusOnHeaderBackground 와 같은 결).
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        onDragStart(event)
      }}
      onClick={onSelect}
      // D14 중클릭 닫기 (Orca `SortableTab.tsx:213-225`). 편집 중엔 안 닫는다. 핀 탭은 무시한다(LIFE-495 K3ⓑ, 220 `:215-227`).
      onAuxClick={(event) => {
        if (event.button !== 1 || editingRef.current || pinned) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        beginEdit()
      }}
      // 우클릭은 **선택을 바꾸지 않는다** — 메뉴만 연다 (OS 탭바 관습).
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setMenu({ tabId: tab.tabId, x: event.clientX, y: event.clientY })
      }}
    >
      {active ? <span className="main-tab-indicator" aria-hidden /> : null}
      {/* 안 읽음 워시 — Orca 처럼 실제 DOM 자식이다(`::after` 는 드롭 표시와 겹친다). 벨이 보일 때만(라이브 상태면 둘 다 숨는다). */}
      {leading.kind === 'bell' ? <span className="main-tab-unread-wash" aria-hidden /> : null}
      <TabLeadingIcon leading={leading} />
      {/* LIFE-495 K3ⓐ — 핀 탭은 제목 앞 핀(220 `Pin` size-3 · mr-1 · muted). 편집 중엔 숨긴다. */}
      {pinned && !editing ? <TabMenuIcon kind="pin" size={12} className="main-tab-pin" /> : null}
      <span className="main-tab-title">
        <span className="main-tab-label">{seed}</span>
        {/* LIFE-495 K4ⓑ — 제목 뒤 8px 색 점(220 `size-2 rounded-full mr-1.5`). 편집 중엔 숨긴다. */}
        {color === null || editing ? null : <span className="main-tab-color-dot" data-tab-color-dot={color} style={{ backgroundColor: color }} />}
        {/* 라벨 위에 겹쳐 놓는다 — 탭 폭·높이를 안 건드리려고 absolute 다 (C9(b) 핀 높이 보호).
            라벨 칸(`.main-tab-title`) 안에 겹치므로 선두 표시가 바뀌어도(벨·점·로고) 자리가 따라온다.
            ⚠ 클릭·마우스다운도 막는다: 안 막으면 커서를 옮기려는 클릭이 `.main-tab` 의 onClick
            으로 올라가 pane 을 바꾸고, 그 바람에 입력칸이 blur 돼 편집이 스스로 끝난다
            (I-6 에서 잡은 버블링 함정과 같은 모양이다). */}
        <input
          ref={inputRef}
          className={`main-tab-rename ${editing ? 'is-editing' : ''}`}
          data-tab-rename={tab.tabId}
          value={editing ? draft : seed}
          tabIndex={editing ? 0 : -1}
          aria-hidden={!editing}
          readOnly={!editing}
          onChange={(event) => setDraft(event.target.value)}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onBlur={commit}
          onKeyDown={(event) => {
            // ⚠ **편집 중이 아니면 아무것도 안 한다** (J-1 두 번째 방어선). 어떤 이유로든 포커스가
            // 이 입력칸에 남았을 때 `stopPropagation` 이 무조건 걸리면 ⌘T 같은 문서 단축키가 죽는다.
            // 포커스 반환(endEdit)과 **둘 다** 한다 — 하나가 새도 나머지가 막는다.
            if (!editingRef.current) return
            // 편집 중 키는 여기서 끝난다 — 문서에 달린 ⌘T·Esc 리스너로도, 터미널로도 안 간다.
            event.stopPropagation()
            if (event.key === 'Enter') commit()
            else if (event.key === 'Escape') endEdit()
          }}
        />
      </span>
      {/* 닫기 — 활성 탭은 상시, 비활성은 탭 hover 때(CSS). Orca 처럼 글자색으로 숨긴다(`text-transparent`).
          LIFE-495 K3ⓑ — 핀 탭에는 없다(220 `SortableTab.tsx:325` `!isEditing && !isPinned`). */}
      {pinned ? null : <button
        className="main-tab-close"
        data-main-tab-close={tab.tabId}
        data-tab-close-button="true"
        type="button"
        title="탭 닫기"
        aria-label={`탭 닫기 ${seed}`}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>}
      {menu === null || menuHost === null ? null : createPortal(
        <TabContextMenu
          anchor={menu}
          model={tabMenuModel({ tabOrder: groupTabOrder, tabId: tab.tabId, pinned: pinnedTabs })}
          hasUserName={userLabel({ tab, tabCount }) !== null}
          color={color}
          otherGroups={otherGroups}
          onRename={onRequestRename}
          onClearName={onClearName}
          onSplitPane={onSplitPane}
          onMoveToGroup={onMoveToGroup}
          onMoveToOtherGroup={onMoveToOtherGroup}
          onTogglePin={onTogglePin}
          onClose={onClose}
          onCloseScope={onCloseScope}
          onSetColor={onSetColor}
          onDismiss={() => setMenu(null)}
        />,
        menuHost,
      )}
    </div>
  )
}

/**
 * 탭바 안 한 칸 (LIFE-590 E1) — 터미널 탭(herdr `TabRow`) 또는 파일 탭. 영역 배치의 `tabOrder` 순서 그대로 섞여 선다.
 * 파일 탭의 `deleted` = 외부에서 지워짐(E5ⓒ — 표시는 F2 본구현에서 채운다). `dirty` = 저장하지 않은 수정이 있음(LIFE-591 E1ⓑ — 닫기 자리에 점).
 */
export type GroupTabItem = { kind: 'terminal'; tab: TabRow } | { kind: 'file'; tabId: string; rel: string; preview: boolean; deleted: boolean; dirty: boolean }

type FileTabMenuAction = 'close' | 'keep' | 'close-others' | 'close-right' | 'split-right' | 'split-down' | `move:${string}`

/**
 * 파일 탭 (LIFE-590 E2·E10) — 칸·높이·활성 표시·닫기 자리는 터미널 탭(`.main-tab`)과 같고, 안쪽은 VS Code 편집기 탭:
 * Seti 파일 아이콘(탐색기와 같은 `FileIcon`) · 파일 이름 · **미리보기 = 이탤릭**(VS Code `.monaco-icon-label.italic`) · 닫기 버튼 자리에
 * 수정 점(닫기 단추 자리 — LIFE-591). 더블클릭 = 고정(VS Code·Orca), 중클릭 = 닫기.
 * 터미널 탭의 이름 바꾸기·핀·색·서수·pane 분할은 파일 탭에 없다 — 메뉴에서도 뺐다(E3ⓗ, 무동작 항목 0).
 */
function FileTab({
  item,
  description,
  active,
  dock,
  hasTabsToRight,
  otherGroups,
  onSelect,
  onClose,
  onKeep,
  closeScopes,
  onCloseScope,
  onMoveToGroup,
  onMoveToOtherGroup,
  onDragStart,
}: {
  item: Extract<GroupTabItem, { kind: 'file' }>
  /** 같은 영역에 같은 이름 파일 탭이 있을 때 붙는 부모 폴더 설명(LIFE-689 — `fileTabDescriptions`). 없으면 null. */
  description: string | null
  active: boolean
  dock: boolean
  hasTabsToRight: boolean
  otherGroups: { groupId: string; label: string }[]
  onSelect: () => void
  onClose: () => void
  onKeep: () => void
  /** 「다른/오른쪽 탭 닫기」를 누를 수 있나 — 닫을 대상이 없으면 비활성(터미널 탭 메뉴와 같은 규칙, K2ⓑ). */
  closeScopes: { others: boolean; right: boolean }
  onCloseScope: (scope: 'others' | 'right') => void
  onMoveToGroup: (direction: MoveDirection) => void
  onMoveToOtherGroup: (targetGroupId: string) => void
  onDragStart: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const label = fileTabLabel(item.rel)
  const entries: MenuEntry<FileTabMenuAction>[] = [
    { kind: 'item', action: 'close', label: '닫기' },
    { kind: 'item', action: 'close-others', label: '다른 탭 닫기', disabled: !closeScopes.others },
    { kind: 'item', action: 'close-right', label: '오른쪽 탭 닫기', disabled: !closeScopes.right },
    ...(item.preview ? [{ kind: 'item' as const, action: 'keep' as const, label: '고정(미리보기 끄기)' }] : []),
    { kind: 'sep', key: 'split' },
    { kind: 'item', action: 'split-right', label: '오른쪽 새 영역으로 옮기기' },
    { kind: 'item', action: 'split-down', label: '아래 새 영역으로 옮기기' },
    ...(otherGroups.length === 0
      ? []
      : [
          { kind: 'sep' as const, key: 'other' },
          ...otherGroups.map((group) => ({ kind: 'item' as const, action: `move:${group.groupId}` as const, label: `영역으로 옮기기 — ${group.label}` })),
        ]),
  ]
  return (
    <div
      className={`main-tab main-tab-file ${active ? 'is-active' : ''} ${hasTabsToRight ? 'has-right' : ''} ${item.preview ? 'is-preview' : ''} ${item.deleted ? 'is-deleted' : ''} ${item.dirty ? 'is-dirty' : ''} ${description === null ? '' : 'has-desc'}`}
      data-main-tab={item.tabId}
      data-file-dirty={item.dirty ? 'true' : 'false'}
      data-file-tab={item.rel}
      data-active={active ? 'true' : 'false'}
      data-active-tab-dock={dock ? '' : undefined}
      data-tab-preview={item.preview ? 'true' : 'false'}
      title={`${item.rel}${item.preview ? ' · 미리보기' : ''}${item.deleted ? ' · 삭제됨' : ''}${item.dirty ? ' · 수정됨' : ''} — 끌어서 옮기기`}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          return
        }
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        onDragStart(event)
      }}
      onClick={onSelect}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onKeep()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        window.corral.activateWindow()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {active ? <span className="main-tab-indicator" aria-hidden /> : null}
      <FileIcon name={label} />
      <span className="main-tab-title">
        <span className="main-tab-label main-tab-file-label">{label}</span>
        {description === null ? null : <span className="main-tab-file-desc">{description}</span>}
      </span>
      {/* 수정 점(LIFE-591 E1ⓑ) — VS Code `.tab.dirty > .tab-actions`·Orca 처럼 **닫기 단추 자리**에 채운 원, 탭 hover·단추 포커스면 닫기(×). 단추 안 `::before` 로 그린다(file-view.css). */}
      <button
        className="main-tab-close"
        data-main-tab-close={item.tabId}
        data-tab-close-button="true"
        type="button"
        title="탭 닫기"
        aria-label={`탭 닫기 ${label}${item.dirty ? ' (수정됨)' : ''}`}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
      {menu === null ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={entries}
          attrs={{ 'data-file-tab-menu': item.rel }}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            setMenu(null)
            if (action === 'close') onClose()
            else if (action === 'keep') onKeep()
            else if (action === 'close-others') onCloseScope('others')
            else if (action === 'close-right') onCloseScope('right')
            else if (action === 'split-right') onMoveToGroup('right')
            else if (action === 'split-down') onMoveToGroup('down')
            else onMoveToOtherGroup(action.slice('move:'.length))
          }}
        />
      )}
    </div>
  )
}

/** chevron 아이콘 — Orca `ChevronLeft`·`ChevronRight`(lucide) 14px(`size-3.5`). */
function ChevronIcon({ direction }: { direction: 'start' | 'end' }): React.JSX.Element {
  return (
    <svg className="tab-strip-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={direction === 'start' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  )
}

/**
 * 넘칠 때만 있는 좌우 chevron (LIFE-494 D22, Orca `tab-bar-surface.tsx`). 한쪽 끝이면 그쪽은 비활성 — 단 탭 드래그 중엔 비활성으로
 * 두지 않는다(비활성 버튼은 포인터 이벤트를 안 받아 hover 자동 스크롤이 못 걸린다). 클릭 = 폭 75% 스텝, 드래그 중 hover = 180ms 마다 스텝.
 */
function TabStripChevron({
  groupId,
  direction,
  overflow,
  dragActive,
}: {
  groupId: string
  direction: 'start' | 'end'
  overflow: TabStripOverflow
  dragActive: boolean
}): React.JSX.Element {
  const canScroll = direction === 'start' ? overflow.metrics.canScrollStart : overflow.metrics.canScrollEnd
  const label = direction === 'start' ? '탭 왼쪽으로 스크롤' : '탭 오른쪽으로 스크롤'
  return (
    <button
      className="tab-strip-chevron"
      data-tab-strip-chevron={direction}
      data-group-chevron={groupId}
      type="button"
      title={label}
      aria-label={label}
      aria-disabled={!canScroll}
      disabled={!dragActive && !canScroll}
      onClick={() => overflow.scrollByStep({ direction })}
      onPointerEnter={() => overflow.onDragScrollEnter(direction)}
      onPointerLeave={overflow.onDragScrollLeave}
    >
      <ChevronIcon direction={direction} />
    </button>
  )
}

/**
 * 영역 하나의 헤더 (LIFE-373 핸드오프 §2 GroupHeader).
 *
 * LIFE-357 의 `MainTabBar` 가 그대로 여기로 왔다. 바뀐 것 셋:
 *   · 활성 탭을 **영역이 정한다**(`activeTabId`) — 포커스 pane 에서 파생시키지 않는다 (R3-a).
 *     비포커스 영역도 자기 탭을 보여야 하는데 파생시키면 그 영역엔 활성 탭이 없다.
 *   · worktree 라벨을 **뺐다** (R3-g·L-②) — 모든 영역이 한 worktree 를 공유하므로 정보가 없다.
 *     그 자리는 상태바 `corral / {worktree}` 와 사이드바 선택 블록이 맡는다.
 *   · 우측 **액션**(`▥ ▤ ⤢ ✕`) — 평소 opacity 0, 활성 영역/hover/줌 에서 1. 자리는 항상 점유한다.
 */
/**
 * 헤더 **빈 배경**(과 탭 자체)을 누를 때 포커스가 `body` 로 새는 것을 막는다 — **A8 · G4′-a**.
 *
 * 기전은 `TerminalPane.keepTerminalFocus` 와 **같다**(`raw/claude/probe-focus-mech.json` 실측):
 * 영역은 켜지고 `term.focus()` 도 불리는데, 포커스를 못 받는 `div` 위의 `mousedown` **기본
 * 동작**이 그 뒤에 포커스를 `body` 로 옮긴다. 그래서 배지는 옮겨가고 **키는 아무 데도 안 간다.**
 *
 * 기준 §R33-3 은 이걸 **안 고치기로** 했었다 — 헤더에는 이름 바꾸기 입력칸·버튼이 있어 조건이
 * 하나 더 붙고, 어긋나면 지금 되는 길이 깨지기 때문이다. 사용자 지시로 뒤집혔고(§R35-3),
 * **그 조건이 이 한 줄이다**: 포커스를 받을 수 있는 자손 위면 손대지 않는다. 그래야
 * 이름 바꾸기 캐럿(G4′-b)과 헤더 버튼(G4′-c)이 그대로 산다.
 *
 * `stopPropagation` 은 쓰지 않는다 — 문서 `mousedown` 으로 닫는 메뉴들이 안 닫힌다.
 */
function keepFocusOnHeaderBackground(event: React.MouseEvent): void {
  if (!(event.target instanceof Element)) return
  if (event.target.closest('button, input, textarea, select, a[href], [contenteditable="true"], [tabindex]') !== null) return
  event.preventDefault()
}

export function GroupHeader({
  groupId,
  headSpacer = false,
  tailToggle = null,
  tabs,
  items,
  onSelectFileTab,
  onCloseFileTab,
  onKeepFileTab,
  onCloseFileScope,
  workspaceTabCount,
  home,
  selectedPane,
  activeTabId,
  activeGroup,
  unreadPanes,
  paneCount,
  grid,
  zoomed,
  onActivate,
  onSelectTab,
  onCreateShell,
  onCloseTab,
  onRenameTab,
  onClearTabName,
  onSplitPane,
  onSplitTab,
  onMoveToGroup,
  pinnedTabs,
  tabColorOf,
  renameRequest,
  onRequestRename,
  onTogglePin,
  onCloseScope,
  onSetTabColor,
  onZoom,
  onClosePane,
  onCloseGroup,
  otherGroups,
  onMoveToOtherGroup,
  onTabDragStart,
  tabDragActive,
  openTabEntries,
  onLaunchAgent,
  onOpenAgentSettings,
  onActivateOpenTab,
}: {
  groupId: string
  /** LIFE-527 D5 — 사이드바가 접혀 머리가 이 탭 줄 위에 떠 있다(왼쪽 위 영역만). 머리 폭만큼 no-drag 여백을 앞에 둔다. */
  headSpacer?: boolean
  /** LIFE-589 — 오른쪽 패널이 닫혀 있을 때 여는 버튼(오른쪽 위 영역 탭 줄 끝만, Orca `TitlebarMainStrip` 의 `RightSidebarToggle` 자리). */
  tailToggle?: React.ReactNode
  /** **이 영역에 배정된** 터미널 탭들 (R3-c) — worktree 전체가 아니다. */
  tabs: TabRow[]
  /**
   * LIFE-590 — 터미널·파일 탭을 배치 순서대로 섞은 칸. 주면 탭바는 이것을 그린다(없으면 `tabs` 만 — 터미널만 있던 때와 같다).
   * 파일 탭 동작은 아래 셋으로 받는다.
   */
  items?: GroupTabItem[]
  onSelectFileTab?: (tabId: string) => void
  onCloseFileTab?: (tabId: string) => void
  /** 미리보기 파일 탭 고정(탭 더블클릭·메뉴). */
  onKeepFileTab?: (tabId: string) => void
  /** 파일 탭 메뉴의 「다른/오른쪽 탭 닫기」 — 섞인 탭(파일·터미널)을 App 이 종류별로 나눠 닫는다. */
  onCloseFileScope?: (input: { tabId: string; scope: 'others' | 'right' }) => void
  /** herdr 기본 위치 라벨 판별용 — **워크스페이스 전체** 탭 수다 (G7, `tabs.length` 와 다르다 —
   * `tabs` 는 이 영역 로컬이라 그 길이를 쓰면 범위가 좁아져 기본 label 이 이름으로 샌다). */
  workspaceTabCount: number
  /** 셸 탭 폴백이 경로를 접는 데 쓴다 (C9). */
  home: string
  selectedPane: string | null
  activeTabId: string | null
  /** 이 영역이 포커스 영역인가 — 액션 노출과 탭 라벨 색이 갈린다. */
  activeGroup: boolean
  /** 확인 안 된 완료가 있는 pane (LIFE-471 `useUnread`) — 탭 벨·워시. */
  unreadPanes: ReadonlySet<string>
  /** 이 영역 활성 탭의 pane 수 — `⤢`·`✕`(pane) 는 2개 이상일 때만 뜬다. */
  paneCount: number
  /** 선택 pane 의 **내용** 셀 수. 장식 행 메타가 철회돼 이 자리가 유일한 격자 표시다 (§10-R21-1b). */
  grid: { cols: number; rows: number } | null
  zoomed: boolean
  /** 헤더 아무 데나 누르면 이 영역이 활성이 된다 (F1-3). */
  onActivate: () => void
  onSelectTab: (tab: TabRow) => void
  onCreateShell: () => void
  onCloseTab: (tab: TabRow) => void
  onRenameTab: (input: { tab: TabRow; label: string; tabCount: number }) => void
  onClearTabName: (tab: TabRow) => void
  /** 헤더 액션 ▥▤ — 이 영역 **선택 pane** 을 쪼갠다(기존). */
  onSplitPane: (direction: 'right' | 'down') => void
  /** LIFE-495 F7 — 메뉴의 pane 분할은 **우클릭한 탭**을 쪼갠다(비활성이면 먼저 활성으로). 헤더 모드는 활성 탭. */
  onSplitTab: (input: { tab: TabRow; direction: 'right' | 'down' }) => void
  onMoveToGroup: (input: { tabId: string; direction: MoveDirection }) => void
  /** LIFE-495 K3 — 핀 탭(전 영역 공통 집합). */
  pinnedTabs: ReadonlySet<string>
  /** LIFE-495 K4 — 탭 색. */
  tabColorOf: (tabId: string) => string | null
  /** LIFE-495 — 이름 편집 요청(⌘R·메뉴). 그 탭만 편집을 연다. */
  renameRequest: { tabId: string; token: number } | null
  onRequestRename: (tabId: string) => void
  onTogglePin: (tab: TabRow) => void
  onCloseScope: (input: { tab: TabRow; scope: CloseScope }) => void
  onSetTabColor: (input: { tab: TabRow; color: string | null }) => void
  onZoom: () => void
  onClosePane: () => void
  /** 영역 닫기 (F1-5) — 영역이 하나뿐이면 `null` 로 줘서 버튼을 안 그린다. */
  onCloseGroup: (() => void) | null
  /** LIFE-387 A1/B1 — 다른 영역 목록(탭 메뉴·헤더 메뉴 공용 "다른 영역으로 옮기기" 섹션). */
  otherGroups: { groupId: string; label: string }[]
  onMoveToOtherGroup: (input: { tabId: string; targetGroupId: string }) => void
  /** LIFE-387 A1 — 탭 mousedown 을 드래그 컨트롤러(App 소유 `useTabDrag`)로 그대로 넘긴다. */
  onTabDragStart: (event: React.MouseEvent, tabId: string) => void
  /** 어느 영역에서든 탭 드래그 중인가 (LIFE-494) — dock 끔·썸 비킴·chevron hover 자동 스크롤. 다른 영역 탭을 끌어와도 이 스트립이 넘겨야 한다. */
  tabDragActive: boolean
  /** LIFE-496 — `+` 메뉴 omnibox 가 찾는 **현재 worktree 의 열린 탭**(모든 영역, Orca: 한 worktree). */
  openTabEntries: readonly OpenTabSearchEntry[]
  /** LIFE-496 D38 — Quick-launch. 이 영역에 그 에이전트 탭을 만든다(기존 `createRow` 경로 + 기동 워치독). */
  onLaunchAgent: (agent: LaunchAgent) => void
  /** LIFE-515 K5 — `+` 메뉴 「Agent 설정…」 → 설정 › AI 기능 › 에이전트. */
  onOpenAgentSettings: () => void
  /** LIFE-496 D36 — omnibox 에서 고른 탭을 그 탭이 속한 영역에서 활성으로 만들고 포커스를 준다. */
  onActivateOpenTab: (target: { tabId: string; groupId: string }) => void
}): React.JSX.Element {
  const bindingLabel = useBindingLabel()
  // LIFE-496 — `+` 드롭다운. 열린 동안 `+` 의 화면 자리를 들고 있다(메뉴가 그 아래 왼쪽 정렬로 선다).
  // 열 때의 활성 탭·선택 pane 을 같이 든다 — 그것이 바뀌면(⌘T 로 새 탭이 섰다 등) 메뉴를 닫는다(아래 effect).
  const [createMenu, setCreateMenu] = useState<{ left: number; bottom: number; activeTabId: string | null; selectedPane: string | null } | null>(null)
  // r3 R3-02 — `+` 메뉴 전용 상태 기반 닫힘. 새 탭이 이 영역에서 활성이 되거나 선택 pane 이 바뀌면 포커스 이벤트 유무와 무관하게 닫는다
  // (focusin 은 창이 시스템 포커스를 가진 동안에만 온다). 전역 단축키 쪽은 건드리지 않는다(R2-02).
  useEffect(() => {
    if (createMenu === null) return
    if (createMenu.activeTabId !== activeTabId || createMenu.selectedPane !== selectedPane) setCreateMenu(null)
  }, [createMenu, activeTabId, selectedPane])
  // 탭 수로 가르지 않는다(C5′). 탭이 0개여도 `+` 가 남는 껍데기를 그린다 — 마지막 탭을 닫았을 때
  // 탭바가 통째로 사라지면 새 탭을 만들 진입점이 같이 사라진다.
  const shown: GroupTabItem[] = items ?? tabs.map((tab) => ({ kind: 'terminal', tab }))
  const overflow = useTabStripOverflow({ activeTabId, layoutKey: shown.map((item) => (item.kind === 'terminal' ? item.tab.tabId : item.tabId)).join('\n'), groupId, dragActive: tabDragActive })
  // LIFE-387 B1 F-B1-1·F-B1-3 — 헤더 모드 메뉴(⊞ · 탭바 빈 곳 우클릭). 활성 탭이 없으면 안 연다
  // (§2 GroupHeader 우클릭 "빈 영역은 열지 않음").
  const [headerMenu, setHeaderMenu] = useState<TabMenuAnchor | null>(null)
  // 탭 메뉴 포털 자리(`MainTab.menuHost`) — 렌더 중에 DOM 을 읽지 않으려고 콜백 ref 로 state 에 받는다.
  const [menuHost, setMenuHost] = useState<HTMLDivElement | null>(null)
  const openHeaderMenu = (point: { x: number; y: number }): void => {
    if (activeTabId === null) return
    setHeaderMenu({ tabId: activeTabId, x: point.x, y: point.y })
  }
  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null
  const activeTabLabel = activeTab?.label ?? ''
  const tabOrder = shown.map((item) => (item.kind === 'terminal' ? item.tab.tabId : item.tabId))
  // LIFE-689 — 같은 이름 구분 설명은 **이 영역의 파일 탭끼리만** 계산한다(VS Code 는 그룹 단위, 터미널 탭은 파일 이름이 없다).
  const fileDescriptions = fileTabDescriptions(shown.flatMap((item) => (item.kind === 'file' ? [item.rel] : [])))
  return (
    <div
      className={`main-tabbar ${activeGroup ? 'is-active-group' : ''}`}
      ref={setMenuHost}
      data-main-tabbar
      data-group-header={groupId}
      onMouseDown={(event) => {
        keepFocusOnHeaderBackground(event)
        onActivate()
      }}
      // LIFE-387 B1 F-B1-3 — 탭바 빈 곳 우클릭 = 헤더 모드 메뉴(VS Code 관용). 탭 자체 우클릭은
      // `MainTab` 이 `stopPropagation` 으로 먼저 가로채므로 여기 안 닿는다.
      onContextMenu={(event) => {
        event.preventDefault()
        openHeaderMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {/* 탭 스트립 — 넘치면 가로로 스크롤된다(스크롤바는 숨긴다, Orca `.terminal-tab-strip`). 넘치면 양옆 chevron·페이드·아래 썸 (LIFE-494).
          순서 = Orca `tab-bar-surface.tsx`: chevron ‹ · [스트립 + 썸] · chevron › · `+`. */}
      {/* LIFE-527 D5 — Orca `TabGroupPanel.tsx:255-265`. Electron 의 drag 히트테스트는 z-index 형제가 아니라 DOM 자손의 no-drag 만 보므로
          떠 있는 머리의 토글이 눌리려면 그 밑 탭 줄에 같은 폭의 no-drag 자리가 있어야 한다. 폭은 떠 있는 머리를 잰 값(--collapsed-sidebar-header-width). */}
      {headSpacer ? <div className="main-tabbar-head-spacer" data-collapsed-head-spacer="" /> : null}
      {overflow.metrics.hasOverflow ? <TabStripChevron groupId={groupId} direction="start" overflow={overflow} dragActive={tabDragActive} /> : null}
      <div className="main-tab-strip-wrap" data-main-tab-strip-wrap={groupId}>
        <div
          className={`main-tab-strip ${tabStripMaskClassName({ metrics: overflow.metrics, dockedSide: overflow.dockSide })}`}
          data-main-tab-strip={groupId}
          data-active-tab-docked={overflow.dockSide ?? undefined}
          ref={overflow.stripRef}
        >
          {shown.map((item, index) => {
            if (item.kind === 'file') return (
            <FileTab
              key={item.tabId}
              item={item}
              description={fileDescriptions.get(item.rel) ?? null}
              active={item.tabId === activeTabId}
              dock={item.tabId === activeTabId && !tabDragActive}
              hasTabsToRight={index < shown.length - 1}
              otherGroups={otherGroups}
              onSelect={() => onSelectFileTab?.(item.tabId)}
              onClose={() => onCloseFileTab?.(item.tabId)}
              onKeep={() => onKeepFileTab?.(item.tabId)}
              closeScopes={{
                others: closeScopeTargets({ tabOrder, tabId: item.tabId, scope: 'others', pinned: pinnedTabs }).length > 0,
                right: closeScopeTargets({ tabOrder, tabId: item.tabId, scope: 'right', pinned: pinnedTabs }).length > 0,
              }}
              onCloseScope={(scope) => onCloseFileScope?.({ tabId: item.tabId, scope })}
              onMoveToGroup={(direction) => onMoveToGroup({ tabId: item.tabId, direction })}
              onMoveToOtherGroup={(targetGroupId) => onMoveToOtherGroup({ tabId: item.tabId, targetGroupId })}
              onDragStart={(event) => onTabDragStart(event, item.tabId)}
            />
            )
            const tab = item.tab
            return (
            <MainTab
              key={tab.tabId}
              tab={tab}
              // 기본 label 은 **이 워크스페이스 탭 수까지의 자리 번호**다 (G7) — 하나로 못 박으면
              // 닫는 과도기에 어긋나 제목이 깜빡인다. 전체 목록 길이여야 한다(거른 목록 아님) — 그래서
              // 이 영역 로컬인 `tabs.length` 가 아니라 `workspaceTabCount` 를 쓴다.
              tabCount={workspaceTabCount}
              home={home}
              selectedPane={selectedPane}
              active={tab.tabId === activeTabId}
              dock={tab.tabId === activeTabId && !tabDragActive}
              unreadPanes={unreadPanes}
              hasTabsToRight={index < shown.length - 1}
              groupTabOrder={tabOrder}
              pinnedTabs={pinnedTabs}
              color={tabColorOf(tab.tabId)}
              renameRequest={renameRequest !== null && renameRequest.tabId === tab.tabId ? renameRequest.token : 0}
              onSelect={() => onSelectTab(tab)}
              onClose={() => onCloseTab(tab)}
              onRename={(label) => onRenameTab({ tab, label, tabCount: workspaceTabCount })}
              onRequestRename={() => onRequestRename(tab.tabId)}
              onClearName={() => onClearTabName(tab)}
              onSplitPane={(direction) => onSplitTab({ tab, direction })}
              onMoveToGroup={(direction) => onMoveToGroup({ tabId: tab.tabId, direction })}
              otherGroups={otherGroups}
              onMoveToOtherGroup={(targetGroupId) => onMoveToOtherGroup({ tabId: tab.tabId, targetGroupId })}
              onTogglePin={() => onTogglePin(tab)}
              onCloseScope={(scope) => onCloseScope({ tab, scope })}
              onSetColor={(color) => onSetTabColor({ tab, color })}
              onDragStart={(event) => onTabDragStart(event, tab.tabId)}
              menuHost={menuHost}
            />
            )
          })}
        </div>
        <TabStripScrollIndicator metrics={overflow.metrics} stripRef={overflow.stripRef} disabled={tabDragActive} />
      </div>
      {overflow.metrics.hasOverflow ? <TabStripChevron groupId={groupId} direction="end" overflow={overflow} dragActive={tabDragActive} /> : null}
      {/* `+` — Orca 는 스트립 바로 뒤 28px 버튼(`tab-bar-surface.tsx:207-217`). **클릭 = 드롭다운**(LIFE-496 게이트 ⓪ Q3 ⓐ, Orca `DropdownMenuTrigger`).
          빈 탭은 ⌘T 와 메뉴 첫 줄(빈 질의 Enter)이 맡는다. 열린 채 다시 누르면 닫힌다. */}
      <button
        className="main-tab-add"
        data-main-tabbar-add={groupId}
        type="button"
        title="새 탭"
        aria-label="새 탭"
        aria-haspopup="menu"
        aria-expanded={createMenu !== null}
        // r3 R3-01 — 메뉴가 열린 동안의 누름은 헤더 활성화로 버블시키지 않는다. 버블하면 활성화 → 터미널 포커스 → 메뉴 focus-out 닫힘 →
        // 뒤 click 이 닫힌 메뉴를 보고 다시 연다. 닫힌 상태의 첫 누름은 그대로 버블해 그 영역을 활성으로 만든다(기존 동작).
        // r4 R4-01 — 왼쪽 누름만 막는다. 오른쪽·가운데 누름은 헤더로 버블해 활성화(터미널 포커스 복귀)와 헤더 메뉴를 그대로 탄다.
        onMouseDown={(event) => {
          if (createMenu !== null && event.button === 0) event.stopPropagation()
        }}
        onClick={(event) => {
          if (createMenu !== null) {
            setCreateMenu(null)
            // 다시 눌러 닫으면 Escape 처럼 이 영역 터미널로 포커스를 돌려준다(누름이 헤더 활성화를 건너뛰었으므로).
            onActivate()
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setCreateMenu({ left: rect.left, bottom: rect.bottom, activeTabId, selectedPane })
        }}
      >
        <PlusIcon className="main-tab-add-icon" />
      </button>
      {createMenu === null ? null : (
        <TabCreateMenu
          groupId={groupId}
          anchor={createMenu}
          entries={openTabEntries}
          newTerminalShortcut={bindingLabel('terminal.new')}
          newAgentShortcut={bindingLabel('terminal.newAgent')}
          onNewTerminal={onCreateShell}
          onLaunchAgent={onLaunchAgent}
          onOpenAgentSettings={onOpenAgentSettings}
          onActivateTab={onActivateOpenTab}
          onDismiss={(reason) => {
            setCreateMenu(null)
            // Escape 는 이 영역의 터미널로 포커스를 돌려준다(K2ⓒ). `+` 로 되돌리지 않는다(Orca `onCloseAutoFocus`). 바깥 클릭은 누른 곳이 포커스를 갖는다.
            if (reason === 'escape') onActivate()
          }}
        />
      )}
      <div className="main-tabbar-spacer" />
      {/* 탭이 아닌 것들(격자 메타·줌 칩·액션)은 한 상자에 담는다 — 늘 자리를 점유하고, 탭 스트립이 그만큼 줄어든다. */}
      <div className="main-tabbar-tail" data-group-tail={groupId}>
        {grid === null ? null : (
          <span className="group-grid-meta" data-group-grid={groupId}>
            {grid.cols}×{grid.rows}
          </span>
        )}
        {zoomed ? (
          <span className="group-zoom-chip" data-group-zoom-chip={groupId}>
            ⤢ {Math.max(0, paneCount - 1)} pane 접힘
          </span>
        ) : null}
        <div className="group-actions" data-group-actions={groupId}>
          <button className="group-action" data-group-split-right={groupId} title={`오른쪽으로 pane 분할 (${bindingLabel('terminal.split')})`} onClick={() => onSplitPane('right')}>
            <SplitIcon kind="pane-right" />
          </button>
          <button className="group-action" data-group-split-down={groupId} title={`아래로 pane 분할 (${bindingLabel('terminal.split', 1)})`} onClick={() => onSplitPane('down')}>
            <SplitIcon kind="pane-down" />
          </button>
          {/* LIFE-387 B1 F-B1-1 — 영역 분할에는 상시 버튼이 하나도 없었다(▥▤는 pane 급).
              ⊞ 하나가 탭 우클릭과 같은 메뉴를 헤더 모드로 연다 (§1 Q2·§2 GroupHeader 액션). */}
          <button
            className="group-action"
            data-group-menu={groupId}
            title="분할 · 옮기기 메뉴 (탭바 우클릭과 같음)"
            onClick={(event) => {
              event.stopPropagation()
              openHeaderMenu({ x: event.clientX, y: event.clientY })
            }}
          >
            ⊞
          </button>
          {paneCount > 1 ? (
            <button
              className={`group-action ${zoomed ? 'is-on' : ''}`}
              data-group-zoom={groupId}
              title={`${zoomed ? '줌 해제' : 'pane 줌'} (${bindingLabel('terminal.zoom')})`}
              onClick={onZoom}
            >
              {zoomed ? '⤡' : '⤢'}
            </button>
          ) : null}
          {paneCount > 1 ? (
            <button className="group-action is-danger" data-group-close-pane={groupId} title="pane 닫기" onClick={onClosePane}>
              ✕
            </button>
          ) : null}
          {shown.length === 0 && onCloseGroup !== null ? (
            <button className="group-action is-danger" data-group-close={groupId} title={`영역 닫기 (${bindingLabel('group.close')})`} onClick={onCloseGroup}>
              ✕
            </button>
          ) : null}
        </div>
        {tailToggle}
      </div>
      {headerMenu === null || activeTab === null ? null : (
        <TabContextMenu
          anchor={headerMenu}
          model={tabMenuModel({ tabOrder, tabId: activeTab.tabId, pinned: pinnedTabs })}
          hasUserName={userLabel({ tab: activeTab, tabCount: workspaceTabCount }) !== null}
          color={tabColorOf(activeTab.tabId)}
          otherGroups={otherGroups}
          headerMode={{ activeTabLabel }}
          onRename={() => onRequestRename(activeTab.tabId)}
          onClearName={() => onClearTabName(activeTab)}
          onSplitPane={(direction) => onSplitTab({ tab: activeTab, direction })}
          onMoveToGroup={(direction) => onMoveToGroup({ tabId: activeTab.tabId, direction })}
          onMoveToOtherGroup={(targetGroupId) => onMoveToOtherGroup({ tabId: activeTab.tabId, targetGroupId })}
          onTogglePin={() => onTogglePin(activeTab)}
          onClose={() => onCloseTab(activeTab)}
          onCloseScope={(scope) => onCloseScope({ tab: activeTab, scope })}
          onSetColor={(color) => onSetTabColor({ tab: activeTab, color })}
          onDismiss={() => setHeaderMenu(null)}
        />
      )}
    </div>
  )
}
