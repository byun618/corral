// design-handoff.md §2 TerminalChrome — 감싸는 크롬만 대상, xterm.js 렌더 영역 자체는 미변경.
// 하단 24px 힌트줄: 좌 활성 세션의 pane 요약(실제 데이터), 우 ⌘T 힌트(실재하는 단축키 —
// Orca 의 "shift+tab 권한 순환"은 claude 전용이라 codex·grok·shell 탭에는 안 맞아 대체했다).
import type { TabRow } from '../../../shared/types.js'

function paneSummary(tab: TabRow | null): string {
  if (tab === null || tab.panes.length === 0) return ''
  return tab.panes.map((pane, index) => `pane ${index + 1} · ${pane.agent ?? 'shell'}`).join('  ·  ')
}

export function TerminalChrome({ activeTab, children }: { activeTab: TabRow | null; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="terminal-chrome" data-term-panel>
      <div className="terminal-chrome-body">{children}</div>
      <div className="terminal-chrome-hint" data-term-hint>
        <span className="terminal-chrome-hint-left">{paneSummary(activeTab)}</span>
        <div className="terminal-chrome-hint-spacer" />
        <span className="terminal-chrome-hint-right">⌘T 새 탭</span>
      </div>
    </div>
  )
}
