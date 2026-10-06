// LIFE-495 K5ⓓ·K3ⓒ — 닫기 확인 문구의 분기.
import { describe, expect, it } from 'vitest'
import { closeCopy } from './close-copy.js'

const running = (paneId: string) => ({ tabId: 't1', paneId, foreground: ['sleep 100'] })

describe('closeCopy', () => {
  it('에이전트 pane 이 실행 중이면 「에이전트를 멈출까」 + 재개 불가 안내 + 「에이전트 멈추기」', () => {
    const copy = closeCopy({ kind: 'tabs', tabCount: 1, running: [running('p1')], agentPaneIds: new Set(['p1']), pinnedCount: 0 })
    expect(copy.kind).toBe('agent')
    expect(copy.title).toBe('에이전트를 멈출까')
    expect(copy.body).toContain('닫은 터미널은 자동으로 재개되지 않는다.')
    expect(copy.confirm).toBe('에이전트 멈추기')
  })
  it('섞여 있으면 에이전트가 이긴다(220 과 같다)', () => {
    expect(closeCopy({ kind: 'tabs', tabCount: 2, running: [running('p1'), running('p2')], agentPaneIds: new Set(['p2']), pinnedCount: 0 }).kind).toBe('agent')
  })
  it('에이전트가 아닌 실행 중이면 「실행 중인 명령을 멈출까」 + 「멈추고 닫기」', () => {
    const copy = closeCopy({ kind: 'tabs', tabCount: 1, running: [running('p1')], agentPaneIds: new Set(['p9']), pinnedCount: 0 })
    expect(copy).toEqual({ kind: 'command', title: '실행 중인 명령을 멈출까', body: ['이 탭을 닫으면 안에서 실행 중인 명령이 멈춘다.'], confirm: '멈추고 닫기', dontAskAgain: { label: '실행 중인 터미널에 대해 다시 묻지 않기', patch: { skipCloseTerminalWithRunningProcessConfirm: true } } })
  })
  it('핀 탭 — 실행 중이 아니면 「고정된 탭을 닫을까」, 실행 중이면 실행 중 문구 + 고정 안내(창은 한 번)', () => {
    expect(closeCopy({ kind: 'tabs', tabCount: 1, running: [], agentPaneIds: new Set(), pinnedCount: 1 })).toEqual({ kind: 'pinned', title: '고정된 탭을 닫을까', body: ['이 탭은 고정돼 있다. 정말 닫을까?'], confirm: '닫기', dontAskAgain: { label: '고정된 탭에 대해 다시 묻지 않기', patch: { confirmClosePinnedTab: false } } })
    const both = closeCopy({ kind: 'tabs', tabCount: 1, running: [running('p1')], agentPaneIds: new Set(), pinnedCount: 1 })
    expect(both.kind).toBe('command')
    expect(both.body).toContain('이 탭은 고정돼 있다.')
  })
  it('worktree 닫기 문구는 그대로(범위 밖) · 체크박스 없음(D3)', () => {
    expect(closeCopy({ kind: 'worktree' }).title).toBe('이 worktree 를 닫을까')
    expect(closeCopy({ kind: 'worktree' }).dontAskAgain).toBeNull()
  })
  it('「다시 묻지 않음」 은 라벨이 이름 붙인 설정 하나만 끈다(LIFE-516 K3ⓓ·D2) — 핀+실행 중 한 창은 실행 중 설정만', () => {
    const agent = closeCopy({ kind: 'tabs', tabCount: 1, running: [running('p1')], agentPaneIds: new Set(['p1']), pinnedCount: 1 })
    const both = closeCopy({ kind: 'tabs', tabCount: 1, running: [running('p1')], agentPaneIds: new Set(), pinnedCount: 1 })
    const pinned = closeCopy({ kind: 'tabs', tabCount: 1, running: [], agentPaneIds: new Set(), pinnedCount: 1 })
    for (const copy of [agent, both]) {
      expect(copy.dontAskAgain?.label).toContain('실행 중인 터미널')
      expect(copy.dontAskAgain?.patch).toEqual({ skipCloseTerminalWithRunningProcessConfirm: true })
    }
    expect(pinned.dontAskAgain?.label).toContain('고정된 탭')
    expect(pinned.dontAskAgain?.patch).toEqual({ confirmClosePinnedTab: false })
    for (const copy of [agent, both, pinned]) expect(Object.keys(copy.dontAskAgain?.patch ?? {})).toHaveLength(1)
  })
})
