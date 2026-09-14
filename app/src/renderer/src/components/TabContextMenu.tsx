// 탭 우클릭 메뉴 (LIFE-366 F2) — 이름 변경 · 이름 지우기 · 닫기.
//
// `RepoRowMenu` 와 같은 모양·같은 규칙이다 (핸드오프 §2 의 168px 드롭다운, 바깥 클릭 시 닫힘).
// 다른 점 하나: 레포 메뉴는 `⋯` 버튼 아래 붙는데 이건 **우클릭 좌표**에 뜬다 — 탭바에는 메뉴
// 버튼을 놓을 자리가 없고(폭이 통과선이다) 우클릭이 탭 메뉴의 관습이라서다.
//
// **기존 hover 보조 버튼과 어긋나지 않는다** (F2 통과선): 닫기는 hover `×` 와 **같은 손잡이**
// (`onClose`)를 부르고, 이름 변경은 더블클릭 인라인 편집과 **같은 `beginEdit`** 을 부른다.
// 메뉴가 두 번째 구현을 들이면 두 경로가 갈라진다 — 여기서는 문만 하나 더 내는 것이다.

import { useEffect, useRef } from 'react'

export type TabMenuAnchor = { tabId: string; x: number; y: number }

export function TabContextMenu({
  anchor,
  hasUserName,
  onRename,
  onClearName,
  onClose,
  onDismiss,
}: {
  anchor: TabMenuAnchor
  /** 사용자가 준 이름이 있나 — 없으면 「이름 지우기」는 할 일이 없어 **비활성**으로 보인다. */
  hasUserName: boolean
  onRename: () => void
  onClearName: () => void
  onClose: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

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
      style={{ left: anchor.x, top: anchor.y }}
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
