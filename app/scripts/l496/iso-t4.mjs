// LIFE-496 — t4-drive.mjs 의 **격리 예행**. 드라이버 결함을 사용자 userData 회차 전에 잡는다. 관문 근거가 아니다(K4 는 네이티브만 센다).
// 격리 = /tmp/l496i* 아래 userData·herdr 세션 `l443-gui-diff`(herdr home 도 그 아래)·제어 소켓 — 사용자 자원과 겹치지 않는다.
// --missing 1 이면 에이전트 실행 파일이 든 폴더를 PATH 에서 빼고(이 프로세스 → herdr 서버 → pane 셸에만) 워치독 양성을 잰다. 사용자 셸 설정은 그대로다.
// --claude 1 이면 claude 를 입력 없이 Quick-launch 로 띄웠다가 닫는다.
// --driver t2 이면 t4-drive 대신 T1·T2 회귀 스모크(t2-smoke.mjs)를 돌린다.
// 사용: node iso-t4.mjs --app <app 폴더> --work /tmp/l496iX --port 96NN --out <raw 폴더> [--claude 1] [--missing 1]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { launchCorral } from '../gui-diff/lib/corral.mjs'

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
const owned = []
const fixture = path.join(work, 'fx')
if (!fs.existsSync(fixture)) {
  fs.mkdirSync(fixture)
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
}
const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
const child = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), args.driver === 't2' ? 't2-smoke.mjs' : 't4-drive.mjs'), work, out, fs.realpathSync(fixture)], {
  stdio: 'inherit',
  env: { ...process.env, L496_CTL: handle.control, L496_HERDR_SESSION: 'l443-gui-diff', L496_HERDR_HOME: path.join(work, 'corral-herdr'), L496_CLAUDE: args.claude ?? '0', L496_MISSING: args.missing ?? '0' },
})
for (const entry of [...owned].reverse()) {
  if (!entry.pid) continue
  try { process.kill(entry.pid, 'SIGTERM') } catch {}
}
await new Promise((resolve) => setTimeout(resolve, 2000))
const survivors = owned.filter((entry) => entry.pid).filter((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } }).map((entry) => entry.pid)
fs.writeFileSync(path.join(out, 'iso-run.json'), `${JSON.stringify({ driverExit: child.status, owned, survivors, missing: args.missing === '1', claude: args.claude === '1' }, null, 1)}\n`)
console.log('[iso-t4]', JSON.stringify({ driverExit: child.status, survivors }))
const exitCode = child.status !== 0 ? (child.status ?? 2) : survivors.length > 0 ? 3 : 0
process.exit(exitCode)
