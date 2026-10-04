// LIFE-496 — t4-drive.mjs 의 **격리 예행**. 드라이버 결함을 사용자 userData 회차 전에 잡는다. 관문 근거가 아니다(K4 는 네이티브만 센다).
// 격리 = /tmp/l496i* 아래 userData·herdr 세션 `l443-gui-diff`(herdr home 도 그 아래)·제어 소켓 — 사용자 자원과 겹치지 않는다.
// --missing 1 이면 에이전트 실행 파일이 든 폴더를 PATH 에서 빼고(이 프로세스 → herdr 서버 → pane 셸에만) 워치독 양성을 잰다. 사용자 셸 설정은 그대로다.
// --claude 1 이면 claude 를 입력 없이 Quick-launch 로 띄웠다가 닫는다.
// --driver t2 이면 t4-drive 대신 T1·T2 회귀 스모크(t2-smoke.mjs)를 돌린다. --driver t2-orig 이면 l494 원본 t2 복사(t2-orig.mjs — fix4 귀속 실험, 기준 앱용).
// 사용: node iso-t4.mjs --app <app 폴더> --work /tmp/l496iX --port 96NN --out <raw 폴더> [--claude 1] [--missing 1]
//
// fix5 R5-01 — 기동부터 driver·정리·iso-run.json 기록까지 한 수명(try/finally)이다. 기동 실패·driver spawn 예외에도 정리하고 기록한다.
// 신호 대상 = 기동 때 받은 pid + **소유 경로로 확인되는** 프로세스(`launchCorral` 은 Electron pid 를 모르는 실패를 위해 경로를 먼저 등록한다 —
// `corral open` 이 띄운 Electron 은 PPID 1 이라 backend 자손으로 못 잇는다, fix4 head-1) + 그 자손(PPID 사슬).
// 경로 확인 = `lib/own.mjs` `selectOwnedByPath`(앱 명령줄 · 인자 토큰이 경계까지 그 경로 안). 공백 든 경로는 argv 경계를 복원할 수 없어
// (own.mjs H1 · gui-diff R3-01) 신호 근거로 쓰지 않고 보고만 한다. 기동 전부터 그 경로를 쓰던 프로세스는 소유에서 뺀다.
// 종료코드: driver 종료코드 그대로 · 70 = 정리 뒤 잔존(미정리 — 교대 실행기는 여기서 멈춘다) · 71 = 기동/driver spawn 실패(정리는 끝남)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { launchCorral } from '../gui-diff/lib/corral.mjs'
import { cleanVerdict, parseProcessList, pathDiagnosis, planSignals, selectOwnedByPath } from '../gui-diff/lib/own.mjs'

const EXIT_UNCLEAN = 70
const EXIT_LAUNCH_FAILED = 71

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l496i')) throw new Error('--work 는 /tmp/l496i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(work, { recursive: true })
if (args.missing === '1') {
  const agentDirs = new Set(['claude', 'codex', 'grok'].flatMap((bin) => {
    try { return [path.dirname(execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim())] } catch { return [] }
  }))
  process.env.PATH = process.env.PATH.split(':').filter((dir) => !agentDirs.has(dir)).join(':')
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
/** 전체 목록 한 번 — 못 읽으면 「없음」이 아니라 진단 실패다(own.mjs I1). */
const probeProcesses = () => {
  const listed = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (listed.error || listed.status !== 0) return { ok: false, processes: [], error: `ps 실패 ${String(listed.error?.message ?? listed.status)}` }
  const processes = parseProcessList(listed.stdout).filter((entry) => entry.pid !== process.pid)
  return processes.length > 0 ? { ok: true, processes, error: null } : { ok: false, processes: [], error: 'ps 출력이 비었다' }
}
const descendantPids = (pid, seen = new Set()) => {
  const kids = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number).filter(Number.isFinite)
  return kids.filter((kid) => !seen.has(kid)).flatMap((kid) => {
    seen.add(kid)
    return [kid, ...descendantPids(kid, seen)]
  })
}
const commandOf = (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().slice(0, 200) || null

const owned = []
const ownedPaths = () => [...new Set(owned.flatMap((entry) => entry.paths ?? []))]
const fixture = path.join(work, 'fx')
// 기동 전부터 격리 경로를 쓰던 프로세스 — 이번 실행 소유가 아니다(정리 대상에서 뺀다).
const preProbe = probeProcesses()
const isolationPaths = ['corral-userdata', 'corral-herdr'].map((name) => path.join(work, name))
const preexisting = preProbe.ok ? selectOwnedByPath({ processes: preProbe.processes, targets: isolationPaths, selfPid: process.pid }).owned.map((entry) => entry.pid) : []
let failure = null
let driverExit = null

try {
  if (!preProbe.ok) throw new Error(`기동 전 프로세스 목록 실패 — ${preProbe.error}`)
  if (preexisting.length > 0) throw new Error(`격리 경로를 쓰는 프로세스가 이미 있다(${preexisting.join(', ')}) — 기동하지 않는다`)
  if (!fs.existsSync(fixture)) {
    fs.mkdirSync(fixture)
    execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
  }
  let handle
  try {
    handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  } catch (error) {
    failure = { stage: 'launch', message: String(error?.message ?? error) }
    throw error
  }
  const child = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), ({ t2: 't2-smoke.mjs', 't2-orig': 't2-orig.mjs' })[args.driver] ?? 't4-drive.mjs'), work, out, fs.realpathSync(fixture)], {
    stdio: 'inherit',
    env: { ...process.env, L496_CTL: handle.control, L496_HERDR_SESSION: 'l443-gui-diff', L496_HERDR_HOME: path.join(work, 'corral-herdr'), L496_CLAUDE: args.claude ?? '0', L496_MISSING: args.missing ?? '0' },
  })
  if (child.error) {
    failure = { stage: 'driver-spawn', message: String(child.error.message ?? child.error) }
  } else {
    driverExit = child.status
  }
  await handle.cdp?.close?.().catch(() => {})
} catch (error) {
  failure ??= { stage: 'setup', message: String(error?.message ?? error) }
} finally {
  // ① 신호 대상: spawn pid + 소유 경로로 확인되는 프로세스(공백 없는 경로만) + 자손. 자손은 신호 전에 적는다.
  const probe = probeProcesses()
  const paths = ownedPaths()
  const signallablePaths = paths.filter((item) => !/\s/.test(item))
  const byPath = probe.ok ? selectOwnedByPath({ processes: probe.processes, targets: signallablePaths, exclude: preexisting, selfPid: process.pid }).owned : []
  const spawned = owned.filter((entry) => Number.isFinite(entry.pid)).map((entry) => ({ pid: entry.pid, label: entry.label ?? 'spawn' }))
  const planned = planSignals({
    owned: [...spawned, ...byPath.map((entry) => ({ pid: entry.pid, label: `소유 경로 확인 ${entry.path}` }))],
    descendantsOf: (pid) => descendantPids(pid),
  })
  const signalled = planned.map((entry) => {
    const record = { ...entry, command: commandOf(entry.pid) }
    try {
      process.kill(entry.pid, 'SIGTERM')
      record.sent = 'SIGTERM'
    } catch (error) {
      record.sent = String(error?.code ?? error)
    }
    return record
  })
  for (let attempt = 0; attempt < 12 && signalled.some((entry) => alive(entry.pid)); attempt += 1) await pause(1000)
  for (const entry of signalled) entry.alive = alive(entry.pid)
  // ② 신호 목록 밖에서 소유 경로를 쓰는 생존자 — 보고만 한다(미정리).
  const diagnosis = pathDiagnosis({ probe: probeProcesses(), targets: paths, exclude: preexisting, signalled: signalled.map((entry) => entry.pid), selfPid: process.pid, alive })
  const verdict = cleanVerdict({ signalled: signalled.map((entry) => ({ pid: entry.pid, alive: entry.alive })), diagnosis })
  const exitCode = !verdict.clean ? EXIT_UNCLEAN : failure !== null ? EXIT_LAUNCH_FAILED : driverExit !== 0 ? (driverExit ?? 2) : 0
  fs.writeFileSync(path.join(out, 'iso-run.json'), `${JSON.stringify({
    exitCode, driverExit, failure, owned, preexisting, unsignalledPaths: paths.filter((item) => /\s/.test(item)), byPath, signalled,
    survivors: verdict.survivorPids, clean: verdict.clean, uncleanWhy: verdict.why, pathSurvivors: diagnosis.survivors,
    missing: args.missing === '1', claude: args.claude === '1',
  }, null, 1)}\n`)
  console.log('[iso-t4]', JSON.stringify({ exitCode, driverExit, failure: failure?.stage ?? null, survivors: verdict.survivorPids }))
  // 열린 소켓·타이머가 남아도 기록한 종료코드로 끝낸다.
  process.exit(exitCode)
}
