// LIFE-373 스파이크 드라이버 — 시나리오 하나당 Electron 프로세스 하나를 띄우고,
// **앱 바깥에서** CPU·RSS 를 `ps` 로 잰다 (관문 ②: 재는 대상이 자기를 보고하지 않는다).
//
//   node scripts/l373/spike/run.mjs [필터…]
//
// 결과: specs/LIFE-373-mru-pane-split/raw/spike/runs/<시나리오>.json

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFrames } from './gen-frames.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.dirname(path.dirname(path.dirname(HERE)))
const REPO_DIR = path.dirname(APP_DIR)
const RAW = path.join(REPO_DIR, 'specs/LIFE-373-mru-pane-split/raw/spike')
const RUNS = path.join(RAW, 'runs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-run-'))
/** 반복 회차 — 같은 시나리오를 여러 번 돌려 실행 간 변동을 드러낸다 (writeP95 가 회차마다 흔들렸다). */
const REP = String(process.env.L373_REP ?? '1')
const suffix = REP === '1' ? '' : `.r${REP}`

const WARMUP_MS = 1500
const MEASURE_MS = 8000
const CELL_W = 8 // 대략치 — 창 크기 산정용. 실제 스케일은 렌더러가 재서 기록한다
const CELL_H = 18

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- ps 기반 바깥 오라클 -------------------------------------------------------
/** `MM:SS.ss` / `H:MM:SS.ss` → 초 */
function parseCpuTime(text) {
  const parts = text.trim().split(':').map(Number)
  if (parts.some(Number.isNaN)) return null
  return parts.reduce((acc, value) => acc * 60 + value, 0)
}

function psSample(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'cputime=,rss=,%cpu=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (out.length === 0) return null
    const m = out.split(/\s+/)
    return { at: Date.now(), cpuSec: parseCpuTime(m[0]), rssKb: Number(m[1]), psCpuPct: Number(m[2]) }
  } catch {
    return null
  }
}

// --- 시나리오 ------------------------------------------------------------------
const G = {
  std: { cols: 100, rows: 30 },
  small: { cols: 60, rows: 20 },
  big: { cols: 120, rows: 40 },
}

function gridShape(count) {
  if (count <= 1) return { cx: 1, cy: 1 }
  if (count === 2) return { cx: 2, cy: 1 }
  if (count <= 4) return { cx: 2, cy: 2 }
  return { cx: 4, cy: 2 }
}

function scenario({ name, group, count, geo = G.std, mode, paceMs = 0, activePanes = null, skip = null, observeDom = true }) {
  const { cx, cy } = gridShape(count)
  return {
    name,
    group,
    panes: { count, ...geo },
    mode,
    paceMs,
    activePanes,
    skip,
    observeDom,
    warmupMs: WARMUP_MS,
    measureMs: MEASURE_MS,
    window: { width: Math.min(2400, geo.cols * CELL_W * cx + 40), height: Math.min(1300, geo.rows * CELL_H * cy + 40) },
  }
}

const PACE_MS = 67 // pane 당 ~15fps — 에이전트 TUI 스피너 급 목표 주기
const PACE30_MS = 33 // 30fps — 스트레스

const SCENARIOS = [
  // 대조군 — 인스턴스만 살아 있고 프레임은 안 온다 (rAF 바닥값·상주 비용)
  scenario({ name: 'c-idle-n1', group: 'control', count: 1, mode: 'idle' }),
  scenario({ name: 'c-idle-n4', group: 'control', count: 4, mode: 'idle' }),
  scenario({ name: 'c-idle-n8', group: 'control', count: 8, mode: 'idle' }),
  // M1·M2·M4 — 포화 (소화 능력 상한)
  scenario({ name: 'm1-sat-n1', group: 'M1', count: 1, mode: 'saturated' }),
  scenario({ name: 'm1-sat-n2', group: 'M1', count: 2, mode: 'saturated' }),
  scenario({ name: 'm1-sat-n4', group: 'M1', count: 4, mode: 'saturated' }),
  scenario({ name: 'm1-sat-n8', group: 'M1', count: 8, mode: 'saturated' }),
  // M1·M2·M4 — 목표 주기 15fps (드랍률)
  scenario({ name: 'm1-pace15-n1', group: 'M1', count: 1, mode: 'paced', paceMs: PACE_MS }),
  scenario({ name: 'm1-pace15-n2', group: 'M1', count: 2, mode: 'paced', paceMs: PACE_MS }),
  scenario({ name: 'm1-pace15-n4', group: 'M1', count: 4, mode: 'paced', paceMs: PACE_MS }),
  scenario({ name: 'm1-pace15-n8', group: 'M1', count: 8, mode: 'paced', paceMs: PACE_MS }),
  // M1 — 30fps 스트레스
  scenario({ name: 'm1-pace30-n1', group: 'M1', count: 1, mode: 'paced', paceMs: PACE30_MS }),
  scenario({ name: 'm1-pace30-n2', group: 'M1', count: 2, mode: 'paced', paceMs: PACE30_MS }),
  scenario({ name: 'm1-pace30-n4', group: 'M1', count: 4, mode: 'paced', paceMs: PACE30_MS }),
  scenario({ name: 'm1-pace30-n8', group: 'M1', count: 8, mode: 'paced', paceMs: PACE30_MS }),
  // 관측자 부담 A/B — MutationObserver 자체 비용을 재서 위 수치의 오차를 밝힌다
  scenario({ name: 'ab-pace15-n4-noobs', group: 'control', count: 4, mode: 'paced', paceMs: PACE_MS, observeDom: false }),
  scenario({ name: 'ab-pace15-n8-noobs', group: 'control', count: 8, mode: 'paced', paceMs: PACE_MS, observeDom: false }),
  // M3 — 크롭 skip 유·무 (탭 프레임 1건, 바뀐 pane 은 1개)
  scenario({ name: 'm3-n4-skipoff', group: 'M3', count: 4, mode: 'paced', paceMs: PACE_MS, activePanes: 1, skip: false }),
  scenario({ name: 'm3-n4-skipon', group: 'M3', count: 4, mode: 'paced', paceMs: PACE_MS, activePanes: 1, skip: true }),
  scenario({ name: 'm3-n8-skipoff', group: 'M3', count: 8, mode: 'paced', paceMs: PACE_MS, activePanes: 1, skip: false }),
  scenario({ name: 'm3-n8-skipon', group: 'M3', count: 8, mode: 'paced', paceMs: PACE_MS, activePanes: 1, skip: true }),
  // M5 — 프레임 크기 민감도 (N=4 고정, 총 셀 수가 다르다 → 셀당으로 정규화해 읽는다)
  scenario({ name: 'm5-pace15-n4-60x20', group: 'M5', count: 4, geo: G.small, mode: 'paced', paceMs: PACE_MS }),
  scenario({ name: 'm5-pace15-n4-120x40', group: 'M5', count: 4, geo: G.big, mode: 'paced', paceMs: PACE_MS }),
  scenario({ name: 'm5-sat-n4-60x20', group: 'M5', count: 4, geo: G.small, mode: 'saturated' }),
  scenario({ name: 'm5-sat-n4-120x40', group: 'M5', count: 4, geo: G.big, mode: 'saturated' }),
]

// --- 실행 ----------------------------------------------------------------------
async function runOne(spec, framesFile, frameStats) {
  const configPath = path.join(TMP, `${spec.name}.config.json`)
  const outPath = path.join(RUNS, `${spec.name}${suffix}.json`)
  fs.writeFileSync(configPath, JSON.stringify({ ...spec, framesFile, out: outPath }, null, 2))

  const child = spawn(path.join(APP_DIR, 'node_modules/.bin/electron'), [HERE], {
    cwd: APP_DIR,
    env: { ...process.env, L373_CONFIG: configPath, ELECTRON_ENABLE_LOGGING: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const log = []
  let rendererPid = null
  let mainPid = null
  const marks = {}
  let buffer = ''
  const onLine = (line) => {
    log.push(line)
    const pid = /^L373 pid main=(\d+) renderer=(\d+)/.exec(line)
    if (pid) {
      mainPid = Number(pid[1])
      rendererPid = Number(pid[2])
    }
    const mark = /^L373 mark (\w+) (\d+)/.exec(line)
    if (mark) marks[mark[1]] = Number(mark[2])
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) !== -1) {
      onLine(buffer.slice(0, i))
      buffer = buffer.slice(i + 1)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => log.push(`[stderr] ${chunk.trimEnd()}`))

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))

  // 측정 창 동안 ps 로 샘플링 — 시작·끝 cputime 델타가 권위값, 주기 샘플은 추이용
  const samples = []
  let startSample = null
  let endSample = null
  let sampling = true
  const sampler = (async () => {
    let seenStart = false
    while (sampling) {
      if (rendererPid !== null) {
        if (!seenStart && marks.measure_start !== undefined) {
          startSample = { ...psSample(rendererPid), main: psSample(mainPid) }
          seenStart = true
        }
        if (seenStart) {
          const s = psSample(rendererPid)
          if (s !== null) samples.push({ ...s, main: psSample(mainPid) })
        }
        if (seenStart && marks.measure_end !== undefined && endSample === null) {
          // 프로세스가 곧 죽는다 — 마지막으로 잡힌 샘플을 끝점으로 쓴다 (경주 회피)
          endSample = samples[samples.length - 1] ?? null
          sampling = false
        }
      }
      await sleep(200)
    }
  })()

  const code = await Promise.race([exited, sleep(WARMUP_MS + MEASURE_MS + 60000).then(() => 'timeout')])
  sampling = false
  await sampler

  if (!fs.existsSync(outPath)) {
    fs.mkdirSync(RUNS, { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify({ name: spec.name, rep: REP, failed: true, exit: code, log }, null, 2) + '\n')
    return { name: spec.name, ok: false, exit: code }
  }

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  // CPU% 는 **샘플 첫 점 ↔ 끝 점의 cputime 델타 ÷ 그 사이 실시간**. 측정창 경계가 아니라
  // 실제로 잡힌 샘플 구간으로 계산한다 (프로세스 종료 경주를 피하려고).
  const first = samples[0] ?? null
  const last = endSample ?? samples[samples.length - 1] ?? null
  const spanSec = first !== null && last !== null ? (last.at - first.at) / 1000 : 0
  const cpu =
    first !== null && last !== null && spanSec > 1
      ? {
          rendererCpuSec: +(last.cpuSec - first.cpuSec).toFixed(2),
          rendererCpuPct: +(((last.cpuSec - first.cpuSec) / spanSec) * 100).toFixed(1),
          mainCpuPct:
            first.main?.cpuSec != null && last.main?.cpuSec != null
              ? +(((last.main.cpuSec - first.main.cpuSec) / spanSec) * 100).toFixed(1)
              : null,
          cpuSpanSec: +spanSec.toFixed(2),
          measureWindowSec: +((marks.measure_end - marks.measure_start) / 1000).toFixed(2),
        }
      : null
  const rssValues = samples.map((s) => s.rssKb).filter((v) => Number.isFinite(v))
  const merged = {
    ...result,
    rep: REP,
    scenario: spec,
    frameStats,
    pids: { main: mainPid, renderer: rendererPid },
    ps: {
      note: 'cputime 델타 ÷ 측정창 = 평균 CPU%. ps 는 앱 바깥 오라클이다 (관문 ②)',
      ...cpu,
      rssKbStart: first?.rssKb ?? null,
      rssKbEnd: last?.rssKb ?? null,
      rssKbMax: rssValues.length > 0 ? Math.max(...rssValues) : null,
      mainRssKbEnd: last?.main?.rssKb ?? null,
      samples,
    },
    marks,
    exit: code,
    log,
  }
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n')
  return { name: spec.name, ok: true, merged }
}

const filters = process.argv.slice(2)
const picked = filters.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => filters.some((f) => s.name.includes(f)))

fs.mkdirSync(RUNS, { recursive: true })

// 기하별 픽스처를 한 번씩 만든다 (결정적 — 커밋하지 않고 재생성 가능)
const fixtures = new Map()
for (const spec of picked) {
  const key = `${spec.panes.cols}x${spec.panes.rows}`
  if (fixtures.has(key)) continue
  const built = await buildFrames({ cols: spec.panes.cols, rows: spec.panes.rows })
  const sizes = built.map((f) => Buffer.byteLength(f, 'utf8'))
  const file = path.join(TMP, `frames-${key}.json`)
  fs.writeFileSync(file, JSON.stringify(built))
  const stats = {
    geometry: key,
    count: built.length,
    bytesMin: Math.min(...sizes),
    bytesMax: Math.max(...sizes),
    bytesAvg: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
    bytesPerCell: +(sizes.reduce((a, b) => a + b, 0) / sizes.length / (spec.panes.cols * spec.panes.rows)).toFixed(2),
  }
  fixtures.set(key, { file, stats })
  // 샘플 1장 + 통계만 커밋한다 (픽스처 본체는 수 MB — 생성기로 재현)
  fs.mkdirSync(path.join(RAW, 'fixtures'), { recursive: true })
  fs.writeFileSync(path.join(RAW, 'fixtures', `sample-${key}.ansi`), built[7])
  fs.writeFileSync(path.join(RAW, 'fixtures', `stats-${key}.json`), JSON.stringify(stats, null, 2) + '\n')
}

const machine = {
  cpu: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
  ncpu: Number(execFileSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' }).trim()),
  memBytes: Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim()),
  macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  node: process.version,
  electron: execFileSync(path.join(APP_DIR, 'node_modules/.bin/electron'), ['--version'], { encoding: 'utf8' }).trim(),
  xterm: JSON.parse(fs.readFileSync(path.join(APP_DIR, 'node_modules/@xterm/xterm/package.json'), 'utf8')).version,
  display: '2560x1440 @144Hz (primary, 사용자 확인)',
  startedAt: new Date().toISOString(),
}
if (REP === '1') fs.writeFileSync(path.join(RAW, 'machine.json'), JSON.stringify(machine, null, 2) + '\n')
console.log('machine', machine.cpu, machine.macos, 'electron', machine.electron, 'xterm', machine.xterm)

const summary = []
for (const spec of picked) {
  const key = `${spec.panes.cols}x${spec.panes.rows}`
  const { file, stats } = fixtures.get(key)
  process.stdout.write(`▶ ${spec.name} … `)
  const r = await runOne(spec, file, stats)
  if (!r.ok) {
    console.log('FAILED', r.exit)
    summary.push({ name: spec.name, failed: true })
    continue
  }
  const m = r.merged
  console.log(
    `written/s=${m.totals.writtenPerSec} (pane당 ${m.totals.perPaneWrittenPerSec}) drop=${m.totals.dropRate} ` +
      `render/s(pane)=${m.totals.perPaneRenderPassesPerSec} writeP95=${m.writeMs.p95}ms ` +
      `rafP95gap=${m.raf.gapMs.p95}ms cpu=${m.ps.rendererCpuPct}% rss=${m.ps.rssKbMax}KB scale=${m.scale}`,
  )
  summary.push({
    name: spec.name,
    rep: REP,
    group: spec.group,
    panes: spec.panes.count,
    geometry: key,
    mode: spec.mode,
    skip: spec.skip,
    activePanes: spec.activePanes,
    scale: m.scale,
    writtenPerSecTotal: m.totals.writtenPerSec,
    writtenPerSecPerPane: m.totals.perPaneWrittenPerSec,
    renderPassesPerSecPerPane: m.totals.perPaneRenderPassesPerSec,
    observeDom: spec.observeDom,
    offered: m.totals.offered,
    dropped: m.totals.dropped,
    dropRate: m.totals.dropRate,
    skipped: m.totals.skipped,
    bytesPerSec: m.totals.bytesPerSec,
    writeMs: m.writeMs,
    queueMs: m.queueMs,
    rafPerSec: m.raf.perSec,
    rafGapMs: m.raf.gapMs,
    longTasks: m.longTasks,
    schedulerLatenessMs: m.schedulerLatenessMs,
    rendererCpuPct: m.ps.rendererCpuPct,
    mainCpuPct: m.ps.mainCpuPct,
    rssKbEnd: m.ps.rssKbEnd,
    rssKbMax: m.ps.rssKbMax,
  })
  fs.writeFileSync(path.join(RAW, `summary${suffix}.json`), JSON.stringify({ machine, rep: REP, runs: summary }, null, 2) + '\n')
  await sleep(600)
}

console.log('\n원자료:', path.relative(REPO_DIR, RUNS))
