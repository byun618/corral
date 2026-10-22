// LIFE-637 R3·R4 · LIFE-676 R3·R4·R5 — 세그먼트 표기(CPU 척도·메모리 문구)와 패널 묶음·정렬·시스템 줄 규칙.
import { describe, expect, it } from 'vitest'
import type { ResourceHost, ResourceMeasure, ResourcePaneRow, ResourceSnapshot } from '../../shared/resource.js'
import {
  formatCpu,
  formatMachineCpu,
  formatMemory,
  groupPanes,
  groupTooltip,
  hostLine,
  measureCells,
  memoryText,
  bulkOrphanTargets,
  orphanCloseCopy,
  orphanKindText,
  orphanPathText,
  sortOrphans,
  RESOURCE_MEMORY_NOTE,
  RESOURCE_ROW_CPU_TOOLTIP,
  rowTitles,
  segmentLabel,
  segmentTooltip,
} from './resource-view.js'

const GB = 1024 ** 3
const MB = 1024 ** 2
const measured = (cpu: number, memory: number): ResourceMeasure => ({ state: 'measured', usage: { cpu, memory: { state: 'measured', bytes: memory } }, pids: [1] })
const memoryLost = (cpu: number, reason: string): ResourceMeasure => ({ state: 'measured', usage: { cpu, memory: { state: 'unavailable', reason } }, pids: [1] })
const row = (input: { paneId: string; group: string; measure: ResourceMeasure }): ResourcePaneRow => ({
  paneId: input.paneId, tabId: 't', workspaceId: 'w', groupKey: input.group, groupLabel: `label-${input.group}`, title: input.paneId, agent: null, measure: input.measure,
})
const HOST: ResourceHost = { physicalMemory: 24 * GB, cpuCoreCount: 18, pressure: 'warning', swap: { used: 23.3 * GB, total: 24 * GB }, compressed: 8.4 * GB }
const snapshot = (patch: Partial<ResourceSnapshot>): ResourceSnapshot => ({
  collectedAt: 0, total: { cpu: 360, memory: { state: 'measured', bytes: 3.46 * GB } }, unavailableCount: 0, app: measured(1, MB), herdr: measured(1, MB), panes: [], orphans: [],
  host: HOST,
  stats: { intervalMs: 2000, collections: 1, skippedHidden: 0, processInfoRequests: 0, footprintRuns: 0, hostReads: 0, recentDurationsMs: [] },
  ...patch,
})

describe('segmentLabel — R3ⓐ 맥 전체 대비', () => {
  it('합 360 · 코어 18 → CPU 20%', () => {
    expect(segmentLabel(snapshot({}))).toBe('CPU 20% · 메모리 3.5 GB')
  })
  it('0~100 을 넘지 않는다 · 정수', () => {
    expect(formatMachineCpu({ cpu: 1900, cpuCoreCount: 18 })).toBe('100%')
    expect(formatMachineCpu({ cpu: 0, cpuCoreCount: 18 })).toBe('0%')
    expect(formatMachineCpu({ cpu: 1799, cpuCoreCount: 18 })).toBe('100%')
    expect(formatMachineCpu({ cpu: 99, cpuCoreCount: 18 })).toBe('6%')
  })
  it('R3ⓔ 코어 수 0·미상이면 —', () => {
    expect(formatMachineCpu({ cpu: 360, cpuCoreCount: 0 })).toBe('—')
    expect(formatMachineCpu({ cpu: 360, cpuCoreCount: Number.NaN })).toBe('—')
    expect(segmentLabel(snapshot({ host: { ...HOST, cpuCoreCount: 0 } }))).toBe('CPU — · 메모리 3.5 GB')
  })
  it('수집 전·측정 불가면 가짜 숫자 대신 —', () => {
    expect(segmentLabel(null)).toBe('CPU — · 메모리 —')
    expect(segmentLabel(snapshot({ total: null }))).toBe('CPU — · 메모리 —')
  })
  it('Q2 메모리를 못 재면 숫자 대신 측정 불가 — CPU 는 그대로', () => {
    expect(segmentLabel(snapshot({ total: { cpu: 360, memory: { state: 'unavailable', reason: 'footprint 도우미가 없다 (/x)' } } }))).toBe('CPU 20% · 메모리 측정 불가')
  })
})

describe('segmentTooltip — R3ⓓ·R4 문구', () => {
  const tooltip = segmentTooltip(snapshot({}))
  it('corral 사용분 · 맥 전체 대비 기준과 행 기준 — 맥 전체 사용률로 읽히지 않는다(게이트 ① 수정 1)', () => {
    expect(tooltip.split('\n')).toContain('CPU = corral(앱·herdr·pane)이 쓴 몫, 맥 전체 대비(코어 18개 = 100%) — 맥 전체 사용률이 아니다(다른 앱 제외) · 패널의 앱·herdr·묶음·pane 행은 코어 하나 = 100%')
    expect(tooltip).toContain('코어 18개 = 100%')
    expect(tooltip).toContain('맥 전체 사용률이 아니다')
  })
  it('메모리 = 활동 상태 보기 「메모리」 열 값의 합 — RSS 문구 없음, 공유 메모리 중복 주장 없음', () => {
    expect(RESOURCE_MEMORY_NOTE).toBe('메모리 = 활동 상태 보기 「메모리」 열 값(압축·swap 된 몫 포함)의 합')
    expect(tooltip).toContain(RESOURCE_MEMORY_NOTE)
    expect(tooltip).not.toContain('RSS')
    expect(tooltip).not.toContain('공유 메모리')
    expect(tooltip).not.toContain('중복')
  })
  it('범위·빠진 칸 수', () => {
    expect(tooltip.split('\n')[0]).toBe('CPU 20% · 메모리 3.5 GB')
    expect(tooltip).toContain('corral 앱 + herdr 서버 + 모든 pane 자손')
    expect(segmentTooltip(snapshot({ unavailableCount: 2 }))).toContain('측정 불가 2칸')
  })
  it('메모리 측정 불가 사유 · 일부 칸만 못 잰 경우', () => {
    expect(segmentTooltip(snapshot({ total: { cpu: 1, memory: { state: 'unavailable', reason: 'footprint 도우미 시한 초과 (2000 ms)' } } }))).toContain('메모리 측정 불가 — footprint 도우미 시한 초과 (2000 ms)')
    // C1-1 — 하한 합은 라벨에 `≥`, 툴팁에 무엇이 빠졌는지.
    const lower = snapshot({ total: { cpu: 360, memory: { state: 'partial', bytes: 3.46 * GB, reason: '일부 pid 를 뺀 칸 1개' } } })
    expect(segmentLabel(lower)).toBe('CPU 20% · 메모리 ≥ 3.5 GB')
    expect(segmentTooltip(lower)).toContain('메모리 하한 — 일부 pid 를 뺀 칸 1개')
  })
  it('코어 수를 모르면 기준 숫자를 지어내지 않는다', () => {
    expect(segmentTooltip(snapshot({ host: { ...HOST, cpuCoreCount: 0 } }))).toContain('코어 수를 몰라 표시하지 않는다')
  })
})

describe('행 표기 — R3ⓑ 코어당', () => {
  it('행 CPU 는 코어당 — 합 360 → 360%', () => {
    expect(formatCpu(360)).toBe('360%')
    expect(measureCells(measured(360, MB)).cpu).toBe('360%')
    expect(RESOURCE_ROW_CPU_TOOLTIP).toBe('CPU — 코어 하나 = 100%')
  })
  it('1 GB 미만은 MB, 이상은 GB', () => {
    expect(formatMemory(241.5 * MB)).toBe('242 MB')
    expect(formatMemory(1.25 * GB)).toBe('1.3 GB')
    // C3-4 — 1 GiB 경계: 정확히 1 GiB 부터 GB.
    expect(formatMemory(GB)).toBe('1.0 GB')
    expect(formatMemory(GB - MB)).toBe('1023 MB')
  })
  it('측정 불가 칸은 — 와 사유', () => {
    expect(measureCells({ state: 'unavailable', reason: 'ppid 순환' })).toEqual({ cpu: '—', memory: '—', title: '측정 불가 — ppid 순환' })
  })
  it('Q2 메모리만 못 잰 칸 — CPU 는 숫자, 메모리는 측정 불가와 사유', () => {
    expect(measureCells(memoryLost(12, 'pid 7 의 footprint 를 못 읽었다 (errno 1)'))).toEqual({ cpu: '12%', memory: '측정 불가', title: '메모리 측정 불가 — pid 7 의 footprint 를 못 읽었다 (errno 1)' })
  })
})

describe('hostLine — R5ⓐⓓ 시스템 줄 (Q4)', () => {
  it('압박 · swap 사용/전체 · 압축 · 물리 · 코어', () => {
    expect(hostLine(snapshot({}))).toBe('메모리 압박 경고 · swap 23.3 / 24.0 GB · 압축 8.4 GB · 물리 24 GB · 코어 18개')
    expect(hostLine(snapshot({ host: { ...HOST, pressure: 'normal' } }))).toContain('메모리 압박 정상')
    expect(hostLine(snapshot({ host: { ...HOST, pressure: 'critical' } }))).toContain('메모리 압박 위험')
  })
  it('「사용 / 전체 메모리」 는 없다', () => {
    expect(hostLine(snapshot({}))).not.toContain('시스템 메모리')
  })
  it('못 읽은 지표는 그 조각만 —', () => {
    expect(hostLine(snapshot({ host: { ...HOST, pressure: null } }))).toBe('메모리 압박 — · swap 23.3 / 24.0 GB · 압축 8.4 GB · 물리 24 GB · 코어 18개')
    expect(hostLine(snapshot({ host: { ...HOST, swap: null } }))).toBe('메모리 압박 경고 · swap — · 압축 8.4 GB · 물리 24 GB · 코어 18개')
    expect(hostLine(snapshot({ host: { ...HOST, compressed: null } }))).toBe('메모리 압박 경고 · swap 23.3 / 24.0 GB · 압축 — · 물리 24 GB · 코어 18개')
    expect(hostLine(snapshot({ host: { ...HOST, physicalMemory: 0, cpuCoreCount: 0 } }))).toBe('메모리 압박 경고 · swap 23.3 / 24.0 GB · 압축 8.4 GB · 물리 — · 코어 —')
    expect(hostLine(snapshot({ host: { physicalMemory: 0, cpuCoreCount: 0, pressure: null, swap: null, compressed: null } }))).toBe('메모리 압박 — · swap — · 압축 — · 물리 — · 코어 —')
  })
  it('swap 이 0 이면 0 그대로(못 읽음과 다르다)', () => {
    expect(hostLine(snapshot({ host: { ...HOST, swap: { used: 0, total: 0 } } }))).toContain('swap 0.0 / 0.0 GB')
  })
  it('물리 = 반올림 정수 GB (M31 — 정수 GiB 가 아닌 값으로 round·floor 를 가른다)', () => {
    expect(hostLine(snapshot({ host: { ...HOST, physicalMemory: 23.6 * GB } }))).toContain('물리 24 GB')
    expect(hostLine(snapshot({ host: { ...HOST, physicalMemory: 15.4 * GB } }))).toContain('물리 15 GB')
  })
})

describe('groupPanes', () => {
  const panes = [
    row({ paneId: 'a1', group: 'A', measure: measured(50, 100 * MB) }),
    row({ paneId: 'b1', group: 'B', measure: measured(1, 900 * MB) }),
    row({ paneId: 'a2', group: 'A', measure: measured(5, 300 * MB) }),
    row({ paneId: 'a3', group: 'A', measure: { state: 'unavailable', reason: 'x' } }),
  ]
  it('worktree 묶음 합계, 측정 불가는 합에서 빠지고 센다 — 묶음 CPU 는 코어당 합', () => {
    const groups = groupPanes({ panes, sort: 'memory' })
    const a = groups.find((group) => group.key === 'A')
    expect(a).toMatchObject({ label: 'label-A', usage: { cpu: 55, memory: { state: 'measured', bytes: 400 * MB } }, unavailableCount: 1 })
    expect(a === undefined ? null : groupTooltip(a)).toBe('측정 불가 1개는 합에서 빠졌다')
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
  it('Q2 메모리만 못 잰 pane — 묶음 메모리 합에서 빠지고 세며, 메모리순이면 맨 뒤 · CPU 순이면 CPU 대로', () => {
    const mixed = [...panes, row({ paneId: 'a4', group: 'A', measure: memoryLost(99, 'pid 9 의 footprint 를 못 읽었다 (errno 1)') })]
    const byMemory = groupPanes({ panes: mixed, sort: 'memory' })
    const a = byMemory.find((group) => group.key === 'A')
    expect(a).toMatchObject({ usage: { cpu: 154, memory: { state: 'partial', bytes: 400 * MB, reason: '메모리를 못 잰 칸 1개' } }, unavailableCount: 1 })
    expect(a?.panes.map((pane) => pane.paneId)).toEqual(['a2', 'a1', 'a3', 'a4'])
    expect(a === undefined ? null : groupTooltip(a)).toBe('측정 불가 1개는 합에서 빠졌다\n메모리 하한 — 메모리를 못 잰 칸 1개')
    expect(groupPanes({ panes: mixed, sort: 'cpu' }).find((group) => group.key === 'A')?.panes.map((pane) => pane.paneId)).toEqual(['a4', 'a1', 'a2', 'a3'])
  })
  it('묶음 전체가 메모리만 못 쟀으면 메모리 측정 불가(사유)', () => {
    const groups = groupPanes({ panes: [row({ paneId: 'm', group: 'M', measure: memoryLost(3, 'footprint 도우미가 없다 (/x)') })], sort: 'memory' })
    expect(groups[0]?.usage).toEqual({ cpu: 3, memory: { state: 'unavailable', reason: 'footprint 도우미가 없다 (/x)' } })
    expect(groups[0] === undefined ? null : groupTooltip(groups[0])).toBe('메모리 측정 불가 — footprint 도우미가 없다 (/x)')
  })
  it('C1-1 하한 pane — 행은 `≥ x`·사유, 묶음 합도 하한 표식, 메모리순은 하한 값으로', () => {
    const partial: ResourceMeasure = { state: 'measured', usage: { cpu: 7, memory: { state: 'partial', bytes: 1.2 * GB, reason: 'pid 9 (권한 없음 — root·다른 사용자로 실행 중) 제외' } }, pids: [9] }
    expect(measureCells(partial)).toEqual({ cpu: '7%', memory: '≥ 1.2 GB', title: '메모리 하한 — pid 9 (권한 없음 — root·다른 사용자로 실행 중) 제외' })
    const groups = groupPanes({ panes: [...panes, row({ paneId: 'a5', group: 'A', measure: partial })], sort: 'memory' })
    const a = groups.find((group) => group.key === 'A')
    expect(a?.usage?.memory).toEqual({ state: 'partial', bytes: 400 * MB + 1.2 * GB, reason: '일부 pid 를 뺀 칸 1개' })
    expect(a === undefined || a.usage === null ? null : memoryText(a.usage.memory)).toBe('≥ 1.6 GB')
    expect(groups.map((group) => group.key)).toEqual(['A', 'B'])
    expect(a?.panes.map((pane) => pane.paneId)).toEqual(['a5', 'a2', 'a1', 'a3'])
  })
  it('C1-4 rowTitles — 사유가 있으면 CPU 칸 title 을 달지 않고 행 툴팁 끝에 CPU 기준', () => {
    expect(rowTitles(null)).toEqual({ row: null, cpu: 'CPU — 코어 하나 = 100%' })
    expect(rowTitles('측정 불가 — ppid 순환')).toEqual({ row: '측정 불가 — ppid 순환\nCPU — 코어 하나 = 100%', cpu: undefined })
  })
})

describe('카드 밖 workspace 표시 (LIFE-628)', () => {
  const orphanRow = (input: { id: string; paths: { path: string; exists: boolean }[]; agents?: string[]; stoppedAgents?: string[]; ownerless?: boolean; measure: ResourceMeasure }) => ({
    workspaceId: input.id, label: `ws-${input.id}`, paths: input.paths, ownerless: input.ownerless ?? true, agents: input.agents ?? [], stoppedAgents: input.stoppedAgents ?? [], paneIds: [`p-${input.id}`], measure: input.measure,
  })
  it('경로 — 없으면 (없음), 여럿이면 외 n, 모르면 workspace 이름', () => {
    expect(orphanPathText(orphanRow({ id: 'a', paths: [{ path: '/wt/x', exists: false }], measure: measured(1, MB) }))).toBe('/wt/x (없음)')
    expect(orphanPathText(orphanRow({ id: 'a', paths: [{ path: '/home', exists: true }, { path: '/tmp', exists: true }], measure: measured(1, MB) }))).toBe('/home 외 1')
    expect(orphanPathText(orphanRow({ id: 'a', paths: [], measure: measured(1, MB) }))).toBe('ws-a')
  })
  it('종류 — 에이전트 이름들, 없으면 shell', () => {
    expect(orphanKindText(orphanRow({ id: 'a', paths: [], agents: ['claude', 'codex'], measure: measured(1, MB) }))).toBe('claude, codex')
    expect(orphanKindText(orphanRow({ id: 'a', paths: [], measure: measured(1, MB) }))).toBe('shell')
  })
  it('F4 종류 — 세션 참조만 남은 에이전트는 이름 + (중지됨), 살아 있는 에이전트와 함께', () => {
    expect(orphanKindText(orphanRow({ id: 'a', paths: [], stoppedAgents: ['claude'], measure: measured(1, MB) }))).toBe('claude (중지됨)')
    expect(orphanKindText(orphanRow({ id: 'a', paths: [], agents: ['codex'], stoppedAgents: ['claude'], measure: measured(1, MB) }))).toBe('codex, claude (중지됨)')
  })
  it('F3 「모두 닫기」 대상 — 주인 없는 줄만', () => {
    const rows = [orphanRow({ id: 'a', paths: [], ownerless: true, measure: measured(1, MB) }), orphanRow({ id: 'b', paths: [], ownerless: false, measure: measured(1, MB) })]
    expect(bulkOrphanTargets(rows).map((row) => row.workspaceId)).toEqual(['a'])
  })
  it('정렬 — 메모리 내림차순, 측정 불가 맨 뒤', () => {
    const rows = [orphanRow({ id: 'u', paths: [], measure: { state: 'unavailable', reason: 'x' } }), orphanRow({ id: 's', paths: [], measure: measured(1, MB) }), orphanRow({ id: 'b', paths: [], measure: measured(1, GB) })]
    expect(sortOrphans({ rows, sort: 'memory' }).map((row) => row.workspaceId)).toEqual(['b', 's', 'u'])
  })
  it('확인 문구 — 한 줄: 에이전트면 workspace 기준 에이전트 문구, 「다시 묻지 않기」 없음(F3 — 전역 설정을 끄지 않는다)', () => {
    const one = orphanCloseCopy({ running: [{ tabId: 'w', paneId: 'p', foreground: ['claude'] }], agentPaneIds: new Set(['p']), count: 1, bulk: false })
    expect(one.kind).toBe('agent')
    expect(one.body[0]).toBe('이 workspace 를 닫으면 그 안의 에이전트가 종료된다.')
    expect(one.dontAskAgain).toBeNull()
    const command = orphanCloseCopy({ running: [{ tabId: 'w', paneId: 'p', foreground: ['vim'] }], agentPaneIds: new Set(), count: 1, bulk: false })
    expect(command.body[0]).toBe('이 workspace 를 닫으면 안에서 실행 중인 명령이 멈춘다.')
    expect(command.dontAskAgain).toBeNull()
  })
  it('F3 확인 문구 — 「모두 닫기」 는 실행 중이 없어도 개수 확인(제목·버튼에 개수), 「다시 묻지 않기」 없음', () => {
    const idle = orphanCloseCopy({ running: [], agentPaneIds: new Set(), count: 3, bulk: true })
    expect(idle.title).toBe('주인 없는 workspace 3개를 닫을까')
    expect(idle.confirm).toBe('3개 닫기')
    expect(idle.dontAskAgain).toBeNull()
    const agent = orphanCloseCopy({ running: [{ tabId: 'w', paneId: 'p', foreground: ['claude'] }], agentPaneIds: new Set(['p']), count: 2, bulk: true })
    expect(agent.kind).toBe('agent')
    expect(agent.body).toContain('그 안의 에이전트가 종료된다.')
    expect(agent.dontAskAgain).toBeNull()
  })
})

