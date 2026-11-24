// LIFE-834 fix1 G2 — pane id 로 선택 풀기. 마운트되지 않은 pane(다른 탭)은 오류 없이 아무것도 안 한다.
import { describe, expect, it } from 'vitest'
import { clearTerminalSelection, registerSelectionClearer } from './terminal-selection.js'

describe('terminal-selection', () => {
  it('등록된 pane 만 푼다 · 없으면 무동작 · 해제는 자기 것일 때만', () => {
    const calls: string[] = []
    const offA = registerSelectionClearer({ paneId: 'a', clear: () => calls.push('a1') })
    clearTerminalSelection('a')
    expect(() => clearTerminalSelection('not-mounted')).not.toThrow()
    // 같은 pane 이 다시 마운트되면 새 것이 이긴다 — 옛 해제가 새 것을 지우지 않는다
    const offA2 = registerSelectionClearer({ paneId: 'a', clear: () => calls.push('a2') })
    offA()
    clearTerminalSelection('a')
    offA2()
    clearTerminalSelection('a')
    expect(calls).toEqual(['a1', 'a2'])
  })
})
