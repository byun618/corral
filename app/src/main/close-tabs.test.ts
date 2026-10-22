// LIFE-495 fix1 R1-05 — bulk 탭 닫기의 닫기 직전 재판정. herdr·프로세스 경계만 mock 한다(Codex r1 `gate.log` 모양).
import { describe, expect, it } from 'vitest'
import type { RunningPane } from '../shared/types.js'
import { closeTabsGated, runningForeground, type CloseTabOutcome, type ForegroundRead } from './close-tabs.js'

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
    const result = await closeTabsGated({ tabIds: ['A', 'B'], confirmed: false, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: [], ...w.deps })
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
    const result = await closeTabsGated({ tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: ['pA'], ...w.deps })
    expect(result).toEqual({ outcome: 'needs-confirm', closed: ['A'], running: [{ tabId: 'B', paneId: 'pB', foreground: ['sleep 600'] }] })
  })
  it('변화가 없으면 확인한 대로 전부 닫는다 · 탭마다 닫기 직전 판정', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB', 'pB2'] } })
    w.running.add('pB2')
    const result = await closeTabsGated({ tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: ['pB2'], ...w.deps })
    expect(result).toEqual({ outcome: 'closed', closed: ['A', 'B'] })
    expect(w.log).toEqual(['probe pA', 'close A', 'probe pB,pB2', 'close B'])
  })
  it('확인 전: 실행 중이 있거나 alwaysConfirm 이면 하나도 닫지 않고 needs-confirm', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    w.running.add('pB')
    expect(await closeTabsGated({ tabIds: ['A', 'B'], confirmed: false, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: [], ...w.deps })).toEqual({
      outcome: 'needs-confirm', closed: [], running: [{ tabId: 'B', paneId: 'pB', foreground: ['sleep 600'] }],
    })
    w.running.clear()
    expect(await closeTabsGated({ tabIds: ['A'], confirmed: false, alwaysConfirm: true, confirmRunning: true, confirmedPaneIds: [], ...w.deps })).toEqual({ outcome: 'needs-confirm', closed: [], running: [] })
    expect(w.log.filter((line) => line.startsWith('close'))).toEqual([])
  })
  it('없는 탭은 건너뛰고, herdr 거절이면 거기서 멈춘다', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'], C: ['pC'] } })
    w.deps.close = async (tabId): Promise<CloseTabOutcome> => (tabId === 'B' ? { outcome: 'rejected', rejection: { code: 'x', message: 'no' } } : { outcome: 'closed' })
    expect(await closeTabsGated({ tabIds: ['Z', 'A', 'B', 'C'], confirmed: true, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: [], ...w.deps })).toEqual({
      outcome: 'rejected', closed: ['A'], rejection: { code: 'x', message: 'no' },
    })
  })
})

describe('closeTabsGated — 실행 중 확인 설정 (LIFE-516 K4ⓑ·ⓖ)', () => {
  it('설정 꺼짐 · 미confirmed: 실행 중이어도 창 없이 전부 닫는다 — 판정·재판정 probe 없음', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    w.running.add('pA')
    w.running.add('pB')
    expect(await closeTabsGated({ tabIds: ['A', 'B'], confirmed: false, alwaysConfirm: false, confirmRunning: false, confirmedPaneIds: [], ...w.deps })).toEqual({ outcome: 'closed', closed: ['A', 'B'] })
    expect(w.log).toEqual(['close A', 'close B'])
  })
  it('설정 꺼짐 · confirmed(핀 확인 뒤): 확인 밖 실행 중이 생겨도 재판정으로 다시 묻지 않는다', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    const close = w.deps.close
    w.deps.close = async (tabId) => {
      const outcome = await close(tabId)
      if (tabId === 'A') w.running.add('pB')
      return outcome
    }
    expect(await closeTabsGated({ tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmRunning: false, confirmedPaneIds: [], ...w.deps })).toEqual({ outcome: 'closed', closed: ['A', 'B'] })
  })
  it('설정 꺼짐 + 핀(alwaysConfirm): 핀 사유만 남아 한 번 묻는다 — running 은 비어 핀 문구만', async () => {
    const w = world({ panes: { A: ['pA'] } })
    w.running.add('pA')
    expect(await closeTabsGated({ tabIds: ['A'], confirmed: false, alwaysConfirm: true, confirmRunning: false, confirmedPaneIds: [], ...w.deps })).toEqual({ outcome: 'needs-confirm', closed: [], running: [] })
    expect(w.log).toEqual([])
  })
  it('설정 켜짐(기본): 미confirmed 실행 중 → needs-confirm · confirmed 뒤 확인 밖 실행 중 → 재판정 needs-confirm (지금 동작 그대로)', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    w.running.add('pA')
    expect((await closeTabsGated({ tabIds: ['A', 'B'], confirmed: false, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: [], ...w.deps })).outcome).toBe('needs-confirm')
    w.running.add('pB')
    expect(await closeTabsGated({ tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: ['pA'], ...w.deps })).toEqual({
      outcome: 'needs-confirm', closed: ['A'], running: [{ tabId: 'B', paneId: 'pB', foreground: ['sleep 600'] }],
    })
  })
})

// LIFE-628 F4 — 런타임 없는 pane(pane_not_found)은 실행 중이 아니다. 다른 판정 실패는 지금처럼 실행 중(모르면 묻는다).
describe('runningForeground (LIFE-628 F4)', () => {
  const read = (patch: Partial<ForegroundRead>): ForegroundRead => ({ ok: true, shellPid: 10, foregroundGroupId: 10, foreground: [], error: null, missing: false, ...patch })
  it('셸만이면 null', () => {
    expect(runningForeground(read({}))).toBeNull()
  })
  it('G7 — ok 인데 셸 pid 를 모르면(그룹이 같아 보여도) 실행 중 쪽 — 셸만이라고 단정하지 않는다', () => {
    expect(runningForeground(read({ shellPid: null, foregroundGroupId: null }))).toEqual(['(알 수 없는 프로세스)'])
    expect(runningForeground(read({ shellPid: null, foregroundGroupId: null, foreground: [{ name: 'zsh', cmdline: null }] }))).toEqual(['zsh'])
  })
  it('pane_not_found(missing)이면 null — 「프로세스 확인 실패」 로 묻지 않는다', () => {
    expect(runningForeground(read({ ok: false, shellPid: null, foregroundGroupId: null, error: 'pane_not_found: x', missing: true }))).toBeNull()
  })
  it('그 밖의 판정 실패는 실행 중으로 기운다', () => {
    expect(runningForeground(read({ ok: false, shellPid: null, foregroundGroupId: null, error: 'timeout', missing: false }))).toEqual(['(프로세스 확인 실패: timeout)'])
  })
  it('셸 아닌 포그라운드 — 목록, 비면 (알 수 없는 프로세스)', () => {
    expect(runningForeground(read({ foregroundGroupId: 11, foreground: [{ name: 'vim', cmdline: 'vim a' }] }))).toEqual(['vim a'])
    expect(runningForeground(read({ foregroundGroupId: 11 }))).toEqual(['(알 수 없는 프로세스)'])
  })
})

describe('closeTabsGated — prepare (LIFE-628 G3)', () => {
  it('탭마다 준비 → 판정 → 닫기 순서 — 준비가 판정과 닫기 사이에 끼지 않는다', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    const result = await closeTabsGated({ ...w.deps, tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: [],
      prepare: async (tabId) => { w.log.push(`prepare ${tabId}`); return { outcome: 'ready' } } })
    expect(result).toEqual({ outcome: 'closed', closed: ['A', 'B'] })
    expect(w.log).toEqual(['prepare A', 'probe pA', 'close A', 'prepare B', 'probe pB', 'close B'])
  })
  it('준비가 skipped 면 그 탭은 판정·닫기 없이 다음으로, error 면 멈춘다(그때까지 닫은 것만)', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'], C: ['pC'] } })
    const result = await closeTabsGated({ ...w.deps, tabIds: ['A', 'B', 'C'], confirmed: true, alwaysConfirm: false, confirmRunning: true, confirmedPaneIds: [],
      prepare: async (tabId) => (tabId === 'A' ? { outcome: 'skipped' } : tabId === 'C' ? { outcome: 'error', error: 'read' } : { outcome: 'ready' }) })
    expect(result).toEqual({ outcome: 'error', closed: ['B'], error: 'read' })
    expect(w.log).toEqual(['probe pB', 'close B'])
  })
  it('준비 뒤 panesOf 가 null 이 되면(사이에 사라짐) 닫지 않는다', async () => {
    const panes: Record<string, string[]> = { A: ['pA'] }
    const w = world({ panes })
    const result = await closeTabsGated({ ...w.deps, tabIds: ['A'], confirmed: true, alwaysConfirm: false, confirmRunning: false, confirmedPaneIds: [],
      prepare: async () => { delete panes['A']; return { outcome: 'ready' } } })
    expect(result).toEqual({ outcome: 'closed', closed: [] })
    expect(w.log).toEqual([])
  })
})

describe('closeTabsGated — skipped (LIFE-628 F2)', () => {
  it('close 가 skipped 면 closed 에 넣지 않고 다음으로 간다', async () => {
    const w = world({ panes: { A: ['pA'], B: ['pB'] } })
    const result = await closeTabsGated({ ...w.deps, tabIds: ['A', 'B'], confirmed: true, alwaysConfirm: false, confirmRunning: false, confirmedPaneIds: [], close: async (tabId) => (tabId === 'A' ? { outcome: 'skipped' } : { outcome: 'closed' }) })
    expect(result).toEqual({ outcome: 'closed', closed: ['B'] })
  })
})
