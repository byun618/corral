// LIFE-519 K1ⓒ / K2ⓒ — CLI `open` 콜드 기동(격리 userData·격리 herdr) 중 Electron 메인에 시험용 지연(delay.cjs, NODE_OPTIONS)을 싣는다.
// 관측기가 endpoint 를 촘촘히 lstat. 끝에 격리 Electron·herdr 를 끄고 잔존을 확인한다.
// 사용: node k1c-open.mjs <work=/tmp/l519w*> <지연 ms, 0=없음> <fail|pass> <out.json>
//   fail: open exit≠0 이고 출력이 관측 원문 outcome_unknown 「Desktop handoff/launch may have taken effect: Socket and parent must be private and owned by this user」
//   pass: open exit 0·ui.available true·관측기 loose 0
// 둘 다 잔존(이 work 경로를 쓰는 프로세스) 0 이어야 exit 0.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { header, guard, isolation, startHerdr, startObserver, stopPids, electronPids, processesUsing, APP, HERE, pause } from './lib.mjs'
const [work, delayArg, expect, out] = process.argv.slice(2)
guard(work)
fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true, mode: 0o700 })
const iso = isolation(work)
const electron = path.join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const result = { ...header(), electron, work, delayMs: Number(delayArg), expect }
const herdrPid = await startHerdr(iso)
const observer = await startObserver(iso.endpoint, path.join(work, 'obs.json'))
const env = { ...iso.env }
if (Number(delayArg) > 0) Object.assign(env, { NODE_OPTIONS: `--require ${path.join(HERE, 'delay.cjs')}`, L519_DELAY_PATH: iso.endpoint, L519_DELAY_MS: delayArg })
const t0 = Date.now()
const open = spawnSync(process.execPath, [path.join(APP, 'cli/corral.mjs'), 'open', '--json'], { env, encoding: 'utf8', timeout: 90000 })
result.open = { exit: open.status, signal: open.signal, ms: Date.now() - t0, stdout: open.stdout.trim(), stderr: open.stderr.trim() }
await pause(300)
const obs = await observer.finish()
result.observer = { samples: obs.samples, intervalUs: obs.intervalUs, elapsedMs: obs.elapsedMs, loose: obs.loose, firstSeen: obs.firstSeen, modes: obs.modes, transitions: obs.transitions }
try { const st = fs.lstatSync(iso.endpoint), parent = fs.lstatSync(path.dirname(iso.endpoint)); result.finalModes = { socket: (st.mode & 0o777).toString(8), parent: (parent.mode & 0o777).toString(8) } } catch (error) { result.finalModes = String(error) }
const log = path.join(iso.userData, 'runtime/desktop.log')
result.delayLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes('[l519-delay]')) : []
const pids = electronPids(iso.userData)
result.electronPids = pids
result.electronLeft = await stopPids(pids)
result.herdrPid = herdrPid
result.herdrLeft = await stopPids([herdrPid])
await pause(300)
result.leftovers = processesUsing(work)
let parsed = null; try { parsed = JSON.parse(open.stdout) } catch {}
const OBSERVED = 'Desktop handoff/launch may have taken effect: Socket and parent must be private and owned by this user'
const met = expect === 'fail'
  ? open.status !== 0 && parsed?.error?.code === 'outcome_unknown' && parsed?.error?.message === OBSERVED && (Number(delayArg) === 0 || result.delayLog.length === 1)
  : open.status === 0 && parsed?.result?.ui?.available === true && obs.loose === 0 && (Number(delayArg) === 0 || result.delayLog.length === 1)
result.verdict = { expect, met: met && result.leftovers.length === 0 && result.electronLeft.length === 0 && result.herdrLeft.length === 0 }
fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n')
console.log(JSON.stringify({ open: result.open.exit, stdout: result.open.stdout.slice(0, 300), loose: obs.loose, firstSeen: obs.firstSeen, modes: obs.modes, delayLog: result.delayLog, finalModes: result.finalModes, electronPids: pids, leftovers: result.leftovers, verdict: result.verdict }))
process.exit(result.verdict.met ? 0 : 1)
