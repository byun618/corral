// LIFE-494 — native-t2.mjs 의 **격리 예행**. 드라이버 결함을 사용자 userData 회차 전에 잡는다. 관문 근거가 아니다(K4 는 네이티브만 센다).
// 격리 = /tmp/l494i* 아래 userData·herdr 세션 `l443-gui-diff`(herdr home 도 그 아래)·제어 소켓 — 사용자 자원과 겹치지 않는다.
// 사용: node iso-t2.mjs --app <app 폴더> --work /tmp/l494iX --port 95NN --out <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { launchCorral } from '../gui-diff/lib/corral.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l494i')) throw new Error('--work 는 /tmp/l494i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(work, { recursive: true })
const owned = []
const fixture = path.join(work, 'fx')
if (!fs.existsSync(fixture)) {
  fs.mkdirSync(fixture)
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
}
const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
const child = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'native-t2.mjs'), work, out, fs.realpathSync(fixture)], {
  stdio: 'inherit',
  env: { ...process.env, L494_CTL: handle.control, L494_HERDR_SESSION: 'l443-gui-diff', L494_HERDR_HOME: path.join(work, 'corral-herdr') },
})
for (const entry of [...owned].reverse()) {
  if (!entry.pid) continue
  try { process.kill(entry.pid, 'SIGTERM') } catch {}
}
await new Promise((resolve) => setTimeout(resolve, 2000))
const survivors = owned.filter((entry) => entry.pid).filter((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } }).map((entry) => entry.pid)
fs.writeFileSync(path.join(out, 'iso-run.json'), `${JSON.stringify({ driverExit: child.status, owned, survivors }, null, 1)}\n`)
console.log('[iso-t2]', JSON.stringify({ driverExit: child.status, survivors }))
// 드라이버가 통과해도 끄지 못한 프로세스가 남으면 실패다(r1 R1-05) — 드라이버 실패 코드가 먼저.
const exitCode = child.status !== 0 ? (child.status ?? 2) : survivors.length > 0 ? 3 : 0
if (survivors.length > 0) console.error(`[iso-t2] 잔존 프로세스 ${survivors.join(',')} — exit ${exitCode}`)
process.exit(exitCode)
