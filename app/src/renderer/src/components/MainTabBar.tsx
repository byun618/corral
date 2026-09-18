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
// 같은 저울로 비교되지 않는다. hover 시에만 보이되 항상 DOM 에 있다(opacity 토글, SessionRow
// 결함 수정과 같은 패턴 — 조건부 렌더링하면 좌표 클릭 계측이 hover 없이는 못 찾는다).
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
import type { TabRow } from '../../../shared/types.js'
import { agentIcon } from '../session-glyphs.js'
import { AgentIcon } from './AgentIcon.js'
import { sessionTitle, tabAgent, userLabel } from '../session-title.js'
import { tabOrdinals } from '../fallback-ordinal.js'
import { TabContextMenu, type TabMenuAnchor } from './TabContextMenu.js'
import { SplitIcon } from './SplitIcon.js'

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

function MainTab({
  tab,
  tabCount,
  home,
  selectedPane,
  active,
  onSelect,
  onClose,
  onRename,
  onClearName,
  onSplitPane,
  onMoveToGroup,
  canMoveToGroup,
  otherGroups,
  onMoveToOtherGroup,
  compact,
  onDragStart,
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
  onSelect: () => void
  onClose: () => void
  onRename: (label: string) => void
  /** LIFE-366 F1 — 사용자가 준 이름 지우기. 메뉴에서만 닿는다. */
  onClearName: () => void
  /** LIFE-373 ② — 이 탭 안에서 pane 분할 (herdr). */
  onSplitPane: (direction: 'right' | 'down') => void
  /** LIFE-373 ① — 이 탭을 빼내 새 영역으로 (화면). */
  onMoveToGroup: (direction: 'row' | 'column') => void
  canMoveToGroup: boolean
  /** LIFE-387 A1 — 다른 영역 목록("다른 영역으로 옮기기" 메뉴 섹션). */
  otherGroups: { groupId: string; label: string }[]
  onMoveToOtherGroup: (targetGroupId: string) => void
  /** 영역이 좁아 **아이콘만**으로 접힌 탭인가 (F1-7). 활성 탭은 절대 접히지 않는다. */
  compact: boolean
  /** LIFE-387 A1 — 드래그 무장(mousedown). 6px 넘기 전엔 평소 클릭과 다르지 않다. */
  onDragStart: (event: React.MouseEvent) => void
}): React.JSX.Element {
  // LIFE-366 F2 — 우클릭 메뉴. 좌표를 들고 있는다(탭바에는 `⋯` 버튼을 놓을 폭이 없다).
  const [menu, setMenu] = useState<TabMenuAnchor | null>(null)
  const [hovered, setHovered] = useState(false)
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
  // H-6 을 탭바에도 적용한다(구현자 판단) — 사이드바와 탭바가 같은 세션을 다른 기호로 보이면
  // 두 목록을 짝지어 읽을 수 없다. 탭바는 **셸 탭도** 보여주므로 에이전트가 없는 탭은 `shell`
  // 아이콘(`$`)으로 떨어뜨린다 — 여기서만 의미가 있는 구분이다(사이드바는 에이전트 세션만 그린다).
  const kind = agentIcon(tabAgent(tab) ?? 'shell')
  /**
   * 접힌 탭은 아이콘만 26px 인데, **이름을 고치는 동안은 편다** — 접힌 상태에서는 리네임
   * 입력칸이 `display: none` 이라 `focus()` 가 안 먹는다. 메뉴 `이름 바꾸기` 가 접힌 탭의
   * 유일한 입구라(더블클릭할 라벨이 없다) 여기서 안 펴면 그 입구가 막힌다.
   */
  const collapsed = compact && !editing
  // LIFE-387 B1 F-B1-5 — 툴팁이 드래그를 안내한다(§2 "탭 툴팁"). 상태 라벨은 사용자 카피라 한글로 —
  // AgentStatus 자체(herdr 타입)를 노출하지 않는다.
  const statusLabel: Record<typeof tab.agentStatus, string> = { idle: '대기', working: '작업 중', blocked: '막힘', unknown: '알 수 없음' }
  const tooltip = editing ? undefined : `${seed} · ${kind?.label ?? '셸'} · ${statusLabel[tab.agentStatus]} — 끌어서 옮기기`
  return (
    <div
      className={`main-tab ${active ? 'is-active' : ''} ${collapsed ? 'is-compact' : ''}`}
      data-main-tab={tab.tabId}
      data-tab-compact={collapsed ? 'true' : 'false'}
      title={tooltip}
      data-tab-editing={editing ? 'true' : 'false'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // LIFE-387 A1 — 편집 중엔 무장하지 않는다(캐럿 드래그와 겹친다). 문턱(6px)을 안 넘기면
      // 이 mousedown 은 그냥 뒤따르는 click 으로 남는다 — `preventDefault` 를 안 쓰는 이유.
      onMouseDown={(event) => {
        if (editingRef.current) return
        // 닫기(×) 위 mousedown 은 무장하지 않는다 — 안 그러면 누르고 6px 밀린 뒤 떼는
        // 손짓이 닫기 대신 드래그로 잡힌다(keepFocusOnHeaderBackground 와 같은 결).
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        onDragStart(event)
      }}
      onClick={onSelect}
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
      <span className={`main-tab-dot tone-${tab.agentStatus === 'working' ? 'accent' : 'neutral'}`} />
      {kind === null ? null : (
        <span className={`main-tab-agent agent-${kind.kind}`} data-agent-kind={kind.kind} title={kind.label}>
          <AgentIcon kind={kind.kind} glyph={kind.glyph} />
        </span>
      )}
      <span className="main-tab-label">{seed}</span>
      {/* 라벨 위에 겹쳐 놓는다 — 탭 폭·높이를 안 건드리려고 absolute 다 (C9(b) 핀 높이 보호).
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
      <button
        className={`main-tab-close ${hovered ? 'is-active' : ''}`}
        data-main-tab-close={tab.tabId}
        title="탭 닫기"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
      {menu === null ? null : (
        <TabContextMenu
          anchor={menu}
          hasUserName={userLabel({ tab, tabCount }) !== null}
          canMoveToGroup={canMoveToGroup}
          otherGroups={otherGroups}
          onRename={beginEdit}
          onClearName={onClearName}
          onSplitPane={onSplitPane}
          onMoveToGroup={onMoveToGroup}
          onMoveToOtherGroup={onMoveToOtherGroup}
          onClose={onClose}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/**
 * 좁은 영역에서 비활성 탭을 **아이콘만**으로 접을지 (F1-7 · 핸드오프 §1-8-a).
 *
 * 탭 폭 합 = `탭 수 × (--tab-min-w 120 + gap 4)`. 쓸 수 있는 폭 = `영역폭 − 12(패딩) − 32(+) − 꼬리`.
 * **꼬리는 상수가 아니라 실측**이다 (`.main-tabbar-tail`) — 격자 메타(`138×51`/`81×37` 로 폭이
 * 다르다)·줌 칩이 들고 나며, 액션도 pane 수에 따라 버튼이 둘/넷이다. 94px 상수로 세던 때는
 * 메타가 들어온 만큼(≈50px) 판정이 늦어 탭이 메타와 부딪힌 뒤에야 접혔다. 꼬리는 **항상 자리를
 * 점유**하므로(핸드오프) 접힘 판정에서도 빼고 센다. 활성 탭은 언제나 풀 폼이라 접힌 뒤에도
 * "지금 뭘 보고 있나"는 글로 남는다.
 *
 * 폭이 아직 0 이면(첫 렌더·측정 전) 접지 않는다 — 측정 전에 접으면 넓은 창에서도 한 프레임 접힌다.
 * 꼬리는 액션 버튼 둘이 늘 있어 0 이 될 수 없다 — 0 은 "아직 안 쟀다"는 뜻이다.
 */
export function shouldCompactTabs(input: { tabCount: number; headerWidth: number; tailWidth: number }): boolean {
  if (input.headerWidth <= 0 || input.tailWidth <= 0) return false
  return input.tabCount * (TAB_FULL_W + TAB_GAP) > input.headerWidth - HEADER_PAD - ADD_BTN_W - input.tailWidth
}

const TAB_FULL_W = 120
const TAB_GAP = 4
const HEADER_PAD = 12
const ADD_BTN_W = 32

/** 상자 폭 — 영역 경계를 끌면 바로 따라와야 해서 `ResizeObserver` 로 잰다. */
function useBoxWidth(): { ref: React.RefObject<HTMLDivElement | null>; width: number } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (node === null) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box !== undefined) setWidth(box.width)
    })
    observer.observe(node)
    setWidth(node.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
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
  tabs,
  workspaceTabCount,
  home,
  selectedPane,
  activeTabId,
  activeGroup,
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
  onMoveToGroup,
  onZoom,
  onClosePane,
  onCloseGroup,
  otherGroups,
  onMoveToOtherGroup,
  onTabDragStart,
}: {
  groupId: string
  /** **이 영역에 배정된** 탭들 (R3-c) — worktree 전체가 아니다. */
  tabs: TabRow[]
  /** herdr 기본 위치 라벨 판별용 — **워크스페이스 전체** 탭 수다 (G7, `tabs.length` 와 다르다 —
   * `tabs` 는 이 영역 로컬이라 그 길이를 쓰면 범위가 좁아져 기본 label 이 이름으로 샌다). */
  workspaceTabCount: number
  /** 셸 탭 폴백이 경로를 접는 데 쓴다 (C9). */
  home: string
  selectedPane: string | null
  activeTabId: string | null
  /** 이 영역이 포커스 영역인가 — 액션 노출과 탭 라벨 색이 갈린다. */
  activeGroup: boolean
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
  onSplitPane: (direction: 'right' | 'down') => void
  onMoveToGroup: (input: { tabId: string; direction: 'row' | 'column' }) => void
  onZoom: () => void
  onClosePane: () => void
  /** 영역 닫기 (F1-5) — 영역이 하나뿐이면 `null` 로 줘서 버튼을 안 그린다. */
  onCloseGroup: (() => void) | null
  /** LIFE-387 A1/B1 — 다른 영역 목록(탭 메뉴·헤더 메뉴 공용 "다른 영역으로 옮기기" 섹션). */
  otherGroups: { groupId: string; label: string }[]
  onMoveToOtherGroup: (input: { tabId: string; targetGroupId: string }) => void
  /** LIFE-387 A1 — 탭 mousedown 을 드래그 컨트롤러(App 소유 `useTabDrag`)로 그대로 넘긴다. */
  onTabDragStart: (event: React.MouseEvent, tabId: string) => void
}): React.JSX.Element {
  // 탭 수로 가르지 않는다(C5′). 탭이 0개여도 `+` 가 남는 껍데기를 그린다 — 마지막 탭을 닫았을 때
  // 탭바가 통째로 사라지면 새 탭을 만들 진입점이 같이 사라진다.
  const header = useBoxWidth()
  const tail = useBoxWidth()
  const compact = shouldCompactTabs({ tabCount: tabs.length, headerWidth: header.width, tailWidth: tail.width })
  // LIFE-387 B1 F-B1-1·F-B1-3 — 헤더 모드 메뉴(⊞ · 탭바 빈 곳 우클릭). 활성 탭이 없으면 안 연다
  // (§2 GroupHeader 우클릭 "빈 영역은 열지 않음").
  const [headerMenu, setHeaderMenu] = useState<TabMenuAnchor | null>(null)
  const openHeaderMenu = (point: { x: number; y: number }): void => {
    if (activeTabId === null) return
    setHeaderMenu({ tabId: activeTabId, x: point.x, y: point.y })
  }
  const activeTabLabel = tabs.find((tab) => tab.tabId === activeTabId)?.label ?? ''
  return (
    <div
      className={`main-tabbar ${activeGroup ? 'is-active-group' : ''} ${compact ? 'is-compact' : ''}`}
      data-main-tabbar
      data-group-header={groupId}
      data-header-compact={compact ? 'true' : 'false'}
      ref={header.ref}
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
      {tabs.map((tab) => (
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
          compact={compact && tab.tabId !== activeTabId}
          canMoveToGroup={tabs.length > 1}
          onSelect={() => onSelectTab(tab)}
          onClose={() => onCloseTab(tab)}
          onRename={(label) => onRenameTab({ tab, label, tabCount: workspaceTabCount })}
          onClearName={() => onClearTabName(tab)}
          onSplitPane={onSplitPane}
          onMoveToGroup={(direction) => onMoveToGroup({ tabId: tab.tabId, direction })}
          otherGroups={otherGroups}
          onMoveToOtherGroup={(targetGroupId) => onMoveToOtherGroup({ tabId: tab.tabId, targetGroupId })}
          onDragStart={(event) => onTabDragStart(event, tab.tabId)}
        />
      ))}
      <button className="main-tab-add" data-main-tabbar-add={groupId} title="빈 탭 (⌘T)" onClick={onCreateShell}>
        +
      </button>
      <div className="main-tabbar-spacer" />
      {/* 탭이 아닌 것들은 한 상자에 담는다 — 접힘 판정이 이 상자의 **실측 폭**을 뺀다. */}
      <div className="main-tabbar-tail" data-group-tail={groupId} ref={tail.ref}>
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
          <button className="group-action" data-group-split-right={groupId} title="오른쪽으로 pane 분할 (⌘D)" onClick={() => onSplitPane('right')}>
            <SplitIcon kind="pane-right" />
          </button>
          <button className="group-action" data-group-split-down={groupId} title="아래로 pane 분할 (⌘⇧D)" onClick={() => onSplitPane('down')}>
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
              title={zoomed ? '줌 해제 (⌘⇧Z)' : 'pane 줌 (⌘⇧Z)'}
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
          {tabs.length === 0 && onCloseGroup !== null ? (
            <button className="group-action is-danger" data-group-close={groupId} title="영역 닫기 (⌘⌥W)" onClick={onCloseGroup}>
              ✕
            </button>
          ) : null}
        </div>
      </div>
      {headerMenu === null ? null : (
        <TabContextMenu
          anchor={headerMenu}
          hasUserName={false}
          canMoveToGroup={tabs.length > 1}
          otherGroups={otherGroups}
          headerMode={{ activeTabLabel }}
          onRename={() => {}}
          onClearName={() => {}}
          onSplitPane={onSplitPane}
          onMoveToGroup={(direction) => {
            if (activeTabId === null) return
            onMoveToGroup({ tabId: activeTabId, direction })
          }}
          onMoveToOtherGroup={(targetGroupId) => {
            if (activeTabId === null) return
            onMoveToOtherGroup({ tabId: activeTabId, targetGroupId })
          }}
          onClose={() => {
            const activeTab = tabs.find((tab) => tab.tabId === activeTabId)
            if (activeTab !== undefined) onCloseTab(activeTab)
          }}
          onDismiss={() => setHeaderMenu(null)}
        />
      )}
    </div>
  )
}
