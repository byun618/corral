import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RuntimeError } from './contracts.js'
const exec = promisify(execFile)
export async function memorySnapshot(roles: Map<number, string> = new Map(), signal?: AbortSignal) {
  if (process.platform === 'win32') throw new RuntimeError('unsupported_platform', 'Process measurement supports macOS/Linux only')
  const table = (await exec('ps', ['-axo', 'pid=,ppid=,rss=,%cpu='], { timeout: 5000, signal })).stdout.split('\n').flatMap(line => {
    const values = line.trim().split(/\s+/).map(Number)
    return values.length === 4 && values.every(Number.isFinite) ? [{ pid: values[0]!, ppid: values[1]!, memory: values[2]! * 1024, cpu: values[3]! }] : []
  })
  const mainRow = table.find(row => row.pid === process.pid)
  if (!mainRow) throw new RuntimeError('measurement_failed', 'Runtime PID missing from process table')
  const owned = new Set<number>([process.pid])
  const sum = (roots: number[]) => {
    const ids = new Set(roots)
    let changed = true
    while (changed) {
      changed = false
      for (const row of table) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true }
    }
    let cpu = 0, memory = 0
    for (const row of table) if (ids.has(row.pid) && !owned.has(row.pid)) { owned.add(row.pid); cpu += row.cpu; memory += row.memory }
    return { cpu, memory }
  }
  const main = { cpu: mainRow.cpu, memory: mainRow.memory }
  const renderer = sum([...roles].filter(([, role]) => role === 'renderer').map(([pid]) => pid))
  const other = sum([process.pid, ...[...roles].filter(([, role]) => role !== 'renderer').map(([pid]) => pid)])
  const app = { main, renderer, other, cpu: main.cpu + renderer.cpu + other.cpu, memory: main.memory + renderer.memory + other.memory }
  const total = os.totalmem(), free = os.freemem()
  return {
    scope: { rootPid: process.pid, includes: 'runtime process and descendants plus Electron process roles', excludes: 'independent backend and terminal processes; no worktree attribution in this release' },
    app, host: { totalMemory: total, freeMemory: free, availableMemory: free, availableMemorySource: 'free-memory', usedMemory: total - free, cpuCoreCount: os.cpus().length, loadAverage1m: os.loadavg()[0] ?? 0 },
    processMemoryMetric: 'rss', totalCpu: app.cpu, totalMemory: app.memory, collectedAt: Date.now(),
  }
}
