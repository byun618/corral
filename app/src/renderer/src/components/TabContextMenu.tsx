// 탭 우클릭 메뉴 — 이름 변경 · 이름 지우기 · **pane 분할 ②** · **새 영역으로 옮기기 ①** · 닫기.
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

export type TabMenuAnchor = { tabId: string; x: number; y: number }

export function TabContextMenu({
  anchor,
  hasUserName,
  canMoveToGroup,
  onRename,
  onClearName,
  onSplitPane,
  onMoveToGroup,
  onClose,
  onDismiss,
}: {
  anchor: TabMenuAnchor
  /** 사용자가 준 이름이 있나 — 없으면 「이름 지우기」는 할 일이 없어 **비활성**으로 보인다. */
  hasUserName: boolean
  /** 원 영역에 탭이 2개 이상인가 (F1-1) — 하나뿐이면 옮기기가 빈 영역을 만든다. */
  canMoveToGroup: boolean
  onRename: () => void
  onClearName: () => void
  onSplitPane: (direction: 'right' | 'down') => void
  onMoveToGroup: (direction: 'row' | 'column') => void
  onClose: () => void
  onDismiss: () => void
}): React.JSX.Element {
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

  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent): void => {
      if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) onDismiss()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', onDocPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  return (
    <div
      className="tab-context-menu"
      data-tab-menu={anchor.tabId}
      ref={ref}
      style={{ left: placed.left, top: placed.top }}
      data-menu-anchor-x={anchor.x}
      data-menu-anchor-y={anchor.y}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="repo-row-menu-item"
        data-tab-menu-rename={anchor.tabId}
        onClick={() => {
          onDismiss()
          onRename()
        }}
      >
        <span className="repo-row-menu-glyph">✎</span>
        <span>이름 변경</span>
      </div>
      <div
        className={`repo-row-menu-item ${hasUserName ? '' : 'is-disabled'}`}
        data-tab-menu-clear={anchor.tabId}
        data-disabled={hasUserName ? 'false' : 'true'}
        title={hasUserName ? undefined : '사용자가 준 이름이 없다'}
        onClick={() => {
          if (!hasUserName) return
          onDismiss()
          onClearName()
        }}
      >
        <span className="repo-row-menu-glyph">⌫</span>
        <span>이름 지우기</span>
      </div>
      <div className="repo-row-menu-sep" />
      <div className="tab-menu-section">이 탭 안에서 pane 분할</div>
      <div
        className="repo-row-menu-item"
        data-tab-menu-split-right={anchor.tabId}
        onClick={() => {
          onDismiss()
          onSplitPane('right')
        }}
      >
        <span className="repo-row-menu-glyph">▥</span>
        <span>오른쪽으로</span>
        <span className="tab-menu-key">⌘D</span>
      </div>
      <div
        className="repo-row-menu-item"
        data-tab-menu-split-down={anchor.tabId}
        onClick={() => {
          onDismiss()
          onSplitPane('down')
        }}
      >
        <span className="repo-row-menu-glyph">▤</span>
        <span>아래로</span>
        <span className="tab-menu-key">⌘⇧D</span>
      </div>
      <div className="repo-row-menu-sep" />
      <div className="tab-menu-section">이 탭을 새 영역으로 옮기기</div>
      <div
        className={`repo-row-menu-item ${canMoveToGroup ? '' : 'is-disabled'}`}
        data-tab-menu-move-right={anchor.tabId}
        data-disabled={canMoveToGroup ? 'false' : 'true'}
        title={canMoveToGroup ? undefined : ONE_TAB_IN_GROUP}
        onClick={() => {
          if (!canMoveToGroup) return
          onDismiss()
          onMoveToGroup('row')
        }}
      >
        <span className="repo-row-menu-glyph">◨</span>
        <span>오른쪽 영역</span>
        <span className="tab-menu-key">⌘⌥D</span>
      </div>
      <div
        className={`repo-row-menu-item ${canMoveToGroup ? '' : 'is-disabled'}`}
        data-tab-menu-move-down={anchor.tabId}
        data-disabled={canMoveToGroup ? 'false' : 'true'}
        title={canMoveToGroup ? undefined : ONE_TAB_IN_GROUP}
        onClick={() => {
          if (!canMoveToGroup) return
          onDismiss()
          onMoveToGroup('column')
        }}
      >
        <span className="repo-row-menu-glyph">⬓</span>
        <span>아래 영역</span>
        <span className="tab-menu-key">⌘⌥⇧D</span>
      </div>
      <div className="repo-row-menu-sep" />
      <div
        className="repo-row-menu-item repo-row-menu-danger"
        data-tab-menu-close={anchor.tabId}
        onClick={() => {
          onDismiss()
          onClose()
        }}
      >
        <span className="repo-row-menu-glyph">×</span>
        <span>탭 닫기</span>
      </div>
    </div>
  )
}
