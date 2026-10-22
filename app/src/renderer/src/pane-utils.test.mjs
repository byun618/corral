// LIFE-691 K2 — 입력 pane 이 화면 활성 탭을 따라가는 규칙(`paneToFollow`).
import { describe, expect, it } from 'vitest'
import { paneToFollow } from './pane-utils.js'

const pane = (paneId, focused = false) => ({ paneId, tabId: 'w1:t2', workspaceId: 'w1', focused, agent: null })
const tab = { tabId: 'w1:t2', workspaceId: 'w1', panes: [pane('p2'), pane('p3', true)] }

describe('paneToFollow (K2)', () => {
  it('ⓐ 파일 탭 닫기로 터미널 탭 도착 — 선택 pane 이 다른 탭이면 그 탭의 pickPane', () => {
    expect(paneToFollow({ tab, selectedPane: 'p1' })).toBe('p3')
    expect(paneToFollow({ tab, selectedPane: null })).toBe('p3')
  })
  it('이미 그 탭의 pane 이 선택돼 있으면 바꾸지 않는다(분할 pane 선택 유지)', () => {
    expect(paneToFollow({ tab, selectedPane: 'p2' })).toBeNull()
  })
  it('ⓒ 화면 활성 탭이 파일 탭(tab null)이면 바꾸지 않는다', () => {
    expect(paneToFollow({ tab: null, selectedPane: 'p1' })).toBeNull()
  })
})
