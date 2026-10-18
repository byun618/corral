// LIFE-637 R3·R4 — 세그먼트 표기와 패널 묶음·정렬 규칙.
import { describe, expect, it } from 'vitest'
import type { ResourceMeasure, ResourcePaneRow, ResourceSnapshot } from '../../shared/resource.js'
import { formatMemory, groupPanes, hostLine, measureCells, segmentLabel, segmentTooltip } from './resource-view.js'

const GB = 1024 ** 3
const MB = 1024 ** 2
const measured = (cpu: number, memory: number): ResourceMeasure => ({ state: 'measured', usage: { cpu, memory }, pids: [1] })
const row = (input: { paneId: string; group: string; measure: ResourceMeasure }): ResourcePaneRow => ({
  paneId: input.paneId, tabId: 't', workspaceId: 'w', groupKey: input.group, groupLabel: `label-${input.group}`, title: input.paneId, agent: null, measure: input.measure,
})
const snapshot = (patch: Partial<ResourceSnapshot>): ResourceSnapshot => ({
  collectedAt: 0, total: { cpu: 12.4, memory: 3.46 * GB }, unavailableCount: 0, app: measured(1, MB), herdr: measured(1, MB), panes: [],
  host: { totalMemory: 24 * GB, usedMemory: 20.5 * GB, cpuCoreCount: 12 },
  stats: { intervalMs: 2000, collections: 1, skippedHidden: 0, processInfoRequests: 0, recentDurationsMs: [] },
  ...patch,
})

describe('segmentLabel', () => {
  it('CPU n% · 메모리 x.x GB', () => {
    expect(segmentLabel(snapshot({}))).toBe('CPU 12% · 메모리 3.5 GB')
  })
  it('수집 전·측정 불가면 가짜 숫자 대신 —', () => {
    expect(segmentLabel(null)).toBe('CPU — · 메모리 —')
    expect(segmentLabel(snapshot({ total: null }))).toBe('CPU — · 메모리 —')
  })
  it('툴팁에 범위·RSS 표기, 빠진 칸 수', () => {
    expect(segmentTooltip(snapshot({}))).toContain('RSS(공유 메모리 중복 포함)')
    expect(segmentTooltip(snapshot({}))).toContain('corral 앱 + herdr 서버 + 모든 pane 자손')
    expect(segmentTooltip(snapshot({ unavailableCount: 2 }))).toContain('측정 불가 2칸')
  })
})

describe('행 표기', () => {
  it('1 GB 미만은 MB, 이상은 GB', () => {
    expect(formatMemory(241.5 * MB)).toBe('242 MB')
    expect(formatMemory(1.25 * GB)).toBe('1.3 GB')
  })
  it('측정 불가 칸은 — 와 사유', () => {
    expect(measureCells({ state: 'unavailable', reason: 'ppid 순환' })).toEqual({ cpu: '—', memory: '—', title: '측정 불가 — ppid 순환' })
  })
  it('시스템 한 줄', () => {
    expect(hostLine(snapshot({}))).toBe('시스템 메모리 20.5 GB / 24.0 GB · 코어 12개')
  })
})

describe('groupPanes', () => {
  const panes = [
    row({ paneId: 'a1', group: 'A', measure: measured(50, 100 * MB) }),
    row({ paneId: 'b1', group: 'B', measure: measured(1, 900 * MB) }),
    row({ paneId: 'a2', group: 'A', measure: measured(5, 300 * MB) }),
    row({ paneId: 'a3', group: 'A', measure: { state: 'unavailable', reason: 'x' } }),
  ]
  it('worktree 묶음 합계, 측정 불가는 합에서 빠지고 센다', () => {
    const groups = groupPanes({ panes, sort: 'memory' })
    const a = groups.find((group) => group.key === 'A')
    expect(a).toMatchObject({ label: 'label-A', usage: { cpu: 55, memory: 400 * MB }, unavailableCount: 1 })
  })
  it('기본 = 메모리 내림차순(묶음·행 모두), 측정 불가는 맨 뒤', () => {
    const groups = groupPanes({ panes, sort: 'memory' })
    expect(groups.map((group) => group.key)).toEqual(['B', 'A'])
    expect(groups[1]?.panes.map((pane) => pane.paneId)).toEqual(['a2', 'a1', 'a3'])
  })
  it('CPU 순', () => {
    const groups = groupPanes({ panes, sort: 'cpu' })
    expect(groups.map((group) => group.key)).toEqual(['A', 'B'])
    expect(groups[0]?.panes.map((pane) => pane.paneId)).toEqual(['a1', 'a2', 'a3'])
  })
  it('묶음 전체가 측정 불가면 usage null 이고 뒤로', () => {
    const groups = groupPanes({ panes: [row({ paneId: 'z', group: 'Z', measure: { state: 'unavailable', reason: 'x' } }), ...panes], sort: 'memory' })
    expect(groups.at(-1)).toMatchObject({ key: 'Z', usage: null, unavailableCount: 1 })
  })
})
