// LIFE-495 fix1 R1-05 — bulk 탭 닫기의 닫기 직전 재판정. herdr·프로세스 경계만 mock 한다(Codex r1 `gate.log` 모양).
import { describe, expect, it } from 'vitest'
import type { RunningPane } from '../shared/types.js'
import { closeTabsGated, type CloseTabOutcome } from './close-tabs.js'

/** pane 별 「지금 실행 중인가」 — 테스트가 순간마다 바꾼다. */
function world(input: { panes: Record<string, string[]> }) {
  const running = new Set<string>()
  const log: string[] = []
  const deps = {
    panesOf: (tabId: string) => input.panes[tabId] ?? null,
    probe: async (panes: readonly { tabId: string; paneId: string }[]): Promise<RunningPane[]> => {
      log.push(`probe ${panes.map((pane) => pane.paneId).join(',')}`)
      return panes.filter((pane) => running.has(pane.paneId)).map((pane) => ({ ...pane, foreground: ['sleep 600'] }))
    },
    close: async (tabId: string): Promise<CloseTabOutcome> => {
      log.push(`close ${tabId}`)
      return { outcome: 'closed' }
    },
  }
  return { running, log, deps }
}

describe('closeTabsGated — 닫기 직전 재판정 (fix1 R1-05)', () => {
  it('전부 idle 로 판정한 뒤 앞 탭에서 명령이 시작되면 그 탭을 닫지 않고 needs-confirm', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    const probe = w.deps.probe
    let calls = 0
    // 처음 판정(pA·pB idle)이 끝난 직후 pA 에서 명령이 시작된다.
    w.deps.probe = async (panes) => {
      const result = await probe(panes)
      calls += 1
      if (calls === 1) w.running.add('pA')
      return result
    }
    const result = await closeTabsGated({ tabIds: ['A', 'B'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [], ...w.deps })
    expect(result).toEqual({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 'A', paneId: 'pA', foreground: ['sleep 600'] }] })
    expect(w.log.filter((line) => line.startsWith('close'))).toEqual([])
  })
  it('확인한 실행 중(pA)은 닫고, 확인 뒤 새로 실행된 pB 에서 멈춘다 — 닫힌 A 는 돌려준다', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    w.running.add('pA')
    const close = w.deps.close
    w.deps.close = async (tabId) => {
      const outcome = await close(tabId)
      if (tabId === 'A') w.running.add('pB')
      return outcome
    }
    const result = await closeTabsGated({ tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmedPaneIds: ['pA'], ...w.deps })
    expect(result).toEqual({ outcome: 'needs-confirm', closed: ['A'], running: [{ tabId: 'B', paneId: 'pB', foreground: ['sleep 600'] }] })
  })
  it('변화가 없으면 확인한 대로 전부 닫는다 · 탭마다 닫기 직전 판정', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB', 'pB2'] } })
    w.running.add('pB2')
    const result = await closeTabsGated({ tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmedPaneIds: ['pB2'], ...w.deps })
    expect(result).toEqual({ outcome: 'closed', closed: ['A', 'B'] })
    expect(w.log).toEqual(['probe pA', 'close A', 'probe pB,pB2', 'close B'])
  })
  it('확인 전: 실행 중이 있거나 alwaysConfirm 이면 하나도 닫지 않고 needs-confirm', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    w.running.add('pB')
    expect(await closeTabsGated({ tabIds: ['A', 'B'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [], ...w.deps })).toEqual({
      outcome: 'needs-confirm', closed: [], running: [{ tabId: 'B', paneId: 'pB', foreground: ['sleep 600'] }],
    })
    w.running.clear()
    expect(await closeTabsGated({ tabIds: ['A'], confirmed: false, alwaysConfirm: true, confirmedPaneIds: [], ...w.deps })).toEqual({ outcome: 'needs-confirm', closed: [], running: [] })
    expect(w.log.filter((line) => line.startsWith('close'))).toEqual([])
  })
  it('없는 탭은 건너뛰고, herdr 거절이면 거기서 멈춘다', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'], C: ['pC'] } })
    w.deps.close = async (tabId): Promise<CloseTabOutcome> => (tabId === 'B' ? { outcome: 'rejected', rejection: { code: 'x', message: 'no' } } : { outcome: 'closed' })
    expect(await closeTabsGated({ tabIds: ['Z', 'A', 'B', 'C'], confirmed: true, alwaysConfirm: false, confirmedPaneIds: [], ...w.deps })).toEqual({
      outcome: 'rejected', closed: ['A'], rejection: { code: 'x', message: 'no' },
    })
  })
})
