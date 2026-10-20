// Resource Manager 수집기의 순수 층 (LIFE-637 R1) — `ps` 출력 한 벌과 pane 루트 표만 받아 귀속을 낸다. 프로세스·herdr 를 모른다.
//
// 귀속 순서: ① pane(루트 = herdr 가 준 셸 pid, 자손 전체) ② herdr 서버(= pane 셸들의 부모, pane 몫을 뺀 자손) ③ 앱(main pid 와
// Electron 역할 pid, 앞 둘의 몫을 뺀 자손). 한 pid 는 먼저 잡은 곳에만 센다(R1ⓑ).
// 표가 이상하면(숫자 아닌 칸·로캘 콤마·같은 pid 두 줄) 전부 `측정 불가` — 어느 pane 의 줄이 깨졌는지 알 수 없어서다(R1ⓒ).
// 이중 fork 로 부모가 1 이 된 데몬은 셸 자손에서 빠진다(00-analysis R3) — 「셸 자손 합」이다.
import type { ResourceMeasure } from '../shared/resource.js'

export type PsRow = { pid: number; ppid: number; cpu: number; memory: number }
export type PsTable = { rows: Map<number, PsRow>; malformed: number }

/**
 * `LC_ALL=C ps -axo pid=,ppid=,pcpu=,rss=` (R1ⓓ) — 로캘이 소수점을 콤마로 쓰면 `%cpu` 를 잘못 읽는다(Orca collector 와 같은 이유).
 * 부르는 쪽(`resource-ipc.ts`)이 이 값을 그대로 execFile 에 넘긴다.
 */
export function psInvocation(env: NodeJS.ProcessEnv): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { file: 'ps', args: ['-axo', 'pid=,ppid=,pcpu=,rss='], env: { ...env, LC_ALL: 'C' } }
}

const INTEGER = /^\d+$/
const DECIMAL = /^\d+(\.\d+)?$/

/** 빈 줄은 건너뛴다. 그 밖에 모양이 다른 줄은 `malformed` 로 센다(버리지 않고 표 전체를 의심하게 한다). */
export function parsePsTable(stdout: string): PsTable {
  const rows = new Map<number, PsRow>()
  let malformed = 0
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const cells = trimmed.split(/\s+/)
    const [pid, ppid, cpu, rss] = cells
    if (cells.length !== 4 || pid === undefined || ppid === undefined || cpu === undefined || rss === undefined
      || !INTEGER.test(pid) || !INTEGER.test(ppid) || !DECIMAL.test(cpu) || !INTEGER.test(rss)) {
      malformed += 1
      continue
    }
    const row = { pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), memory: Number(rss) * 1024 }
    if (rows.has(row.pid)) {
      malformed += 1
      continue
    }
    rows.set(row.pid, row)
  }
  return { rows, malformed }
}

/**
 * `expectedParent` = 이 셸 pid 를 처음 봤을 때의 ppid(herdr). 지금 ppid 가 다르면 pid 가 다른 프로세스에 재사용된 것으로 보고
 * 측정 불가로 낸다(F1 — 다른 프로세스를 그 pane 으로 세지 않는다). null 이면 대조하지 않는다.
 */
export type PaneRoot = { paneId: string; shellPid: number | null; expectedParent: number | null }

export type Attribution = {
  panes: Map<string, ResourceMeasure>
  herdr: ResourceMeasure
  app: ResourceMeasure
}

type Walk = { kind: 'ok'; pids: number[] } | { kind: 'cycle' }

/** pid 가 자기 ppid 사슬 위에 다시 나오는가. 루트가 순환 위에 있지 않으면 그 자손은 나무다(자손의 사슬은 루트에 닿으므로). */
function onCycle(input: { rows: ReadonlyMap<number, PsRow>; pid: number }): boolean {
  const visited = new Set<number>()
  let current = input.rows.get(input.pid)?.ppid
  while (current !== undefined && !visited.has(current)) {
    if (current === input.pid) return true
    visited.add(current)
    current = input.rows.get(current)?.ppid
  }
  return false
}

/** 루트들에서 자식으로 내려간다. `owned` 에 든 pid 는 세지도 내려가지도 않는다. 루트가 ppid 순환 위에 있으면 순환이다. */
function walk(input: { rows: ReadonlyMap<number, PsRow>; children: Map<number, number[]>; roots: readonly number[]; owned: ReadonlySet<number> }): Walk {
  const roots = input.roots.filter((pid) => !input.owned.has(pid))
  if (roots.some((pid) => onCycle({ rows: input.rows, pid }))) return { kind: 'cycle' }
  const seen = new Set<number>(roots)
  const stack = [...seen]
  const pids: number[] = []
  while (stack.length > 0) {
    const pid = stack.pop()
    if (pid === undefined) break
    pids.push(pid)
    for (const child of input.children.get(pid) ?? []) {
      if (input.owned.has(child) || seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return { kind: 'ok', pids: pids.sort((a, b) => a - b) }
}

function measured(input: { table: PsTable; pids: number[] }): ResourceMeasure {
  let cpu = 0
  let memory = 0
  for (const pid of input.pids) {
    const row = input.table.rows.get(pid)
    if (row === undefined) continue
    cpu += row.cpu
    memory += row.memory
  }
  return { state: 'measured', usage: { cpu, memory }, pids: input.pids }
}

export function attribute(input: { table: PsTable; panes: readonly PaneRoot[]; appRoots: readonly number[] }): Attribution {
  const { table } = input
  if (table.malformed > 0) {
    const broken: ResourceMeasure = { state: 'unavailable', reason: `ps 표 이상 (${table.malformed}줄)` }
    return { panes: new Map(input.panes.map((pane) => [pane.paneId, broken])), herdr: broken, app: broken }
  }
  const children = new Map<number, number[]>()
  for (const row of table.rows.values()) {
    const list = children.get(row.ppid)
    if (list === undefined) children.set(row.ppid, [row.pid])
    else list.push(row.pid)
  }
  const owned = new Set<number>()
  const claim = (pids: readonly number[]): void => {
    for (const pid of pids) owned.add(pid)
  }

  const panes = new Map<string, ResourceMeasure>()
  const herdrRoots = new Set<number>()
  let measuredPanes = 0
  for (const pane of input.panes) {
    const root = pane.shellPid
    if (root === null) {
      panes.set(pane.paneId, { state: 'unavailable', reason: '셸 pid 를 모른다' })
      continue
    }
    const row = table.rows.get(root)
    if (row === undefined) {
      panes.set(pane.paneId, { state: 'unavailable', reason: `셸 프로세스(pid ${root})가 없다` })
      continue
    }
    if (pane.expectedParent !== null && row.ppid !== pane.expectedParent) {
      panes.set(pane.paneId, { state: 'unavailable', reason: `셸 pid ${root} 의 부모가 바뀌었다(${pane.expectedParent} → ${row.ppid}) — pid 재사용 의심` })
      continue
    }
    if (owned.has(root)) {
      panes.set(pane.paneId, { state: 'unavailable', reason: `셸 pid ${root} 가 다른 곳에 이미 귀속됐다` })
      continue
    }
    const result = walk({ rows: table.rows, children, roots: [root], owned })
    switch (result.kind) {
      case 'cycle':
        panes.set(pane.paneId, { state: 'unavailable', reason: 'ppid 순환' })
        continue
      case 'ok':
        claim(result.pids)
        panes.set(pane.paneId, measured({ table, pids: result.pids }))
        measuredPanes += 1
        if (row.ppid > 1) herdrRoots.add(row.ppid)
        continue
    }
  }

  // herdr 가 앱의 자식으로 떠 있어도(앱이 띄운 서버) herdr 몫으로 먼저 센다. 앱 pid 자체는 herdr 로 세지 않는다
  // (셸의 부모가 앱이면 — herdr 를 거치지 않은 셸 — 앱 행을 herdr 로 삼키지 않는다).
  const parentsSeen = herdrRoots.size
  for (const pid of input.appRoots) herdrRoots.delete(pid)
  // 걸러 낸 뒤 루트가 하나도 없으면 0 이 아니라 측정 불가다(F9 — 가짜 숫자를 내지 않는다).
  const herdrLive = [...herdrRoots].filter((pid) => table.rows.has(pid) && !owned.has(pid))
  let herdr: ResourceMeasure
  if (herdrRoots.size === 0) {
    // 사유는 경우별로(H9).
    const reason = measuredPanes === 0
      ? '측정된 pane 이 없어 herdr 서버 pid 를 모른다'
      : parentsSeen === 0
        ? '측정된 pane 셸의 부모가 모두 pid 1 이라 herdr 서버 pid 를 모른다'
        : '측정된 pane 셸의 부모가 앱 프로세스라 herdr 서버를 따로 세지 않는다'
    herdr = { state: 'unavailable', reason }
  } else if (herdrLive.length === 0) {
    // 표에 없음과 이미 pane 몫(셸 부모가 다른 pane 의 자손)을 가른다.
    const parents = [...herdrRoots].join(', ')
    herdr = [...herdrRoots].some((pid) => table.rows.has(pid))
      ? { state: 'unavailable', reason: `셸 부모 pid(${parents})가 이미 pane 몫으로 귀속됐다` }
      : { state: 'unavailable', reason: `셸 부모 pid(${parents})가 ps 표에 없다` }
  } else {
    const result = walk({ rows: table.rows, children, roots: herdrLive, owned })
    if (result.kind === 'cycle') herdr = { state: 'unavailable', reason: 'ppid 순환' }
    else {
      claim(result.pids)
      herdr = measured({ table, pids: result.pids })
    }
  }

  const appInTable = input.appRoots.filter((pid) => table.rows.has(pid))
  const appLive = appInTable.filter((pid) => !owned.has(pid))
  let app: ResourceMeasure
  if (appInTable.length === 0) {
    app = { state: 'unavailable', reason: '앱 프로세스가 ps 표에 없다' }
  } else if (appLive.length === 0) {
    app = { state: 'unavailable', reason: '앱 프로세스가 이미 pane·herdr 몫으로 귀속됐다' }
  } else {
    const result = walk({ rows: table.rows, children, roots: appLive, owned })
    if (result.kind === 'cycle') app = { state: 'unavailable', reason: 'ppid 순환' }
    else {
      claim(result.pids)
      app = measured({ table, pids: result.pids })
    }
  }
  return { panes, herdr, app }
}

/** 측정된 칸만 더한다. 하나도 없으면 null(세그먼트는 `—`). */
export function totalOf(measures: readonly ResourceMeasure[]): { total: { cpu: number; memory: number } | null; unavailableCount: number } {
  let cpu = 0
  let memory = 0
  let count = 0
  let unavailableCount = 0
  for (const measure of measures) {
    switch (measure.state) {
      case 'measured':
        cpu += measure.usage.cpu
        memory += measure.usage.memory
        count += 1
        continue
      case 'unavailable':
        unavailableCount += 1
        continue
    }
  }
  return { total: count === 0 ? null : { cpu, memory }, unavailableCount }
}
