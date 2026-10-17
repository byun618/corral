// LIFE-589 E3 기준선 — 감시 방식 후보 비용 탐침(구현 전). 후보마다 **자식 프로세스 하나**에서 잰다(fd 수를 깨끗이 세려고).
//   fswatch  = Node `fs.watch(root, { recursive: true })` (macOS 디렉터리 → FSEvents, 네이티브 0) + JS 거르기
//   parcel   = @parcel/watcher 2.6.0 `subscribe(root, cb, { ignore })` (N-API 프리빌드 — 탐침은 레포 밖 PROBE 폴더의 사본)
//   chokidar = chokidar 5.0.0 `watch(root, { ignored, followSymlinks: false, ignoreInitial: true })`
// 지표: 구독 준비 ms · 프로세스 fd 증가(lsof) · 루트에 파일 하나 만든 뒤 콜백까지 ms(5회) · 제외 경로(node_modules/.l589-probe)에
//       파일 N개 생성 시 **JS 콜백에 도달한 제외 경로 이벤트 수**(거르기 전) · 같은 동안 통과(거른 뒤) 이벤트 수.
// 사용: node scripts/l589/e3-watch-probe.mjs --probe /tmp/l589-watchprobe --target <worktree> --out <json> [--n 1000]
// 대상 worktree 안에 `.l589-probe-*` 파일·`node_modules/.l589-probe/` 를 만들고 끝에 지운다(그 밖은 건드리지 않는다).
import { execFileSync, fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const IGNORED_DIRS = ['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache', 'target', '.venv', '__pycache__']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fdCount = () => execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').length - 1
const isIgnored = (root, file) => path.relative(root, file).split(path.sep).some((part) => IGNORED_DIRS.includes(part))

async function child({ backend, probe, target, n }) {
  const require = createRequire(path.join(probe, 'package.json'))
  const events = []
  const onEvent = (file) => events.push({ at: performance.now(), file })
  const fd0 = fdCount()
  const t0 = performance.now()
  let stop
  if (backend === 'fswatch') {
    const watcher = fs.watch(target, { recursive: true }, (_type, name) => { if (name !== null) onEvent(path.join(target, name)) })
    stop = async () => watcher.close()
  } else if (backend === 'parcel') {
    const parcel = require('@parcel/watcher')
    const sub = await parcel.subscribe(target, (_err, list) => { for (const item of list) onEvent(item.path) }, { ignore: IGNORED_DIRS })
    stop = () => sub.unsubscribe()
  } else {
    const chokidar = await import(require.resolve('chokidar'))
    const watcher = chokidar.watch(target, { ignored: (file) => isIgnored(target, file), followSymlinks: false, ignoreInitial: true })
    await new Promise((resolve) => watcher.once('ready', resolve))
    watcher.on('all', (_type, file) => onEvent(file))
    stop = () => watcher.close()
  }
  const readyMs = performance.now() - t0
  await sleep(1500)
  const fd1 = fdCount()
  const latencies = []
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(target, `.l589-probe-${backend}-${i}`)
    const before = events.length
    const at = performance.now()
    fs.writeFileSync(file, 'x')
    const deadline = at + 5000
    while (performance.now() < deadline && !events.slice(before).some((event) => event.file === file)) await sleep(2)
    const hit = events.slice(before).find((event) => event.file === file)
    latencies.push(hit === undefined ? null : Math.round((hit.at - at) * 10) / 10)
    fs.rmSync(file, { force: true })
    await sleep(300)
  }
  const excludedDir = path.join(target, 'node_modules', '.l589-probe')
  fs.mkdirSync(excludedDir, { recursive: true })
  await sleep(500)
  const mark = events.length
  const tBulk = performance.now()
  for (let i = 0; i < n; i += 1) fs.writeFileSync(path.join(excludedDir, `f${i}`), 'x')
  await sleep(3000)
  const bulk = events.slice(mark)
  const reachedExcluded = bulk.filter((event) => isIgnored(target, event.file)).length
  const passed = bulk.filter((event) => !isIgnored(target, event.file)).length
  fs.rmSync(excludedDir, { recursive: true, force: true })
  await sleep(500)
  await stop()
  await sleep(300)
  const fd2 = fdCount()
  process.send({ backend, readyMs: Math.round(readyMs), fdBefore: fd0, fdWatching: fd1, fdDelta: fd1 - fd0, fdAfterStop: fd2, createLatencyMs: latencies, excludedBulk: { files: n, writeMs: Math.round(performance.now() - tBulk - 3000), eventsReachedJsInExcluded: reachedExcluded, eventsPassedFilter: passed } })
}

async function main() {
  const { values } = parseArgs({ options: { probe: { type: 'string' }, target: { type: 'string' }, out: { type: 'string' }, n: { type: 'string', default: '1000' }, child: { type: 'string' } } })
  if (values.child !== undefined) return child({ backend: values.child, probe: values.probe, target: values.target, n: Number(values.n) })
  const results = []
  for (const backend of ['fswatch', 'parcel', 'chokidar']) {
    const proc = fork(new URL(import.meta.url).pathname, ['--child', backend, '--probe', values.probe, '--target', values.target, '--n', values.n])
    const result = await new Promise((resolve) => { proc.on('message', resolve); proc.on('exit', (code) => resolve({ backend, failed: `exit ${code}` })) })
    proc.kill()
    console.log(JSON.stringify(result))
    results.push(result)
  }
  const out = { at: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, target: values.target, ignoredDirs: IGNORED_DIRS, results }
  fs.mkdirSync(path.dirname(values.out), { recursive: true })
  fs.writeFileSync(values.out, JSON.stringify(out, null, 2) + '\n')
}
await main()
