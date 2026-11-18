import { useBindingLabel } from '../hooks/BindingLabels.js'
import { useMenuBus } from '../menu-bus.js'
// 탭 우클릭 메뉴 — LIFE-495 부터 **항목 순서 = Orca 220** (`SortableTabContextMenu.tsx`, K1ⓐ):
//   영역으로 옮기기(우·좌·하·상) → pane 분할(오른쪽·아래) → ─ → 핀/핀 해제 → ─ → 닫기 · 다른 탭 닫기 · 오른쪽 탭 닫기 · 왼쪽 탭 닫기
//   → ─ → 제목 바꾸기(⌘R) · 이름 지우기 → 탭 색.
// corral 이 더 가진 두 항목의 자리: 「다른 영역으로 옮기기」는 같은 결(탭을 영역으로 보낸다)인 「영역으로 옮기기」 바로 아래, 「이름 지우기」는
// 같은 결(제목)인 「제목 바꾸기」 바로 옆. 220 은 서브메뉴(▸)지만 이 메뉴는 LIFE-373 부터 머리줄로 묶은 평평한 목록이라 그 모양을 지킨다.
// 비활성 조건·대상 계산은 `tab-actions.ts` 의 순수 함수(`tabMenuModel`)다 — 여기서는 그리기만 한다.
//
// LIFE-373 핸드오프 §1-6 "한 메뉴 두 섹션": 같은 `D` 키가 무엇을 쪼개는지를 메뉴에서 갈라
// 보여준다 — `이 탭 안에서 pane 분할`(herdr 소유)과 `이 탭을 새 영역으로 옮기기`(화면 소유).
// 원 영역에 탭이 하나뿐이면 옮기기는 **비활성**이다(빈 영역을 만드는 경로가 되면 안 된다).
//
// `RepoRowMenu` 와 같은 모양·같은 규칙이다 (핸드오프 §2 의 168px 드롭다운, 바깥 클릭 시 닫힘).
// 다른 점 하나: 레포 메뉴는 `⋯` 버튼 아래 붙는데 이건 **우클릭 좌표**에 뜬다 — 탭바에는 메뉴
// 버튼을 놓을 자리가 없고(폭이 통과선이다) 우클릭이 탭 메뉴의 관습이라서다.
//
// **기존 hover 보조 버튼과 어긋나지 않는다** (F2 통과선): 닫기는 hover `×` 와 **같은 손잡이**
// (`onClose`)를 부르고, 이름 변경은 더블클릭 인라인 편집과 **같은 `beginEdit`** 을 부른다.
// 메뉴가 두 번째 구현을 들이면 두 경로가 갈라진다 — 여기서는 문만 하나 더 내는 것이다.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ONE_TAB_IN_GROUP } from '../group-tree.js'
import type { CloseScope, TabMenuModel } from '../tab-actions.js'
import { TAB_COLORS } from '../tab-marks.js'
import { TabMenuIcon, type TabMenuIconKind } from './TabMenuIcon.js'

export type TabMenuAnchor = { tabId: string; x: number; y: number }

/** 새 영역으로 옮기기 4방향 (K1ⓒ) — `group-tree.splitGroup` 의 방향·가장자리로 옮긴다(왼쪽·위 = 앞 가장자리). */
export type MoveDirection = 'right' | 'left' | 'down' | 'up'

/**
 * LIFE-825 C3·C4 — 헤더 모드 메뉴(⊞·탭바 빈 곳 우클릭)의 영역 배치 항목. 터미널 탭 메뉴·파일 탭 메뉴가 같이 쓴다.
 * `disabledTitle` 이 있으면(영역이 하나뿐) 두 항목 다 흐림 + 그 이유(무음 실패 0).
 */
export type GroupLayoutMenu = { maximized: boolean; disabledTitle: string | null; maximizeShortcut: string; onToggleMaximize: () => void; onEven: () => void }

/** 영역 배치 항목 두 줄의 문구·아이콘 — 두 메뉴가 같은 말을 하게 한 자리에서. */
export function groupLayoutMenuItems(menu: GroupLayoutMenu): { key: 'maximize' | 'even'; label: string; icon: TabMenuIconKind; shortcut: string; run: () => void }[] {
  return [
    { key: 'maximize', label: menu.maximized ? '영역 최대화 해제' : '영역 최대화', icon: menu.maximized ? 'minimize' : 'maximize', shortcut: menu.maximizeShortcut, run: menu.onToggleMaximize },
    { key: 'even', label: '영역 크기 균등화', icon: 'columns', shortcut: '', run: menu.onEven },
  ]
}
export function moveDirectionToSplit(direction: MoveDirection): { direction: 'row' | 'column'; edge: 'before' | 'after' } {
  switch (direction) {
    case 'right':
      return { direction: 'row', edge: 'after' }
    case 'left':
      return { direction: 'row', edge: 'before' }
    case 'down':
      return { direction: 'column', edge: 'after' }
    case 'up':
      return { direction: 'column', edge: 'before' }
  }
}

const MOVE_ITEMS: { direction: MoveDirection; label: string; icon: TabMenuIconKind }[] = [
  { direction: 'right', label: '오른쪽 영역', icon: 'arrow-right' },
  { direction: 'left', label: '왼쪽 영역', icon: 'arrow-left' },
  { direction: 'down', label: '아래 영역', icon: 'arrow-down' },
  { direction: 'up', label: '위 영역', icon: 'arrow-up' },
]

/** 닫을 대상이 없을 때의 사유 — 비활성 항목의 툴팁. */
const NOTHING_TO_CLOSE = '닫을 탭이 없다 (고정된 탭은 닫지 않는다)'

// LIFE-822 — 「모두 닫기」「저장된 탭 닫기」를 파일 탭 메뉴(`MainTabBar` `FileTabMenu`)와 같은 이름·순서로 둔다.
const CLOSE_SCOPE_ITEMS: { scope: CloseScope; label: string; icon: TabMenuIconKind; enabled: (model: TabMenuModel) => boolean; disabledTitle: string }[] = [
  { scope: 'others', label: '다른 탭 닫기', icon: 'list-x', enabled: (model) => model.canCloseOthers, disabledTitle: NOTHING_TO_CLOSE },
  { scope: 'right', label: '오른쪽 탭 닫기', icon: 'panel-right-close', enabled: (model) => model.canCloseRight, disabledTitle: NOTHING_TO_CLOSE },
  { scope: 'left', label: '왼쪽 탭 닫기', icon: 'panel-left-close', enabled: (model) => model.canCloseLeft, disabledTitle: NOTHING_TO_CLOSE },
  { scope: 'all', label: '모두 닫기', icon: 'x', enabled: (model) => model.canCloseAll, disabledTitle: NOTHING_TO_CLOSE },
  { scope: 'saved', label: '저장된 탭 닫기', icon: 'list-x', enabled: (model) => model.canCloseSaved, disabledTitle: '닫을 저장된 파일 탭이 없다 (수정된 탭·터미널 탭·고정된 탭은 닫지 않는다)' },
]

export function TabContextMenu({
  anchor,
  model,
  hasUserName,
  color,
  otherGroups,
  headerMode,
  onRename,
  onClearName,
  onSplitPane,
  onMoveToGroup,
  onMoveToOtherGroup,
  onTogglePin,
  onClose,
  onCloseScope,
  onSetColor,
  onDismiss,
}: {
  anchor: TabMenuAnchor
  /** 항목 상태 — 핀·닫기 대상·옮기기 가능 여부(`tabMenuModel`). */
  model: TabMenuModel
  /** 사용자가 준 이름이 있나 — 없으면 「이름 지우기」는 할 일이 없어 **비활성**으로 보인다. */
  hasUserName: boolean
  /** 지금 탭 색(없으면 null) — swatch 선택 표시. */
  color: string | null
  /** LIFE-387 A1 — 다른 영역 목록("다른 영역으로 옮기기" 섹션, 영역 ≥ 2 일 때만 뜬다). */
  otherGroups: { groupId: string; label: string }[]
  /**
   * LIFE-387 B1 — 헤더(`⊞`)·탭바 빈 곳 우클릭에서 열린 "헤더 모드". 대상은 그 영역의 **활성 탭**이다 — 항목은 탭 메뉴와 같다(K1ⓓ).
   */
  headerMode?: { activeTabLabel: string; groupLayout?: GroupLayoutMenu }
  onRename: () => void
  onClearName: () => void
  onSplitPane: (direction: 'right' | 'down') => void
  onMoveToGroup: (direction: MoveDirection) => void
  onMoveToOtherGroup: (targetGroupId: string) => void
  onTogglePin: () => void
  onClose: () => void
  onCloseScope: (scope: CloseScope) => void
  onSetColor: (color: string | null) => void
  /** LIFE-825 low H1 — 항목 실행으로 닫히면 `'item'`(Esc·바깥 클릭·다른 메뉴는 인자 없음). */
  onDismiss: (reason?: 'item') => void
}): React.JSX.Element {
  const bindingLabel = useBindingLabel()
  const ref = useRef<HTMLDivElement | null>(null)
  // 우클릭 좌표 그대로 놓으면 **창 밖으로 나간다** (수정 라운드 1, V7). 오른쪽 끝 탭을 우클릭하면
  // 메뉴 폭(168px)의 대부분이 화면 밖에 걸려 「이름 지우기」·「탭 닫기」의 글자와 클릭 영역이
  // 잘린다. 레포 메뉴(`.repo-row-menu`)는 `right` 앵커라 구조적으로 이 문제가 없는데, 좌표 앵커로
  // 바꾸면서 새로 생긴 갈래다.
  //
  // 상수(168px)를 여기 베껴 두지 않고 **붙은 뒤 실측한 크기**로 접는다 — 항목 수가 바뀌면 높이가
  // 바뀌고, 폭은 토큰이 정한다. `useLayoutEffect` 라 그려지기 전에 자리가 잡힌다(깜빡임 없음).
  const [placed, setPlaced] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y })
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const box = element.getBoundingClientRect()
    const margin = 4
    setPlaced({
      left: Math.max(margin, Math.min(anchor.x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(anchor.y, window.innerHeight - box.height - margin)),
    })
  }, [anchor.x, anchor.y])

  // LIFE-478 K2ⓓ — 메뉴는 한 번에 하나(카드 우클릭·옵션·레포 ⋯ 와 같은 버스).
  useMenuBus({ open: true, close: onDismiss })
  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent): void => {
      if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) onDismiss()
    }
    // Esc 는 캡처 단계에서 받는다 — 터미널(xterm)에 포커스가 있으면 xterm 이 Esc 를 처리하고 전파를 끊어 버블 단계 리스너가
    // 못 듣는다(LIFE-495 G4 r2 실측: 메뉴가 남아 뒤이은 닫기 확인 모달을 가렸다). 메뉴가 열려 있는 동안의 Esc 는 메뉴만 닫는다
    // — 셸에 ESC 바이트를 보내지 않는다(220 은 메뉴가 포커스를 가져가 같은 결과).
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
    }
    document.addEventListener('mousedown', onDocPointerDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onDismiss])

  /** 항목 하나 — 비활성이면 누름을 무시하고 사유를 툴팁으로. 누르면 메뉴를 먼저 닫고 동작한다(이름 편집이 메뉴 닫힘 뒤에 포커스를 잡게). */
  const item = (input: {
    attr: Record<string, string>
    icon: TabMenuIconKind
    label: string
    run: () => void
    enabled?: boolean
    disabledTitle?: string
    shortcut?: string
    danger?: boolean
  }): React.JSX.Element => {
    const enabled = input.enabled ?? true
    return (
      <div
        className={`repo-row-menu-item ${input.danger === true ? 'repo-row-menu-danger' : ''} ${enabled ? '' : 'is-disabled'}`}
        {...input.attr}
        data-disabled={enabled ? 'false' : 'true'}
        title={enabled ? undefined : input.disabledTitle}
        onClick={() => {
          if (!enabled) return
          onDismiss('item')
          input.run()
        }}
      >
        <span className="repo-row-menu-glyph">
          <TabMenuIcon kind={input.icon} />
        </span>
        <span>{input.label}</span>
        {input.shortcut === undefined || input.shortcut === '' ? null : <span className="tab-menu-key">{input.shortcut}</span>}
      </div>
    )
  }

  return (
    <div
      className="tab-context-menu"
      data-tab-menu={anchor.tabId}
      ref={ref}
      style={{ left: placed.left, top: placed.top }}
      data-menu-anchor-x={anchor.x}
      data-menu-anchor-y={anchor.y}
      onClick={(event) => event.stopPropagation()}
      // LIFE-530 — 포털이어도 React 합성 이벤트는 React 트리(메뉴를 연 탭)로 버블한다. mousedown 을 여기서 끊지 않으면 메뉴의 빈 자리
      // (섹션 제목·구분선·여백)를 누르고 끈 손짓이 탭의 드래그 무장(`onDragStart`)으로 가 탭 순서가 바뀐다. 탭 만들기 메뉴·ContextMenu 와 같은 결.
      // 바깥 닫기는 문서 mousedown 의 「메뉴 밖인가」 판정이라 메뉴 안 누름을 끊어도 그대로다. 끊으면 탭바의 `keepFocusOnHeaderBackground` 도
      // 안 닿으므로 같은 일(입력 요소가 아니면 기본 동작 막기 — 터미널 포커스 유지)을 여기서 한다.
      onMouseDown={(event) => {
        event.stopPropagation()
        if (event.target instanceof Element && event.target.closest('button, input, textarea, select, a[href], [contenteditable="true"], [tabindex]') === null) event.preventDefault()
      }}
      // LIFE-825 fix5 ⑧ — 우클릭도 끊는다: 메뉴 안 우클릭이 연 탭·탭바의 onContextMenu 로 올라가면 메뉴를 그 자리에 다시 열며 우클릭 토큰을 null 로 덮어
      // Esc 닫힘이 본문 포커스를 안 한다(활성 ≠ 포커스).
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {headerMode === undefined ? null : (
        <>
          <div className="tab-menu-section tab-menu-header-mode" data-tab-menu-header-mode={anchor.tabId}>
            탭 · {headerMode.activeTabLabel}
          </div>
          <div className="repo-row-menu-sep" />
          {headerMode.groupLayout === undefined ? null : (
            <>
              <div className="tab-menu-section">영역</div>
              {groupLayoutMenuItems(headerMode.groupLayout).map((entry) =>
                item({
                  attr: { [`data-group-layout-${entry.key}`]: anchor.tabId },
                  icon: entry.icon,
                  label: entry.label,
                  enabled: headerMode.groupLayout?.disabledTitle === null,
                  disabledTitle: headerMode.groupLayout?.disabledTitle ?? undefined,
                  run: entry.run,
                  shortcut: entry.shortcut,
                }),
              )}
              <div className="repo-row-menu-sep" />
            </>
          )}
        </>
      )}
      <div className="tab-menu-section">이 탭을 새 영역으로 옮기기</div>
      {MOVE_ITEMS.map((move) =>
        item({
          attr: { [`data-tab-menu-move-${move.direction}`]: anchor.tabId },
          icon: move.icon,
          label: move.label,
          enabled: model.canMoveToNewGroup,
          disabledTitle: ONE_TAB_IN_GROUP,
          run: () => onMoveToGroup(move.direction),
          shortcut: move.direction === 'right' ? bindingLabel('group.split') : move.direction === 'down' ? bindingLabel('group.split', 1) : undefined,
        }),
      )}
      {otherGroups.length === 0 ? null : (
        <>
          <div className="tab-menu-section">이 탭을 다른 영역으로 옮기기</div>
          {otherGroups.map((group, index) => (
            <div
              key={group.groupId}
              className="repo-row-menu-item"
              data-tab-menu-move-other={group.groupId}
              onClick={() => {
                onDismiss('item')
                onMoveToOtherGroup(group.groupId)
              }}
            >
              <span className="repo-row-menu-glyph tab-menu-group-badge">{index + 1}</span>
              <span>영역 {index + 1} · {group.label}</span>
            </div>
          ))}
        </>
      )}
      <div className="repo-row-menu-sep" />
      <div className="tab-menu-section">이 탭 안에서 pane 분할</div>
      {item({ attr: { 'data-tab-menu-split-right': anchor.tabId }, icon: 'split-right', label: '오른쪽으로', run: () => onSplitPane('right'), shortcut: bindingLabel('terminal.split') })}
      {item({ attr: { 'data-tab-menu-split-down': anchor.tabId }, icon: 'split-down', label: '아래로', run: () => onSplitPane('down'), shortcut: bindingLabel('terminal.split', 1) })}
      <div className="repo-row-menu-sep" />
      {item({
        attr: { 'data-tab-menu-pin': anchor.tabId, 'data-pinned': model.pinned ? 'true' : 'false' },
        icon: model.pinned ? 'pin-off' : 'pin',
        label: model.pinned ? '탭 고정 해제' : '탭 고정',
        run: onTogglePin,
      })}
      <div className="repo-row-menu-sep" />
      {item({
        attr: { 'data-tab-menu-close': anchor.tabId },
        icon: 'x',
        label: '닫기',
        enabled: model.canClose,
        disabledTitle: '고정된 탭이다 — 고정을 풀거나 ⌘W 로 닫는다',
        run: onClose,
        shortcut: bindingLabel('terminal.close'),
        danger: true,
      })}
      {CLOSE_SCOPE_ITEMS.map((scope) =>
        item({
          attr: { [`data-tab-menu-close-${scope.scope}`]: anchor.tabId },
          icon: scope.icon,
          label: scope.label,
          enabled: scope.enabled(model),
          disabledTitle: scope.disabledTitle,
          run: () => onCloseScope(scope.scope),
        }),
      )}
      <div className="repo-row-menu-sep" />
      {item({ attr: { 'data-tab-menu-rename': anchor.tabId }, icon: 'pencil', label: '제목 바꾸기', run: onRename, shortcut: bindingLabel('tab.rename') })}
      {item({
        attr: { 'data-tab-menu-clear': anchor.tabId },
        icon: 'eraser',
        label: '이름 지우기',
        enabled: hasUserName,
        disabledTitle: '사용자가 준 이름이 없다',
        run: onClearName,
      })}
      <div className="tab-menu-color" data-tab-menu-colors={anchor.tabId}>
        <div className="tab-menu-color-title">탭 색</div>
        <div className="tab-menu-color-row">
          {TAB_COLORS.map((entry) => (
            <button
              key={entry.label}
              type="button"
              className={`tab-menu-swatch ${entry.value === null ? 'is-none' : ''} ${entry.value === color ? 'is-selected' : ''}`}
              data-tab-menu-color={entry.value ?? 'none'}
              data-selected={entry.value === color ? 'true' : 'false'}
              title={entry.label}
              aria-label={`탭 색 ${entry.label}`}
              style={entry.value === null ? undefined : { backgroundColor: entry.value }}
              onClick={() => {
                onDismiss('item')
                onSetColor(entry.value)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
