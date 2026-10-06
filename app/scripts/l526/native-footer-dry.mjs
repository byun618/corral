// LIFE-526 — native-footer.mjs 를 **격리 인스턴스**에 먼저 돌려 보는 드라이런(네이티브 관문 아님). 사용자 userData·herdr default 무접촉.
// launchCorral(/tmp/l526i-dry) → /tmp/l526n-dry/{ctl.sock → 격리 제어 소켓, app.pid} → native-footer.mjs → 소유 pid 종료.
// 사용(저장소 루트): node app/scripts/l526/native-footer-dry.mjs <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchCorral, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'
import { pause } from '../gui-diff/lib/cdp.mjs'

const rawd = path.resolve(process.argv[2])
const work = '/tmp/l526i-dry'
const root = '/tmp/l526n-dry'
for (const dir of [work, root]) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }) }
const owned = []
let code = 2
try {
  const fixture = ensureFixtureRepo(work)
  const handle = await launchCorral({ appRoot: path.resolve('app'), workDir: work, port: 9527, logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  await seedCorralRepo(handle, fixture.root)
  fs.symlinkSync(handle.control, path.join(root, 'ctl.sock'))
  fs.writeFileSync(path.join(root, 'app.pid'), String(handle.status?.runtime?.pid ?? 0))
  await handle.cdp.close().catch(() => {})
  const run = spawnSync(process.execPath, [path.resolve('app/scripts/l526/native-footer.mjs'), root, rawd], { encoding: 'utf8', timeout: 180_000 })
  fs.writeFileSync(path.join(rawd, 'stdout.log'), `${run.stdout}\n${run.stderr}\nexit=${run.status}\n`)
  console.log(run.stdout, run.stderr, 'exit', run.status)
  code = run.status
} finally {
  for (const { pid } of owned.filter((entry) => entry.pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* 끝남 */ } }
  await pause(2500)
  for (const { pid } of owned.filter((entry) => entry.pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 끝남 */ } }
}
process.exit(code)
