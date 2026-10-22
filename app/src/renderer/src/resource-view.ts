// 상태바 Resource Manager 의 표시 규칙 (LIFE-637 R3·R4 · LIFE-676 R3·R4·R5) — 순수 함수. 컴포넌트는 `components/ResourceSegment.tsx`.
//
// 세그먼트 = `CPU n% · 메모리 x.x GB`(「전체」 = 앱 + herdr + 모든 pane 자손). 하나도 못 재면 `—` — 가짜 숫자를 보이지 않는다.
// CPU 척도(LIFE-676 게이트 ⓪ Q3): 세그먼트·패널 머리 요약 줄 = 맥 전체 대비(합 ÷ 코어 수, 0~100) · 묶음·pane·앱·herdr 행 = 코어당(코어 하나 = 100).
// 메모리 = 활동 상태 보기 「메모리」 열 값(phys_footprint)의 합. 못 재면 `측정 불가`(사유는 툴팁) — RSS 로 대신하지 않는다(Q2).
// 일부 pid 를 뺀 합(하한)은 `≥ x`, 빠진 사유는 툴팁(리뷰 r1 C1-1).
// 패널 = worktree 묶음(합계 행 + pane 행) · 앱·herdr 행 따로. 기본 정렬은 메모리 내림차순, 측정 불가는 맨 뒤.
// 카드 밖 workspace(LIFE-628) = worktree 묶음 아래 따로 한 묶음 — workspace 한 줄(원래 경로·에이전트·메모리) + 한 줄 닫기·「모두 닫기」.
import { sumUsage, type MemoryPressure, type ResourceMeasure, type ResourceMemory, type ResourceOrphanRow, type ResourcePaneRow, type ResourceSnapshot, type ResourceUsage } from '../../shared/resource.js'
import type { RunningPane } from '../../shared/types.js'
import { closeCopy, type CloseCopy } from './close-copy.js'

export const RESOURCE_EMPTY = '—'
export const RESOURCE_UNAVAILABLE = '측정 불가'
export const RESOURCE_SCOPE = 'corral 앱 + herdr 서버 + 모든 pane 자손 합'
/** 메모리 정의(R4) — 공유 메모리를 몇 번 세는지는 주장하지 않는다(00-analysis 「합계 의미」). */
export const RESOURCE_MEMORY_NOTE = '메모리 = 활동 상태 보기 「메모리」 열 값(압축·swap 된 몫 포함)의 합'
/** 패널 행 CPU 칸 기준(R3ⓓ). */
export const RESOURCE_ROW_CPU_TOOLTIP = 'CPU — 코어 하나 = 100%'
export const RESOURCE_LOWER_BOUND = '≥'

/**
 * 행의 툴팁 두 자리(리뷰 r1 C1-4) — CPU 칸 자체 `title` 은 행에 사유가 없을 때만 단다(안쪽 `title` 이 행 사유를 덮지 않게).
 * 사유가 있으면 CPU 기준은 행 툴팁 끝 줄로 옮긴다.
 */
export function rowTitles(reason: string | null): { row: string | null; cpu: string | undefined } {
  return reason === null ? { row: null, cpu: RESOURCE_ROW_CPU_TOOLTIP } : { row: `${reason}\n${RESOURCE_ROW_CPU_TOOLTIP}`, cpu: undefined }
}

export type ResourceSortKey = 'memory' | 'cpu'

const GB = 1024 ** 3
const MB = 1024 ** 2

/** 코어당 CPU(행) — 코어 하나 = 100%. */
export function formatCpu(cpu: number): string {
  return `${Math.round(cpu)}%`
}

/** 맥 전체 대비 CPU(세그먼트·패널 머리) — 합 ÷ 코어 수, 0~100 정수. 코어 수를 모르면(0·비정상) 가짜 숫자 대신 `—`(R3ⓔ). */
export function formatMachineCpu(input: { cpu: number; cpuCoreCount: number }): string {
  if (!Number.isFinite(input.cpuCoreCount) || input.cpuCoreCount <= 0) return RESOURCE_EMPTY
  return `${Math.min(100, Math.max(0, Math.round(input.cpu / input.cpuCoreCount)))}%`
}

export function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

/** 행 단위 메모리 — 1 GB 미만은 MB 정수. */
export function formatMemory(bytes: number): string {
  return bytes >= GB ? formatGb(bytes) : `${Math.round(bytes / MB)} MB`
}

/** 행·묶음 메모리 칸 — 하한은 `≥ x`, 못 재면 `측정 불가`(사유는 칸 툴팁). */
export function memoryText(memory: ResourceMemory): string {
  switch (memory.state) {
    case 'measured':
      return formatMemory(memory.bytes)
    case 'partial':
      return `${RESOURCE_LOWER_BOUND} ${formatMemory(memory.bytes)}`
    case 'unavailable':
      return RESOURCE_UNAVAILABLE
  }
}

/** 메모리 칸 툴팁 사유 — 측정값이면 null. */
export function memoryNote(memory: ResourceMemory): string | null {
  switch (memory.state) {
    case 'measured':
      return null
    case 'partial':
      return `메모리 하한 — ${memory.reason}`
    case 'unavailable':
      return `메모리 측정 불가 — ${memory.reason}`
  }
}

function totalMemoryText(memory: ResourceMemory): string {
  switch (memory.state) {
    case 'measured':
      return formatGb(memory.bytes)
    case 'partial':
      return `${RESOURCE_LOWER_BOUND} ${formatGb(memory.bytes)}`
    case 'unavailable':
      return RESOURCE_UNAVAILABLE
  }
}

export function segmentLabel(snapshot: ResourceSnapshot | null): string {
  const total = snapshot?.total ?? null
  if (snapshot === null || total === null) return `CPU ${RESOURCE_EMPTY} · 메모리 ${RESOURCE_EMPTY}`
  const memory = totalMemoryText(total.memory)
  return `CPU ${formatMachineCpu({ cpu: total.cpu, cpuCoreCount: snapshot.host.cpuCoreCount })} · 메모리 ${memory}`
}

/** 세그먼트·패널 머리 CPU 기준 문구(R3ⓓ) — corral 사용분을 맥 전체 대비로. 맥 전체 사용률(다른 앱 포함)로 읽히지 않게 적는다(게이트 ① 수정 1). */
export function machineCpuNote(cpuCoreCount: number): string {
  const scale = Number.isFinite(cpuCoreCount) && cpuCoreCount > 0 ? `코어 ${cpuCoreCount}개 = 100%` : '코어 수를 몰라 표시하지 않는다'
  return `CPU = corral(앱·herdr·pane)이 쓴 몫, 맥 전체 대비(${scale}) — 맥 전체 사용률이 아니다(다른 앱 제외) · 패널의 앱·herdr·묶음·pane 행은 코어 하나 = 100%`
}

/** 첫 줄 = 세그먼트 라벨 전문(H7 — 폭이 모자라 말줄임이 나도 호버로 숫자를 읽는다). */
export function segmentTooltip(snapshot: ResourceSnapshot | null): string {
  const head = [segmentLabel(snapshot), RESOURCE_SCOPE, machineCpuNote(snapshot?.host.cpuCoreCount ?? 0), RESOURCE_MEMORY_NOTE].join('\n')
  if (snapshot === null) return `${head}\n아직 수집 전`
  if (snapshot.total === null) return `${head}\n측정 불가`
  const notes: string[] = []
  if (snapshot.unavailableCount > 0) notes.push(`측정 불가 ${snapshot.unavailableCount}칸은 합에서 빠졌다`)
  const memory = memoryNote(snapshot.total.memory)
  if (memory !== null) notes.push(memory)
  return [head, ...notes].join('\n')
}

export function measureCells(measure: ResourceMeasure): { cpu: string; memory: string; title: string | null } {
  switch (measure.state) {
    case 'measured': {
      const { memory } = measure.usage
      return { cpu: formatCpu(measure.usage.cpu), memory: memoryText(memory), title: memoryNote(memory) }
    }
    case 'unavailable':
      return { cpu: RESOURCE_EMPTY, memory: RESOURCE_EMPTY, title: `측정 불가 — ${measure.reason}` }
  }
}

function usageOf(measure: ResourceMeasure): ResourceUsage | null {
  return measure.state === 'measured' ? measure.usage : null
}

function sortValue(input: { usage: ResourceUsage | null; key: ResourceSortKey }): number | null {
  const { usage } = input
  if (usage === null) return null
  switch (input.key) {
    case 'cpu':
      return usage.cpu
    case 'memory':
      return usage.memory.state === 'unavailable' ? null : usage.memory.bytes
  }
}

/** 내림차순, 측정 불가(null — 메모리순이면 메모리 측정 불가도)는 맨 뒤. 같으면 원래 순서. */
function compareUsage(input: { a: ResourceUsage | null; b: ResourceUsage | null; key: ResourceSortKey }): number {
  const a = sortValue({ usage: input.a, key: input.key })
  const b = sortValue({ usage: input.b, key: input.key })
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1
  return b - a
}

export type ResourceGroup = {
  key: string
  label: string
  /** 묶음 안 측정된 pane 의 합(`sumUsage` — 메모리는 메모리까지 잰 pane 만). 하나도 못 재면 null. */
  usage: ResourceUsage | null
  unavailableCount: number
  panes: ResourcePaneRow[]
}

export function groupPanes(input: { panes: readonly ResourcePaneRow[]; sort: ResourceSortKey }): ResourceGroup[] {
  const members = new Map<string, { key: string; label: string; panes: ResourcePaneRow[] }>()
  for (const pane of input.panes) {
    const group = members.get(pane.groupKey) ?? { key: pane.groupKey, label: pane.groupLabel, panes: [] }
    group.panes.push(pane)
    members.set(pane.groupKey, group)
  }
  const sorted = [...members.values()].map((group): ResourceGroup => {
    const usages = group.panes.flatMap((pane) => {
      const usage = usageOf(pane.measure)
      return usage === null ? [] : [usage]
    })
    return {
      ...group,
      usage: sumUsage(usages),
      unavailableCount: group.panes.length - usages.length,
      panes: [...group.panes].sort((a, b) => compareUsage({ a: usageOf(a.measure), b: usageOf(b.measure), key: input.sort })),
    }
  })
  return sorted.sort((a, b) => compareUsage({ a: a.usage, b: b.usage, key: input.sort }))
}

/** 묶음 합계 행 툴팁 — 빠진 칸이 있을 때만. */
export function groupTooltip(group: ResourceGroup): string | null {
  const notes: string[] = []
  if (group.unavailableCount > 0) notes.push(`측정 불가 ${group.unavailableCount}개는 합에서 빠졌다`)
  const memory = group.usage === null ? null : memoryNote(group.usage.memory)
  if (memory !== null) notes.push(memory)
  return notes.length === 0 ? null : notes.join('\n')
}

/** 패널이 열린 동안 얼려 둔 행 순서(J1) — 보인 순서 그대로의 묶음 열쇠·pane id. */
export type PanelOrder = { groups: readonly string[]; panes: readonly string[] }

export function orderOf(groups: readonly ResourceGroup[]): PanelOrder {
  return { groups: groups.map((group) => group.key), panes: groups.flatMap((group) => group.panes.map((pane) => pane.paneId)) }
}

/** 얼린 자리 순, 처음 보는 것은 (들어온 순서대로) 끝에. */
function byFrozen<T>(input: { items: readonly T[]; keyOf: (item: T) => string; frozen: readonly string[] }): T[] {
  const rank = new Map(input.frozen.map((key, index) => [key, index]))
  return input.items
    .map((item, index) => ({ item, index, rank: rank.get(input.keyOf(item)) ?? input.frozen.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item)
}

/**
 * 정렬된 묶음을 얼린 순서로 되돌린다(J1) — 값은 새 스냅샷 그대로, 자리만 열 때(또는 정렬을 바꿀 때) 본 순서.
 * 새 pane 은 그 묶음 끝에, 새 묶음은 맨 끝에 붙고, 사라진 것은 빠진다.
 */
export function keepOrder(input: { groups: readonly ResourceGroup[]; order: PanelOrder }): ResourceGroup[] {
  const groups = byFrozen({ items: input.groups, keyOf: (group) => group.key, frozen: input.order.groups })
  return groups.map((group) => ({ ...group, panes: byFrozen({ items: group.panes, keyOf: (pane) => pane.paneId, frozen: input.order.panes }) }))
}

const PRESSURE_LABEL: Record<MemoryPressure, string> = { normal: '정상', warning: '경고', critical: '위험' }

/**
 * 패널 맨 위 시스템 한 줄 (게이트 ⓪ Q4) — `메모리 압박 <수준> · swap <사용> / <전체> GB · 압축 <크기> GB · 물리 <크기> GB · 코어 N개`.
 * 「사용 / 전체 메모리」 는 macOS 에서 늘 꽉 차 보여 뺐다(00-analysis C6). 못 읽은 지표는 그 조각만 `—`(R5ⓓ).
 */
export function hostLine(snapshot: ResourceSnapshot): string {
  const { host } = snapshot
  const gb = (bytes: number): string => (bytes / GB).toFixed(1)
  const pressure = host.pressure === null ? RESOURCE_EMPTY : PRESSURE_LABEL[host.pressure]
  const swap = host.swap === null ? RESOURCE_EMPTY : `${gb(host.swap.used)} / ${gb(host.swap.total)} GB`
  const compressed = host.compressed === null ? RESOURCE_EMPTY : `${gb(host.compressed)} GB`
  const physical = Number.isFinite(host.physicalMemory) && host.physicalMemory > 0 ? `${Math.round(host.physicalMemory / GB)} GB` : RESOURCE_EMPTY
  const cores = Number.isFinite(host.cpuCoreCount) && host.cpuCoreCount > 0 ? `${host.cpuCoreCount}개` : RESOURCE_EMPTY
  return `메모리 압박 ${pressure} · swap ${swap} · 압축 ${compressed} · 물리 ${physical} · 코어 ${cores}`
}

/** herdr 행 이름·툴팁 (F9) — 셸 부모(herdr) 아래에서 pane 행이 가져가지 않은 것이 전부 이 행으로 온다. */
export const HERDR_ROW_LABEL = 'herdr (서버 + 목록 밖 pane)'
export const HERDR_ROW_TOOLTIP = 'herdr 서버와, 패널 목록에 없는 pane(셸 pid 를 아직 모르는 pane)의 프로세스 — 카드 밖 workspace 는 아래 따로'

/**
 * pane 닫기 확인 문구 (F7) — 뜻·체크박스(「다시 묻지 않기」 = 같은 설정 패치)는 기존 `closeCopy` 를 따르고 말만 pane 기준으로 바꾼다.
 * `pinned` = 이 pane 을 닫으면 고정된 탭이 닫힌다(탭의 마지막 pane). 실행 중이 비었는데 핀도 아니면 핀 문구로 떨어지지 않는다.
 */
export function paneCloseCopy(input: { running: readonly RunningPane[]; agentPaneIds: ReadonlySet<string>; pinned: boolean }): CloseCopy {
  const base = closeCopy({ kind: 'tabs', tabCount: 1, running: input.running, agentPaneIds: input.agentPaneIds, pinnedCount: input.pinned ? 1 : 0 })
  const pinnedNote = input.pinned ? ['이 pane 은 고정된 탭의 마지막 pane 이라 탭이 같이 닫힌다.'] : []
  switch (base.kind) {
    case 'agent':
      return { ...base, body: ['이 pane 을 닫으면 에이전트의 현재 작업이 멈춘다.', '닫은 터미널은 자동으로 재개되지 않는다.', ...pinnedNote] }
    case 'command':
      return { ...base, body: ['이 pane 을 닫으면 안에서 실행 중인 명령이 멈춘다.', ...pinnedNote] }
    case 'pinned':
      if (!input.pinned) return { kind: 'command', title: '이 pane 을 닫을까', body: ['다시 확인했을 때 실행 중인 프로세스가 보이지 않았다.'], confirm: '닫기', dontAskAgain: null }
      return { ...base, body: pinnedNote }
    case 'worktree':
      return base
  }
}

/** 카드 밖 workspace 묶음 (LIFE-628 S1). */
export const ORPHAN_SECTION_LABEL = '카드 밖 workspace'
export const ORPHAN_SECTION_TOOLTIP = 'herdr 에 열려 있지만 어느 worktree 카드에도 붙지 않은 workspace — 셸에서 지운 worktree 에 남은 세션, herdr 재기동이 원래 경로 없이 되살린 세션 등. 닫으면 그 안의 셸·에이전트가 종료된다.'
/** 가릴 수 없는 때(`orphans: null`) — 빈 목록(「없다」)과 구분한다. */
export const ORPHAN_UNKNOWN = '지금은 가릴 수 없다(재접속 중·목록 갱신 중)'
export const ORPHAN_MISSING_PATH = '없음'

/** 줄 이름 칸 — 첫 경로(지금 없으면 「(없음)」), 경로가 여럿이면 「외 n」. 경로를 모르면 workspace 이름. */
export function orphanPathText(row: ResourceOrphanRow): string {
  const [first, ...rest] = row.paths
  if (first === undefined) return row.label
  const head = first.exists ? first.path : `${first.path} (${ORPHAN_MISSING_PATH})`
  return rest.length === 0 ? head : `${head} 외 ${rest.length}`
}

/** 줄 툴팁 — 경로 전부(있음/없음)·pane 수·workspace 이름. */
export function orphanTooltip(row: ResourceOrphanRow): string {
  const paths = row.paths.length === 0 ? ['경로 모름'] : row.paths.map((item) => (item.exists ? item.path : `${item.path} — 디렉터리 없음`))
  return [...paths, `pane ${row.paneIds.length}개 · ${row.label}`].join('\n')
}

export const ORPHAN_STOPPED = '중지됨'
export const ORPHAN_OWNERLESS = '주인 없음'
export const ORPHAN_OWNED = '경로 있음'
export const ORPHAN_OWNERLESS_TOOLTIP = '원래 경로가 모두 사라졌거나 HOME 이다 — 「모두 닫기」 대상'
export const ORPHAN_OWNED_TOOLTIP = '경로가 살아 있다(미등록 레포의 세션·형제 pane 이 살아 있는 workspace 등) — 「모두 닫기」 에 들지 않는다. 줄 ✕ 로만 닫는다'

/** 종류 칸 — 에이전트 이름들, 세션 참조만 남은 에이전트는 「(중지됨)」(F4 — 재기동이 재개하지 않은 pane), 둘 다 없으면 shell. */
export function orphanKindText(row: ResourceOrphanRow): string {
  const names = [...row.agents, ...row.stoppedAgents.map((agent) => `${agent} (${ORPHAN_STOPPED})`)]
  return names.length === 0 ? 'shell' : names.join(', ')
}

/** 「모두 닫기」 대상 — 주인 없는 줄만(F3). */
export function bulkOrphanTargets(rows: readonly ResourceOrphanRow[]): ResourceOrphanRow[] {
  return rows.filter((row) => row.ownerless)
}

/** 메모리(또는 CPU) 내림차순, 측정 불가는 맨 뒤 — pane 행과 같은 규칙. */
export function sortOrphans(input: { rows: readonly ResourceOrphanRow[]; sort: ResourceSortKey }): ResourceOrphanRow[] {
  return [...input.rows].sort((a, b) => compareUsage({ a: usageOf(a.measure), b: usageOf(b.measure), key: input.sort }))
}

/** 묶음 머리 합 — 측정된 줄만(`sumUsage`). 하나도 못 재면 null. */
export function orphanTotal(rows: readonly ResourceOrphanRow[]): ResourceUsage | null {
  return sumUsage(rows.flatMap((row) => {
    const usage = usageOf(row.measure)
    return usage === null ? [] : [usage]
  }))
}

/**
 * 카드 밖 workspace 닫기 확인 문구 — 뜻은 기존 `closeCopy` 를 따르고 말만 workspace 기준으로 바꾼다.
 * **「다시 묻지 않기」 는 두지 않는다**(F3) — 그 체크는 전역 설정(`skipCloseTerminalWithRunningProcessConfirm`)을 끄므로,
 * 카드 밖 일괄 닫기의 확인 하나로 모든 터미널 닫기의 확인을 영구히 끌 수 있었다.
 * `bulk`(「모두 닫기」)는 실행 중이 없어도 개수 확인이다 — 제목에 개수, 확인 버튼에 개수.
 * 한 줄 닫기에서 실행 중이 비어 있으면(확인 뒤 재판정에서 사라짐) 일반 문구로.
 */
export function orphanCloseCopy(input: { running: readonly RunningPane[]; agentPaneIds: ReadonlySet<string>; count: number; bulk: boolean }): CloseCopy {
  const base = closeCopy({ kind: 'tabs', tabCount: input.count, running: input.running, agentPaneIds: input.agentPaneIds, pinnedCount: 0 })
  if (input.bulk) {
    const stops = base.kind === 'agent' ? ['그 안의 에이전트가 종료된다.'] : base.kind === 'command' ? ['안에서 실행 중인 명령이 멈춘다.'] : []
    return {
      kind: base.kind === 'agent' ? 'agent' : 'command',
      title: `주인 없는 workspace ${input.count}개를 닫을까`,
      body: [`원래 경로가 사라졌거나 HOME 인 카드 밖 workspace ${input.count}개를 닫는다.`, ...stops, '닫은 터미널은 자동으로 재개되지 않는다.'],
      confirm: `${input.count}개 닫기`,
      dontAskAgain: null,
    }
  }
  switch (base.kind) {
    case 'agent':
      return { ...base, body: ['이 workspace 를 닫으면 그 안의 에이전트가 종료된다.', '닫은 터미널은 자동으로 재개되지 않는다.'], dontAskAgain: null }
    case 'command':
      return { ...base, body: ['이 workspace 를 닫으면 안에서 실행 중인 명령이 멈춘다.'], dontAskAgain: null }
    case 'pinned':
    case 'worktree':
      return { kind: 'command', title: '카드 밖 workspace 를 닫을까', body: ['다시 확인했을 때 실행 중인 프로세스가 보이지 않았다.'], confirm: '닫기', dontAskAgain: null }
  }
}

