// LIFE-526 — native-footer.mjs 를 **격리 인스턴스**에 먼저 돌려 보는 드라이런(네이티브 관문 아님). 사용자 userData·herdr default 무접촉.
// launchCorral(/tmp/l526i-dry) → /tmp/l526n-dry/{ctl.sock → 격리 제어 소켓, app.pid} → native-footer.mjs → 소유 pid 종료.
// 사용(저장소 루트): node app/scripts/l526/native-footer-dry.mjs <raw 폴더>
// fix3 — 본문을 runDry({ rawd, deps }) 로 내보낸다(직접 실행하면 실제 의존성으로 돈다). 대조는 deps 를 기록용 가짜로 바꿔 호출부 순서를 본다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { launchCorral, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'
import { pause } from '../gui-diff/lib/cdp.mjs'
import { childExit } from './child-exit.mjs'
import { collectPreWipe, probePreWipe } from './pre-wipe-guard.mjs'

const work = '/tmp/l526i-dry'
const root = '/tmp/l526n-dry'
const PORT = 9527

/** 실제 의존성 — 대조(dry-guard-memory.mjs)는 이것을 기록만 하는 가짜로 바꿔 끼운다(fix3: 가드 실패 시 삭제·fixture·기동 0회를 호출부에서 확인). */
const REAL = { collect: collectPreWipe, rmSync: fs.rmSync, mkdirSync: fs.mkdirSync, ensureFixtureRepo, launchCorral }

export async function runDry({ rawd, deps = REAL }) {
  fs.mkdirSync(rawd, { recursive: true })
  // fix2 R2-01 — 지우기 **전에** 두 폴더(/tmp·/private/tmp 꼴)·herdr 세션(l443-gui-diff, launchCorral 고정)·CDP 포트를 쓰는 프로세스를 본다.
  // 점유 또는 확인 실패면 삭제·fixture·기동 없이 exit 3. 가드 결과는 원자료(guard-before.json)로 남긴다.
  const guard = probePreWipe({ dirs: [work, root], ports: [PORT], session: 'l443-gui-diff', collect: deps.collect })
  fs.writeFileSync(path.join(rawd, 'guard-before.json'), `${JSON.stringify(guard, null, 1)}\n`)
  if (!guard.pass) {
    console.log(`[l526 dry] 가드: 지우지 않고 멈춘다 — ${guard.reasons.join(' / ')}`)
    return 3
  }
  for (const dir of [work, root]) { deps.rmSync(dir, { recursive: true, force: true }); deps.mkdirSync(dir, { recursive: true }) }
  const owned = []
  let code = 2
  try {
    const fixture = deps.ensureFixtureRepo(work)
    const handle = await deps.launchCorral({ appRoot: path.resolve('app'), workDir: work, port: PORT, logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
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
  } catch (error) {
    console.log(`[l526 dry] 오류: ${String(error?.message ?? error)}`)
  } finally {
    for (const { pid } of owned.filter((entry) => entry.pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* 끝남 */ } }
    if (owned.length > 0) await pause(2500)
    for (const { pid } of owned.filter((entry) => entry.pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 끝남 */ } }
  }
  return code
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(await runDry({ rawd: path.resolve(process.argv[2]) }))
}
