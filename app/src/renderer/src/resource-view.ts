// 상태바 Resource Manager 의 표시 규칙 (LIFE-637 R3·R4) — 순수 함수. 컴포넌트는 `components/ResourceSegment.tsx`.
//
// 세그먼트 = `CPU n% · 메모리 x.x GB`(「전체」 = 앱 + herdr + 모든 pane 자손, RSS). 하나도 못 재면 `—` — 가짜 숫자를 보이지 않는다.
// 패널 = worktree 묶음(합계 행 + pane 행) · 앱·herdr 행 따로. 기본 정렬은 메모리 내림차순, 측정 불가는 맨 뒤.
import type { ResourceMeasure, ResourcePaneRow, ResourceSnapshot, ResourceUsage } from '../../shared/resource.js'

export const RESOURCE_EMPTY = '—'
export const RESOURCE_TOOLTIP = 'corral 앱 + herdr 서버 + 모든 pane 자손 합 · 메모리 = RSS(공유 메모리 중복 포함) · CPU = ps %cpu 합(코어 하나 = 100%)'

export type ResourceSortKey = 'memory' | 'cpu'

const GB = 1024 ** 3
const MB = 1024 ** 2

export function formatCpu(cpu: number): string {
  return `${Math.round(cpu)}%`
}

export function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

/** 행 단위 메모리 — 1 GB 미만은 MB 정수. */
export function formatMemory(bytes: number): string {
  return bytes >= GB ? formatGb(bytes) : `${Math.round(bytes / MB)} MB`
}

export function segmentLabel(snapshot: ResourceSnapshot | null): string {
  const total = snapshot?.total ?? null
  if (total === null) return `CPU ${RESOURCE_EMPTY} · 메모리 ${RESOURCE_EMPTY}`
  return `CPU ${formatCpu(total.cpu)} · 메모리 ${formatGb(total.memory)}`
}

export function segmentTooltip(snapshot: ResourceSnapshot | null): string {
  if (snapshot === null) return `${RESOURCE_TOOLTIP}\n아직 수집 전`
  if (snapshot.total === null) return `${RESOURCE_TOOLTIP}\n측정 불가`
  return snapshot.unavailableCount === 0 ? RESOURCE_TOOLTIP : `${RESOURCE_TOOLTIP}\n측정 불가 ${snapshot.unavailableCount}칸은 합에서 빠졌다`
}

export function measureCells(measure: ResourceMeasure): { cpu: string; memory: string; title: string | null } {
  switch (measure.state) {
    case 'measured':
      return { cpu: formatCpu(measure.usage.cpu), memory: formatMemory(measure.usage.memory), title: null }
    case 'unavailable':
      return { cpu: RESOURCE_EMPTY, memory: RESOURCE_EMPTY, title: `측정 불가 — ${measure.reason}` }
  }
}

function usageOf(measure: ResourceMeasure): ResourceUsage | null {
  return measure.state === 'measured' ? measure.usage : null
}

/** 내림차순, 측정 불가(null)는 맨 뒤. 같으면 원래 순서. */
function compareUsage(input: { a: ResourceUsage | null; b: ResourceUsage | null; key: ResourceSortKey }): number {
  const { a, b, key } = input
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1
  return b[key] - a[key]
}

export type ResourceGroup = {
  key: string
  label: string
  /** 묶음 안 측정된 pane 의 합. 하나도 못 재면 null. */
  usage: ResourceUsage | null
  unavailableCount: number
  panes: ResourcePaneRow[]
}

export function groupPanes(input: { panes: readonly ResourcePaneRow[]; sort: ResourceSortKey }): ResourceGroup[] {
  const groups = new Map<string, ResourceGroup>()
  for (const pane of input.panes) {
    const group = groups.get(pane.groupKey) ?? { key: pane.groupKey, label: pane.groupLabel, usage: null, unavailableCount: 0, panes: [] }
    group.panes.push(pane)
    const usage = usageOf(pane.measure)
    if (usage === null) group.unavailableCount += 1
    else group.usage = group.usage === null ? { ...usage } : { cpu: group.usage.cpu + usage.cpu, memory: group.usage.memory + usage.memory }
    groups.set(pane.groupKey, group)
  }
  const sorted = [...groups.values()].map((group) => ({
    ...group,
    panes: [...group.panes].sort((a, b) => compareUsage({ a: usageOf(a.measure), b: usageOf(b.measure), key: input.sort })),
  }))
  return sorted.sort((a, b) => compareUsage({ a: a.usage, b: b.usage, key: input.sort }))
}

/** 패널 맨 위 시스템 한 줄 — 시스템 사용/전체 메모리. */
export function hostLine(snapshot: ResourceSnapshot): string {
  return `시스템 메모리 ${formatGb(snapshot.host.usedMemory)} / ${formatGb(snapshot.host.totalMemory)} · 코어 ${snapshot.host.cpuCoreCount}개`
}
