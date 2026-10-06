// LIFE-527 K5·K1 — OS 수준 입력(cliclick)을 받을 두 격리 인스턴스를 띄워 두고 SIGTERM 까지 기다린다.
// Orca = 198 개발 인스턴스(/tmp/l443/orca-198, 버리는 HOME, :9444) · corral = 격리 인스턴스(:9445, 구현 빌드 out/).
// 측정 도구와 달리 뷰포트 에뮬레이션을 걸지 않는다 — OS 좌표 = 실제 창 좌표여야 한다.
// 상태(포트·소유 pid)는 <work>/os-state.json. 끄기는 이 프로세스에 SIGTERM — 띄운 것만 끈다.
//
// 실행: node app/scripts/l527/os-up.mjs --work /tmp/l527os --out <원자료 폴더> [--corral-app <다른 빌드의 app 폴더>] [--no-orca]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchOrca, seedOrcaRepo } from '../gui-diff/lib/orca.mjs'
import { launchCorral, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'
import { pause } from '../gui-diff/lib/cdp.mjs'
import { fileFingerprint, keybindingsLeakVerdict, probe504 } from '../gui-diff/lib/guards.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const withOrca = !process.argv.includes('--no-orca')
const appRoot = path.resolve(arg('--corral-app', null) ?? path.resolve(here, '../..'))
const outDir = path.resolve(arg('--out', ''))
const work = arg('--work', '/tmp/l527os')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(work, { recursive: true })
const log = (...parts) => console.log('[l527 os-up]', ...parts)

const guard = probe504({ work })
fs.writeFileSync(path.join(outDir, 'guard-504.json'), `${JSON.stringify(guard, null, 2)}\n`)
if (!guard.pass) { log("504 가드 걸림 — 띄우지 않는다", JSON.stringify(guard.hits)); process.exit(1) }
const keybindingsFile = path.join(process.env.HOME, '.orca/keybindings.json')
const f18Before = fileFingerprint(keybindingsFile)

const owned = []
const own = (entry) => { if (entry.pid) owned.push(entry) }
const stateFile = path.join(work, 'os-state.json')

async function shutdown(code) {
  for (const entry of [...owned].reverse()) {
    try { process.kill(entry.group ? -entry.pid : entry.pid, 'SIGTERM') } catch { /* 이미 없다 */ }
  }
  await pause(2000)
  const f18 = keybindingsLeakVerdict({ before: f18Before, after: fileFingerprint(keybindingsFile) })
  fs.writeFileSync(path.join(outDir, 'os-shutdown.json'), `${JSON.stringify({ at: new Date().toISOString(), owned, f18 }, null, 2)}\n`)
  fs.rmSync(stateFile, { force: true })
  log('끝', code)
  process.exit(code)
}

try {
  for (const name of ['orca-dev-userdata', 'corral-userdata', 'corral-herdr']) fs.rmSync(path.join(work, name), { recursive: true, force: true })
  const fixture = ensureFixtureRepo(work)
  if (withOrca) {
    const orca = await launchOrca({ repoRoot: '/tmp/l443/orca-198', workDir: work, port: 9444, logPath: path.join(outDir, 'orca-dev.log'), onSpawn: own })
    await seedOrcaRepo(orca, fixture.root)
  }
  const corral = await launchCorral({ appRoot, workDir: work, port: 9445, logDir: outDir, onSpawn: own })
  await seedCorralRepo(corral, fixture.root)
  fs.writeFileSync(stateFile, `${JSON.stringify({ at: new Date().toISOString(), upPid: process.pid, appRoot, orcaPort: withOrca ? 9444 : null, corralPort: 9445, corralControl: corral.control, owned }, null, 2)}\n`)
  log('준비', stateFile)
} catch (error) {
  log('실패:', String(error?.stack ?? error))
  await shutdown(1)
}
process.on('SIGTERM', () => { void shutdown(0) })
process.on('SIGINT', () => { void shutdown(0) })
setInterval(() => {}, 60_000)
