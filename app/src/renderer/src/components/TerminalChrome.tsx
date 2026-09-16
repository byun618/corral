// design-handoff.md §2 TerminalChrome — 감싸는 크롬만 대상, xterm.js 렌더 영역 자체는 미변경.
// 하단 24px 힌트줄: 좌 활성 영역의 **pane 스트립**, 우 단축키 목록(§1-8-b 버림 순서).
//
// 스트립이 **pane 식별의 유일한 자리**다 (§10-R21-1b). 장식 행 메타(R17-1)는 철회됐다 —
// herdr 장식 링이 상자 밖으로 나가 바깥 줄 pane 은 그 행이 화면에 안 섰다. 격자 수는 영역 헤더가 진다.
//
// 번호는 **화면 읽는 순서**이고 `numbersOf` 한 곳에서만 나온다 (C5-8) — 스트립과 MRU 가 같은
// 수를 써야 하므로 여기서 다시 세지 않는다.

import { useLayoutEffect, useRef, useState } from 'react'
import { AGENT_ICON, agentIcon } from '../session-glyphs.js'

/** 스트립 한 칸. 순서는 이미 정해져서 온다 — 여기서 다시 정렬하지 않는다. */
export type PaneStripItem = { paneId: string; number: number; agent: string | null; selected: boolean }

/** 모르는 종류는 지어내지 않고 **셸**로 떨어뜨린다 — 탭바와 같은 표를 쓴다(라벨도 그 표의 것). */
export function kindLabel(agent: string | null): string {
  return agentIcon(agent ?? 'shell')?.label ?? AGENT_ICON.shell.label
}

function kindGlyph(agent: string | null): string {
  return agentIcon(agent ?? 'shell')?.glyph ?? AGENT_ICON.shell.glyph
}

/**
 * 힌트줄 우측 단축키 — **앞이 먼저 버려진다** (핸드오프 §1-8-b, R6-J).
 *
 * 핸드오프 순서는 `⌘⌥D 새 영역 → ⌘⇧D → ⌘⇧Z → ⌘D → ⌃Tab → ⌘T`(마지막까지)였다. `⌘W`(F2-5a)는
 * **`⌘D` 뒤**에 끼운다 — 분할 셋은 영역 헤더에 버튼(`▥ ▤ ⤢`)이라는 두 번째 입구가 있지만
 * pane 닫기의 `✕` 는 **pane 이 하나일 때 사라져서**(글리프표) 마지막 pane 에서는 이 줄이 유일한
 * 안내다. 끼운 자리는 핸드오프가 안 정한 곳이라 C5 로 남긴다.
 *
 * `⌃Tab`(MRU)은 ③ 이 서면서 **핸드오프가 준 자리 그대로** 들어왔다 (`⌘D` 뒤, `⌘T` 앞 — C5-13).
 * `⌘W` 가 그 사이에 끼어 있어 버림 순서는 `… ⌘D → ⌘W → ⌃Tab → ⌘T` 다.
 */
const HINTS: { key: string; text: string }[] = [
  { key: 'split-group', text: '⌘⌥D 새 영역' },
  { key: 'split-down', text: '⌘⇧D 아래 분할' },
  { key: 'zoom', text: '⌘⇧Z 줌' },
  { key: 'split-right', text: '⌘D 분할' },
  { key: 'close-pane', text: '⌘W pane 닫기' },
  { key: 'mru', text: '⌃Tab 전환' },
  { key: 'new-tab', text: '⌘T 새 탭' },
]

/** `.terminal-chrome-hint` 의 `gap`. 폭 산술이 CSS 와 어긋나면 한 칸씩 밀린다. */
const HINT_GAP = 14

/**
 * 폭이 모자라면 **앞에서부터 버린다**.
 *
 * 버린 항목은 DOM 에 남긴 채 흐름에서만 뺀다(`.is-dropped` = `position: absolute`). 그래야
 * 매 프레임 **실제 폭을 다시 잴 수 있다** — 폭을 한 번 재서 캐시하면 폰트가 늦게 뜬 첫 프레임의
 * 값에 영영 묶인다. 흐름에서 빠지니 줄이 넘치는 일도 없고, 그래서 관측 → 축소 → 재관측 고리도 없다.
 */
function useHintFit(deps: { paneCount: number }): {
  row: React.RefObject<HTMLDivElement | null>
  strip: React.RefObject<HTMLSpanElement | null>
  list: React.RefObject<HTMLSpanElement | null>
  kept: number
} {
  const row = useRef<HTMLDivElement | null>(null)
  const strip = useRef<HTMLSpanElement | null>(null)
  const list = useRef<HTMLSpanElement | null>(null)
  const [kept, setKept] = useState(HINTS.length)
  useLayoutEffect(() => {
    const rowNode = row.current
    const stripNode = strip.current
    const listNode = list.current
    if (rowNode === null || stripNode === null || listNode === null) return
    const fit = (): void => {
      const room = rowNode.clientWidth - stripNode.getBoundingClientRect().width - HINT_GAP
      const widths = [...listNode.children].map((child) => child.getBoundingClientRect().width)
      let used = 0
      let next = 0
      for (let i = widths.length - 1; i >= 0; i -= 1) {
        used += (widths[i] ?? 0) + HINT_GAP
        if (used > room) break
        next += 1
      }
      // `⌘T 새 탭` 은 **마지막까지 남긴다** (R6-J) — 하나도 못 넣을 폭이어도 하나는 선다.
      setKept(Math.max(1, next))
    }
    fit()
    // 줄 자체만 본다. 스트립을 같이 관측하면 "줄였더니 스트립이 늘어 또 줄인다"가 될 수 있다 —
    // 스트립이 바뀌는 경우는 pane 수가 바뀔 때뿐이라 effect 의존성으로 다시 잰다.
    const observer = new ResizeObserver(fit)
    observer.observe(rowNode)
    return () => observer.disconnect()
  }, [deps.paneCount])
  return { row, strip, list, kept }
}

export function TerminalChrome({
  panes,
  children,
}: {
  panes: PaneStripItem[]
  children: React.ReactNode
}): React.JSX.Element {
  const hint = useHintFit({ paneCount: panes.length })
  const dropped = HINTS.length - hint.kept
  return (
    <div className="terminal-chrome" data-term-panel>
      <div className="terminal-chrome-body">{children}</div>
      <div className="terminal-chrome-hint" data-term-hint ref={hint.row}>
        <span className="terminal-chrome-hint-left" data-pane-strip ref={hint.strip}>
          {panes.map((pane) => (
            <span
              key={pane.paneId}
              className={`pane-strip-item ${pane.selected ? 'is-selected' : ''}`}
              data-pane-strip-item={pane.paneId}
            >
              {kindGlyph(pane.agent)} {pane.number} {kindLabel(pane.agent)}
            </span>
          ))}
        </span>
        <div className="terminal-chrome-hint-spacer" />
        <span className="terminal-chrome-hint-right" data-hint-keys ref={hint.list}>
          {HINTS.map((item, index) => {
            const hidden = index < dropped
            return (
              <span
                key={item.key}
                className={`hint-key ${hidden ? 'is-dropped' : ''}`}
                data-hint-key={item.key}
                data-hint-dropped={hidden ? 'true' : 'false'}
                aria-hidden={hidden}
              >
                {item.text}
              </span>
            )
          })}
        </span>
      </div>
    </div>
  )
}
