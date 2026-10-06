// LIFE-526 — native-footer.mjs 를 **격리 인스턴스**에 먼저 돌려 보는 드라이런(네이티브 관문 아님). 사용자 userData·herdr default 무접촉.
// launchCorral(/tmp/l526i-dry) → /tmp/l526n-dry/{ctl.sock → 격리 제어 소켓, app.pid} → native-footer.mjs → 소유 pid 종료.
// 사용(저장소 루트): node app/scripts/l526/native-footer-dry.mjs <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchCorral, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'
import { pause } from '../gui-diff/lib/cdp.mjs'
import { childExit } from './child-exit.mjs'
import { probePreWipe } from './pre-wipe-guard.mjs'

const rawd = path.resolve(process.argv[2])
const work = '/tmp/l526i-dry'
const root = '/tmp/l526n-dry'
const PORT = 9527
fs.mkdirSync(rawd, { recursive: true })
// fix2 R2-01 — 지우기 **전에** 두 폴더(/tmp·/private/tmp 꼴)·herdr 세션(l443-gui-diff, launchCorral 고정)·CDP 포트를 쓰는 프로세스를 본다.
// 점유 또는 확인 실패면 삭제·fixture·기동 없이 exit 3. 가드 결과는 원자료(guard-before.json)로 남긴다.
const guard = probePreWipe({ dirs: [work, root], ports: [PORT], session: 'l443-gui-diff' })
fs.writeFileSync(path.join(rawd, 'guard-before.json'), `${JSON.stringify(guard, null, 1)}\n`)
if (!guard.pass) {
  console.log(`[l526 dry] 가드: 지우지 않고 멈춘다 — ${guard.reasons.join(' / ')}`)
  process.exit(3)
}
for (const dir of [work, root]) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }) }
const owned = []
let code = 2
try {
  const fixture = ensureFixtureRepo(work)
  const handle = await launchCorral({ appRoot: path.resolve('app'), workDir: work, port: PORT, logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  await seedCorralRepo(handle, fixture.root)
  fs.symlinkSync(handle.control, path.join(root, 'ctl.sock'))
  fs.writeFileSync(path.join(root, 'app.pid'), String(handle.status?.runtime?.pid ?? 0))
  await handle.cdp.close().catch(() => {})
  const run = spawnSync(process.execPath, [path.resolve('app/scripts/l526/native-footer.mjs'), root, rawd], { encoding: 'utf8', timeout: 180_000 })
  // fix1 R1-02 — 타임아웃·시그널·spawn 오류(status null)는 nonzero(2). 오류·시그널도 원자료에 남긴다.
  const judged = childExit({ run })
  fs.writeFileSync(path.join(rawd, 'stdout.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}\nexit=${run.status} signal=${run.signal ?? 'null'} error=${run.error ? String(run.error.code ?? run.error) : 'null'}\n${judged.note}\n`)
  console.log(run.stdout, run.stderr, judged.note)
  code = judged.code
} finally {
  for (const { pid } of owned.filter((entry) => entry.pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* 끝남 */ } }
  await pause(2500)
  for (const { pid } of owned.filter((entry) => entry.pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 끝남 */ } }
}
process.exit(code)
