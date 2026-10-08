// LIFE-561 — 개발 실행용 레포 guard herdr(debug)를 레포 공용 고정 자리에 빌드한다. `npm --prefix app run herdr:guard`.
//
// 자리: `<git-common-dir>/corral-herdr-dev/` — 본체·모든 worktree 가 같은 곳을 본다(G1). `.git` 안이라 `git status` 에 나타나지 않는다.
//   toolchain/            rustup·cargo·zig·상류 archive — 칸끼리 한 번만 받는다
//   <패치 digest 16자>/    build root 한 칸 — 패치 집합이 다르면 칸이 다르다. 바이너리는 herdr-0.9.0/target/debug/herdr
// 칸 이름은 build-terminal-backend.sh 의 patch digest(패치 4개를 순서대로 이은 sha256) 앞 16자다 — 패치가 바뀌면 새 칸에 새로 빌드하므로
// 「use a fresh CORRAL_BACKEND_BUILD_ROOT」 거절에 걸리지 않는다.
//
// 그 칸의 영수증이 지금 체크아웃과 맞으면 빌드하지 않고 끝낸다(다시 받거나 다시 빌드하지 않는다). 맞는지 보는 규칙은
// 앱의 `src/main/adapter/internal/dev-guard.ts` `checkGuardReceipt` 와 같다 — 두 곳을 같이 고친다.
// 같은 칸을 두 곳에서 동시에 빌드하지 않게 `<자리>/<칸>.lock` 파일로 막는다(fix1 L4 — 파일이라 앱의 칸 세기에 들지 않는다).
// `CORRAL_DEV_GUARD_BASE` — 자리를 바꾼다. 격리 확인 전용이다(앱은 이 값을 읽지 않는다).
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const repo = path.dirname(app)
const fail = (message) => {
  console.error(`herdr:guard: ${message}`)
  process.exit(1)
}
const sha = (data) => createHash('sha256').update(data).digest('hex')

const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim()
const source = JSON.parse(fs.readFileSync(path.join(app, 'backend/source.json'), 'utf8'))
const patchBytes = source.patches.map((name) => fs.readFileSync(path.join(app, 'backend', name)))
const key = sha(Buffer.concat(patchBytes)).slice(0, 16)
const base = process.env.CORRAL_DEV_GUARD_BASE || path.join(common, 'corral-herdr-dev')
const patchDigest = sha(Buffer.concat(patchBytes))
const cell = path.join(base, key)
const binary = path.join(cell, 'herdr-0.9.0/target/debug/herdr')

function receiptProblem() {
  let receipt
  try {
    receipt = JSON.parse(fs.readFileSync(`${binary}.json`, 'utf8'))
  } catch {
    return '영수증이 없다'
  }
  const expected = source.patches.map((name) => ({ name, sha256: source.patchSHA256[name] }))
  if (receipt.profile !== 'debug') return `영수증 프로필이 debug 가 아니다 (${String(receipt.profile)})`
  if (source.patches.some((name, index) => sha(patchBytes[index]) !== source.patchSHA256[name])) return '패치 파일이 source.json 의 sha256 과 다르다'
  if (JSON.stringify(receipt.patches) !== JSON.stringify(expected)) return '영수증의 패치 목록이 source.json 과 다르다'
  if (receipt.commit !== source.commit || receipt.archiveSHA256 !== source.archiveSHA256) return '영수증의 상류 commit·archive 가 source.json 과 다르다'
  if (!fs.existsSync(binary)) return '바이너리가 없다'
  if (sha(fs.readFileSync(binary)) !== receipt.binarySHA256) return '바이너리 sha256 이 영수증과 다르다'
  return null
}

const report = (state) => {
  const bytes = fs.statSync(binary).size
  console.log(`herdr:guard: ${state} ${binary}`)
  console.log(`herdr:guard: sha256 ${sha(fs.readFileSync(binary))} · ${bytes} bytes · 칸 ${key}`)
}

const before = receiptProblem()
if (before === null) {
  report('up to date')
  process.exit(0)
}
/** `<binary> server` 또는 `<binary> --session <이름> server` 로 도는 프로세스의 pid (fix1 L2). 경로에 공백이 있어도 문자열로 대조한다. */
function serverPids(psOutput, binary) {
  const pids = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line)
    if (match === null) continue
    const args = match[2]
    const session = args.startsWith(`${binary} --session `) && args.endsWith(' server') && !args.slice(binary.length + 11, -7).includes(' ')
    if (args === `${binary} server` || session) pids.push(Number(match[1]))
  }
  return pids
}

// 이미 있는 바이너리를 다시 빌드할 때 그 바이너리로 도는 서버가 있으면 멈춘다 — 실행 중 실행 파일을 바꾸면 서버가 pane 에 알려 준
// HERDR_BIN_PATH 가 깨질 수 있다(상류 #4474). 칸이 패치 digest 별이라 평시 재빌드는 새 칸이고 여기 오지 않는다.
if (fs.existsSync(binary)) {
  const running = serverPids(execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }), binary)
  if (running.length > 0) fail(`이 칸의 바이너리로 도는 herdr 서버가 있다 (${running.join(', ')}) — 그 서버를 멈춘 뒤 다시 실행한다 (${before})`)
}

// 칸 잠금 (fix1 L4). 남은 잠금의 pid 가 죽었으면 걷고 다시 잡는다.
const lock = path.join(base, `${key}.lock`)
fs.mkdirSync(base, { recursive: true })
const takeLock = () => {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return false
  }
}
if (!takeLock()) {
  const holder = Number(fs.readFileSync(lock, 'utf8').trim())
  let alive = false
  try {
    process.kill(holder, 0)
    alive = true
  } catch {
    alive = false
  }
  if (alive) fail(`다른 herdr:guard(pid ${holder})가 이 칸을 빌드하고 있다 — 끝난 뒤 다시 실행한다`)
  fs.rmSync(lock, { force: true })
  if (!takeLock()) fail(`칸 잠금을 잡지 못했다 (${lock})`)
}
process.on('exit', () => {
  try {
    if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock, { force: true })
  } catch {
    // 이미 없다
  }
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))

// 중단된 칸 (fix1 L1) — 압축 풀기·패치 적용 중 끊겨 트리는 있는데 패치 표식이 없거나 다르면, build-terminal-backend.sh 가
// 「Patch set changed」 로 영구 거절한다. 칸의 트리는 파생물이라 지우고 새로 푼다(툴체인·archive 는 칸 밖이라 그대로).
const tree = path.join(cell, 'herdr-0.9.0')
if (fs.existsSync(tree)) {
  let marker = null
  try {
    marker = fs.readFileSync(path.join(tree, '.corral-patches'), 'utf8').trim()
  } catch {
    marker = null
  }
  if (marker !== patchDigest) {
    console.log(`herdr:guard: 중단된 칸의 트리를 지우고 다시 푼다 — 패치 표식 ${marker === null ? '없음' : '다름'} · ${tree}`)
    fs.rmSync(tree, { recursive: true, force: true })
  }
}
console.log(`herdr:guard: 빌드한다 — ${before} · 칸 ${cell}`)
const build = spawnSync('sh', [path.join(app, 'scripts/build-terminal-backend.sh')], {
  stdio: 'inherit',
  env: { ...process.env, CORRAL_BACKEND_PROFILE: 'debug', CORRAL_BACKEND_BUILD_ROOT: cell, CORRAL_BACKEND_TOOLCHAIN_ROOT: path.join(base, 'toolchain') },
})
if (build.status !== 0) fail(`build-terminal-backend.sh 실패 (exit ${String(build.status)})`)
const after = receiptProblem()
if (after !== null) fail(`빌드 뒤에도 영수증이 맞지 않는다 — ${after}`)
report('built')
