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
// 고정 폭 180(≥1280 220)·최소 72 · 높이 = 탭바 줄 · 활성 = fg 6% + 하단 2px(fg 60%) · 비활성은 글자만 흐리다(hover 시 밝게) ·
// 선두 = 벨 → 상태 점(+로고) → 로고 → 셸 아이콘(`tab-status.ts`) · 닫기 16px 는 활성 탭 상시, 비활성은 hover · 중클릭 닫기.
// 좁아도 탭을 접지 않는다(compact 폐지) — 대신 스트립이 가로로 스크롤되고 활성 탭이 보이는 자리로 온다(넘침 최소선).
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
import { AGENT_ICON, agentIcon } from '../session-glyphs.js'
import { tabLeading, type TabAgentKind, type TabLeading } from '../tab-status.js'
import { AgentIcon, ShellTileIcon } from './AgentIcon.js'
import { AgentStateDot, PlusIcon } from './AgentStateDot.js'
import { FILLED_BELL_PATH } from './WorktreeStatusSlot.js'
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
  unreadPanes,
  hasTabsToRight,
  onSelect,
  onClose,
  onRename,
  onClearName,
  onSplitPane,
  onMoveToGroup,
  canMoveToGroup,
  otherGroups,
  onMoveToOtherGroup,
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
  /** 확인 안 된 완료가 있는 pane (LIFE-471 장부) — 탭 벨·워시·done 점의 출처. */
  unreadPanes: ReadonlySet<string>
  /** 오른쪽에 탭이 더 있나 — Orca 처럼 탭 사이 세로 줄을 마지막 탭에는 안 긋는다(`getTabStripBorderClasses`). */
  hasTabsToRight: boolean
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
  /** LIFE-387 A1 — 드래그 무장(mousedown). 6px 넘기 전엔 평소 클릭과 다르지 않다. */
  onDragStart: (event: React.MouseEvent) => void
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
      title={tooltip}
      data-tab-editing={editing ? 'true' : 'false'}
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
      // D14 중클릭 닫기 (Orca `SortableTab.tsx:213-225`). 편집 중엔 안 닫는다. 핀 제외 조건은 핀이 생길 때(T3) 붙는다.
      onAuxClick={(event) => {
        if (event.button !== 1 || editingRef.current) return
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
      <span className="main-tab-title">
      <span className="main-tab-label">{seed}</span>
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
      {/* 닫기 — 활성 탭은 상시, 비활성은 탭 hover 때(CSS). Orca 처럼 글자색으로 숨긴다(`text-transparent`). */}
      <button
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
 * 탭 스트립 넘침 최소선 (LIFE-493 D21·D24) — Orca `tab-strip-overflow-navigation.ts` 의 두 조각만 옮긴다:
 *   · 세로 휠이 가로 휠보다 크면 가로 스크롤로 바꾼다(`:77-90`). React `onWheel` 은 passive 라 `preventDefault` 가 안 먹어
 *     직접 단다.
 *   · 활성 탭이 바뀌면 보이는 자리로 끌어온다(`:171-187` `scrollIntoView({block:'nearest',inline:'nearest'})`). Orca 는 누르고
 *     있는 포인터 아래서 스트립이 움직이지 않게 그때는 미루는데, corral 은 탭 활성화가 **click**(떼고 난 뒤)이고 드래그 커밋도
 *     mouseup 이라 활성 탭이 바뀌는 순간 눌린 포인터가 없다 — 미루는 장치를 두지 않는다.
 * chevron·페이드·썸·끝에 붙기는 T2(LIFE-494) 몫이다.
 */
/** 휠 한 번을 스트립 가로 이동으로 바꿀지 — 넘칠 때, 세로가 가로보다 클 때만(가로 휠·트랙패드 가로 밀기는 브라우저 기본 그대로). */
export function wheelToHorizontal(input: { deltaX: number; deltaY: number; overflows: boolean }): number | null {
  if (!input.overflows) return null
  if (Math.abs(input.deltaY) <= Math.abs(input.deltaX)) return null
  return input.deltaY
}

function scrollActiveTabIntoView(input: { strip: HTMLElement; activeTabId: string | null }): void {
  if (input.activeTabId === null) return
  const tab = [...input.strip.querySelectorAll<HTMLElement>('[data-main-tab]')].find((node) => node.dataset.mainTab === input.activeTabId)
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function useTabStripOverflow(input: { activeTabId: string | null; tabOrder: string }): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const strip = ref.current
    if (strip === null) return
    const onWheel = (event: WheelEvent): void => {
      const step = wheelToHorizontal({ deltaX: event.deltaX, deltaY: event.deltaY, overflows: strip.scrollWidth > strip.clientWidth })
      if (step === null) return
      event.preventDefault()
      strip.scrollLeft += step
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])
  const activeTabId = useRef(input.activeTabId)
  activeTabId.current = input.activeTabId
  useEffect(() => {
    const strip = ref.current
    if (strip === null) return
    scrollActiveTabIntoView({ strip, activeTabId: activeTabId.current })
    // 탭 목록이 바뀔 때도 다시 끌어온다 — 새 탭은 선택이 목록보다 먼저 올 수 있고(그때는 노드가 아직 없다),
    // 활성 탭을 끌어 옮기면 활성 id 는 그대로다 (LIFE-493 K5 네이티브 원자료 k5/r2).
  }, [input.activeTabId, input.tabOrder])
  useEffect(() => {
    const strip = ref.current
    if (strip === null || typeof ResizeObserver === 'undefined') return
    // 스트립 폭은 새 탭이 그려진 **뒤에** 줄어들 수 있다(헤더 꼬리가 다음 렌더에 자리를 잡는다) — 그때 끌어온
    // 위치가 모자란다(k5/r3: 끝 탭이 39px 잘림). 폭이 바뀌면 다시 끌어온다.
    const observer = new ResizeObserver(() => scrollActiveTabIntoView({ strip, activeTabId: activeTabId.current }))
    observer.observe(strip)
    return () => observer.disconnect()
  }, [])
  return ref
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
  const bindingLabel = useBindingLabel()
  // 탭 수로 가르지 않는다(C5′). 탭이 0개여도 `+` 가 남는 껍데기를 그린다 — 마지막 탭을 닫았을 때
  // 탭바가 통째로 사라지면 새 탭을 만들 진입점이 같이 사라진다.
  const strip = useTabStripOverflow({ activeTabId, tabOrder: tabs.map((tab) => tab.tabId).join('\n') })
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
      className={`main-tabbar ${activeGroup ? 'is-active-group' : ''}`}
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
      {/* 탭 스트립 — 넘치면 가로로 스크롤된다(스크롤바는 숨긴다, Orca `.terminal-tab-strip`). */}
      <div className="main-tab-strip" data-main-tab-strip={groupId} ref={strip}>
      {tabs.map((tab, index) => (
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
          unreadPanes={unreadPanes}
          hasTabsToRight={index < tabs.length - 1}
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
      </div>
      {/* `+` — Orca 는 스트립 바로 뒤 28px 버튼(`tab-bar-surface.tsx:223-233`). 드롭다운은 T4(LIFE-496) 몫이라 여기선 빈 탭 그대로다. */}
      <button className="main-tab-add" data-main-tabbar-add={groupId} type="button" title={`빈 탭 (${bindingLabel('terminal.new')})`} aria-label="빈 탭" onClick={onCreateShell}>
        <PlusIcon className="main-tab-add-icon" />
      </button>
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
          {tabs.length === 0 && onCloseGroup !== null ? (
            <button className="group-action is-danger" data-group-close={groupId} title={`영역 닫기 (${bindingLabel('group.close')})`} onClick={onCloseGroup}>
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
