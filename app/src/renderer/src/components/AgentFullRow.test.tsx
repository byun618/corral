// Full list 행 (LIFE-477 K6ⓑⓒⓓ) — 1줄 구성·2줄 도구/자리/없음·3줄 메시지/중단/빈 자리·시간 문구·hover 닫기 칸.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentFullContent, AgentRowNode } from '../sidebar-agents.js'
import { AgentFullRow } from './AgentFullRow.js'

function node(full: Partial<AgentFullContent>, extra: Partial<AgentRowNode> = {}): AgentRowNode {
  return {
    key: 'p1', source: 'live', paneId: 'p1', tabId: 't1', activationPaneId: 'p1', kind: 'claude', showIcon: true, dot: 'working', unseenDone: false,
    text: { leading: 'x', trailing: null, full: 'x' },
    full: { label: 'Fix tests', tool: { kind: 'none' }, interrupted: false, message: null, ...full },
    model: 'opus', timeAt: 0, children: [], ...extra,
  }
}
const render = (input: AgentRowNode, child = false): string =>
  renderToStaticMarkup(createElement(AgentFullRow, { node: input, now: 5 * 60_000, focused: false, child, disclosure: null, reserveGutter: false, onActivate: () => {}, onClose: () => {} }))

describe('AgentFullRow', () => {
  it('1줄 — 점 · 아이콘 · 라벨 · 모델 · 시간(「N분 전」) · 닫기 버튼(live)', () => {
    const html = render(node({}))
    expect(html).toContain('data-agent-full-label="" title="Fix tests">Fix tests</span>')
    expect(html).toContain('data-agent-kind="claude"')
    expect(html).toContain('agent-row-model')
    expect(html).toContain('data-elapsed="5분 전"')
    expect(html).toContain('data-close-pane="p1"')
  })
  it('2줄 — 도구면 렌치·이름·입력, 자리면 빈 1lh, none 이면 줄 없음', () => {
    expect(render(node({ tool: { kind: 'tool', name: 'Bash', input: 'npm test' } }))).toMatch(/data-agent-row-tool-header.*Bash.*npm test/)
    const placeholder = render(node({ tool: { kind: 'placeholder' } }))
    expect(placeholder).toContain('data-agent-row-tool-placeholder')
    expect(placeholder).not.toContain('data-agent-row-tool-header')
    expect(render(node({}))).not.toContain('data-agent-row-tool-slot')
  })
  it('3줄 — 메시지 한 줄, 중단 태그, 둘 다 없으면 공백 1자 빈 자리(198 그대로)', () => {
    expect(render(node({ message: 'all green' }))).toContain('agent-full-message-text" title="all green">all green')
    const interrupted = render(node({ interrupted: true, message: 'stopped here' }))
    expect(interrupted).toContain('agent-full-interrupted')
    expect(interrupted).toContain('중단됨')
    expect(render(node({}))).toContain('<div class="agent-full-message is-empty" data-agent-row-message="empty"> </div>')
  })
  it('서브에이전트 — 아이콘 없음, 닫기 없음(시간만), 자식 행 클래스', () => {
    const html = render(node({}, { source: 'subagent', showIcon: false }), true)
    expect(html).not.toContain('data-agent-kind')
    expect(html).not.toContain('data-close-pane')
    expect(html).toContain('is-child')
    expect(html).toContain('data-elapsed="5분 전"')
  })
  it('안 본 완료는 라벨 굵게(B1 그대로)', () => {
    expect(render(node({}, { unseenDone: true, dot: 'done' }))).toContain('is-unseen-done')
  })
})
