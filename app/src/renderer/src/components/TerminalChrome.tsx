import { useBindingLabel } from '../hooks/BindingLabels.js'
import type { ActionId } from '../../../shared/keybindings.js'
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
 * **LIFE-387 B1 F-B1-4 로 순서가 뒤집혔다.** 옛 순서는 `⌘⌥D 새 영역`(영역 분할, 버튼이 없던 것)이
 * 맨 앞이라 **가장 먼저 버려졌다** — 발견성 문제의 원인 중 하나였다(00-analysis.md §B1). 새 순서는
 * design-handoff.md §1 Q2/§2 PaneStrip 힌트줄: `⌘⇧D → ⌘D → ⌘⇧Z → ⌘⌥D → ⌃Tab → ⌘T` — **버튼이
 * 있는 pane 분할부터 먼저 버리고, 버튼이 없었던 영역 분할(`⌘⌥D`)은 늦게 버린다.** 라벨도
 * `⌘⌥D 새 영역` → `⌘⌥D 탭 → 새 영역`(폭 74→98, "무엇이 옮겨지는가"를 말한다).
 *
 * `⌘W`(F2-5a, pane 닫기)는 핸드오프 §2 PaneStrip 힌트줄 절이 언급 안 하는 항목이라(그 절은
 * 6개만 나열) 옛 배치 원칙 그대로 **`⌘D` 뒤**에 끼운다 — 분할 셋은 헤더 버튼이라는 두 번째 입구가
 * 있지만 `✕`(pane 닫기)는 pane 이 하나면 사라져서 마지막 pane 에서 이 줄이 유일한 안내이기 때문
 * (이전 코디네이터 결정, 이번 라운드가 뒤집을 근거가 없어 유지).
 */
const HINTS: { key: string; id: ActionId; variant: number; text: string }[] = [
  { key: 'split-down', id: 'terminal.split', variant: 1, text: '아래 분할' },
  { key: 'split-right', id: 'terminal.split', variant: 0, text: '분할' },
  { key: 'close-pane', id: 'terminal.close', variant: 0, text: 'pane 닫기' },
  { key: 'zoom', id: 'terminal.zoom', variant: 0, text: '줌' },
  { key: 'split-group', id: 'group.split', variant: 0, text: '탭 → 새 영역' },
  { key: 'mru', id: 'mru.open', variant: 0, text: '전환' },
  { key: 'new-tab', id: 'terminal.new', variant: 0, text: '새 탭' },
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
function useHintFit(deps: { paneCount: number; bindings: string }): {
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
  }, [deps.paneCount, deps.bindings])
  return { row, strip, list, kept }
}

export function TerminalChrome({
  panes,
  children,
}: {
  panes: PaneStripItem[]
  children: React.ReactNode
}): React.JSX.Element {
  const bindingLabel = useBindingLabel()
  const labels = HINTS.map((item) => bindingLabel(item.id, item.variant))
  const hint = useHintFit({ paneCount: panes.length, bindings: labels.join('|') })
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
                {labels[index]} {item.text}
              </span>
            )
          })}
        </span>
      </div>
    </div>
  )
}
