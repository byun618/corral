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
import { TabContextMenu, type TabMenuAnchor } from './TabContextMenu.js'

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
  branch,
  active,
  onSelect,
  onClose,
  onRename,
  onClearName,
}: {
  tab: TabRow
  /** 이 worktree 의 git 브랜치 — 셸 탭 제목의 브랜치 티어 (G3). 없으면 null. */
  branch: string | null
  active: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (label: string) => void
  /** LIFE-366 F1 — 사용자가 준 이름 지우기. 메뉴에서만 닿는다. */
  onClearName: () => void
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

  const seed = sessionTitle({ tab, branch })
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
  return (
    <div
      className={`main-tab ${active ? 'is-active' : ''}`}
      data-main-tab={tab.tabId}
      data-tab-editing={editing ? 'true' : 'false'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
      <span className="main-tab-label">{sessionTitle({ tab, branch })}</span>
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
          hasUserName={userLabel(tab) !== null}
          onRename={beginEdit}
          onClearName={onClearName}
          onClose={onClose}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}

export function MainTabBar({
  tabs,
  branch,
  selectedPane,
  activeWorktreeLabel,
  onSelectTab,
  onCreateShell,
  onCloseTab,
  onRenameTab,
  onClearTabName,
}: {
  tabs: TabRow[]
  /**
   * 활성 worktree 의 git 브랜치 (G3). `activeWorktreeLabel` 과 **다른 값**이다 —
   * 저 라벨은 브랜치가 없으면 경로로 떨어지는데, 제목에는 절대경로를 넣지 않는다 (§2.5).
   * 그래서 여기는 정제 안 된 `WorktreeRow.branch` 를 그대로 받는다.
   */
  branch: string | null
  selectedPane: string | null
  activeWorktreeLabel: string
  onSelectTab: (tab: TabRow) => void
  onCreateShell: () => void
  onCloseTab: (tab: TabRow) => void
  onRenameTab: (tab: TabRow, label: string) => void
  onClearTabName: (tab: TabRow) => void
}): React.JSX.Element {
  // 탭 수로 가르지 않는다(C5′). 탭이 0개여도 `+` 와 worktree 라벨이 남는 껍데기를 그린다 —
  // 마지막 탭을 닫았을 때 탭바가 통째로 사라지면 새 탭을 만들 진입점이 같이 사라진다.
  return (
    <div className="main-tabbar" data-main-tabbar>
      {tabs.map((tab) => (
        <MainTab
          key={tab.tabId}
          tab={tab}
          branch={branch}
          active={tab.panes.some((pane) => pane.paneId === selectedPane)}
          onSelect={() => onSelectTab(tab)}
          onClose={() => onCloseTab(tab)}
          onRename={(label) => onRenameTab(tab, label)}
          onClearName={() => onClearTabName(tab)}
        />
      ))}
      <button className="main-tab-add" data-main-tabbar-add title="빈 탭" onClick={onCreateShell}>
        +
      </button>
      <div className="main-tabbar-spacer" />
      <span className="main-tabbar-active-worktree" data-main-tabbar-worktree title={activeWorktreeLabel}>
        {activeWorktreeLabel}
      </span>
    </div>
  )
}
