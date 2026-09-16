// design-handoff.md §2 TerminalChrome — 감싸는 크롬만 대상, xterm.js 렌더 영역 자체는 미변경.
// 하단 24px 힌트줄: 좌 활성 영역의 **pane 스트립**, 우 ⌘T 힌트(실재하는 단축키 —
// Orca 의 "shift+tab 권한 순환"은 claude 전용이라 codex·grok·shell 탭에는 안 맞아 대체했다).
//
// 스트립이 **pane 식별의 유일한 자리**다 (§10-R21-1b). 장식 행 메타(R17-1)는 철회됐다 —
// herdr 장식 링이 상자 밖으로 나가 바깥 줄 pane 은 그 행이 화면에 안 섰다. 격자 수는 영역 헤더가 진다.
//
// 번호는 **화면 읽는 순서**이고 `numbersOf` 한 곳에서만 나온다 (C5-8) — 스트립과 MRU 가 같은
// 수를 써야 하므로 여기서 다시 세지 않는다.

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

export function TerminalChrome({
  panes,
  children,
}: {
  panes: PaneStripItem[]
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="terminal-chrome" data-term-panel>
      <div className="terminal-chrome-body">{children}</div>
      <div className="terminal-chrome-hint" data-term-hint>
        <span className="terminal-chrome-hint-left" data-pane-strip>
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
        <span className="terminal-chrome-hint-right">⌘T 새 탭</span>
      </div>
    </div>
  )
}
