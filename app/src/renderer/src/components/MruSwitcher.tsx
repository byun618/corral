// design-handoff.md §2 MruSwitcher — `⌃Tab` 홀드 중 뜨는 최근 pane 목록 (LIFE-373 ③ · F3-4).
//
// **scrim 을 두지 않는다** (핸드오프 O): 취소가 "아무 일도 없었음"이어야 하는데, 화면을 덮으면
// 그 사이 터미널이 안 보여 "뭔가 일어났다"가 된다. 대신 키가 잠겼다는 단서 둘을 준다 —
// 헤더 칩(여기)과 **모든 pane 의 커서 외곽선**(App.tsx 가 xterm 포커스를 놓아서 만든다).
//
// 목록은 받아서 그린다. 순서·상한·선택 자리는 `mru-order.ts` 와 `App.tsx` 의 것이다.

import type { AgentStatus } from '../../../shared/types.js'
import { GLYPH, STATUS_LABEL } from '../session-glyphs.js'

/** 행 하나 — 화면에 그릴 만큼만. 어디서 왔는지(탭·영역)는 `App.tsx` 가 이미 풀었다. */
export type MruRow = {
  paneId: string
  title: string
  /** 같은 worktree 면 그 탭이 배정된 영역 글리프(영역 1개면 빈 문자열), 다른 worktree 면 `⇄`. */
  groupGlyph: string
  otherWorktree: boolean
  /** 에이전트 상태 — 편집기 탭(파일·diff, LIFE-824 C4)은 null(점 없음). */
  status: AgentStatus | null
  /** `pane {n} · {종류}` — pane 이 하나뿐인 탭이면 종류만. */
  paneDesc: string
  worktree: string
  /** 마지막 활동 경과. **없으면 안 그린다** — 지어낸 수 대신 부재(SessionRow 와 같은 규칙). */
  elapsed: string | null
}

export function MruSwitcher({
  rows,
  selectedIndex,
  moreCount,
  onPick,
}: {
  rows: MruRow[]
  selectedIndex: number
  /** 상한(12) 밖으로 밀린 pane 수. 0 이면 꼬리줄을 안 그린다. */
  moreCount: number
  onPick: (paneId: string) => void
}): React.JSX.Element {
  return (
    <div className="mru-switcher" role="listbox" aria-label="최근 pane" data-mru data-mru-count={rows.length}>
      <div className="mru-header">
        <span className="mru-header-label">최근 · pane 단위</span>
        <span className="mru-header-chip" data-mru-chip title="홀드 중 Tab · ⇧Tab · Enter · Esc 는 터미널이 아니라 이 목록이 받습니다">
          ⌨ 목록이 키를 받는 중
        </span>
        <div className="mru-header-spacer" />
        <span className="mru-header-keys">Tab 다음 · ⇧Tab 이전 · Ctrl 놓으면 전환 · Esc 취소</span>
      </div>
      <div className="mru-rows">
        {rows.map((row, index) => (
          <div
            key={row.paneId}
            className={`mru-row ${index === selectedIndex ? 'is-selected' : ''}`}
            role="option"
            aria-selected={index === selectedIndex}
            data-mru-row={row.paneId}
            data-mru-index={index + 1}
            data-mru-selected={index === selectedIndex}
            // mousedown 으로 받는다 — 홀드 중이라 click(=mouseup 뒤)까지 기다리면 그 사이
            // `Control` keyup 이 먼저 확정해 **엉뚱한 행**으로 간다.
            onMouseDown={(event) => {
              event.preventDefault()
              onPick(row.paneId)
            }}
          >
            <span className="mru-row-index">{index + 1}</span>
            <span
              className={`mru-row-place ${row.otherWorktree ? 'is-other' : ''}`}
              title={row.otherWorktree ? 'worktree 전환 — 화면 전체가 그 worktree 의 영역 레이아웃으로 바뀝니다' : '이 탭이 열린 영역'}
            >
              {row.groupGlyph}
            </span>
            {row.status === null ? (
              <span className="mru-row-status" />
            ) : (
              <span className={`mru-row-status tone-${GLYPH[row.status].tone}`} title={STATUS_LABEL[row.status]}>
                {GLYPH[row.status].glyph}
              </span>
            )}
            <span className="mru-row-title">{row.title}</span>
            <span className="mru-row-pane">{row.paneDesc}</span>
            <div className="mru-row-spacer" />
            <span className={`mru-row-worktree ${row.otherWorktree ? 'is-other' : ''}`}>{row.worktree}</span>
            {row.elapsed === null ? null : <span className="mru-row-elapsed">{row.elapsed}</span>}
          </div>
        ))}
      </div>
      {moreCount <= 0 ? null : <div className="mru-more">+{moreCount} 더 있음 — 사이드바에서 열기</div>}
    </div>
  )
}
