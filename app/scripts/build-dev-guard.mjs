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
// 잠금에는 래퍼 pid 와 빌더 그룹을 적어, 래퍼가 강제 종료돼도 남은 빌더가 끝날 때까지 칸을 지킨다(fix2 N2). 공유 툴체인은 빌드 전에 점검·복구한다(fix2 N1).
// `CORRAL_DEV_GUARD_BASE` — 자리를 바꾼다. 격리 확인 전용이다(앱은 이 값을 읽지 않는다).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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

// 칸 잠금 (fix1 L4 → fix2 N2). 잠금 파일에 래퍼 pid 와 빌더 프로세스 그룹(pgid)을 적는다 — 래퍼가 SIGKILL 로 죽어도 빌더 그룹이
// 살아 있으면 잠금이 살아 있는 것으로 본다(고아 빌더 밑에서 트리를 지우거나 두 번째 빌드를 시작하지 않는다).
// 죽은 잠금은 rename 으로 원자적으로 가져간 쪽만 걷는다(동시에 걷는 두 실행이 서로의 새 잠금을 지우지 않게).
const lock = path.join(base, `${key}.lock`)
fs.mkdirSync(base, { recursive: true })
const alive = (pid, group = false) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(group ? -pid : pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const writeLock = (record, flag) => fs.writeFileSync(lock, JSON.stringify(record), { flag })
const takeLock = () => {
  try {
    writeLock({ wrapper: process.pid, builder: null }, 'wx')
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return false
  }
}
const readLock = (file) => {
  const text = fs.readFileSync(file, 'utf8').trim()
  try {
    const record = JSON.parse(text)
    if (typeof record === 'number') return { wrapper: record, builder: null }
    return { wrapper: Number(record.wrapper), builder: record.builder === null ? null : Number(record.builder) }
  } catch {
    return { wrapper: Number(text), builder: null } // fix1 형식(pid 한 줄)
  }
}
if (!takeLock()) {
  let holder = null
  try {
    holder = readLock(lock)
  } catch {
    holder = null // 그 사이 다른 실행이 걷었다 — 아래에서 다시 잡아 본다
  }
  if (holder !== null && alive(holder.wrapper)) fail(`다른 herdr:guard(pid ${holder.wrapper})가 이 칸을 빌드하고 있다 — 끝난 뒤 다시 실행한다`)
  if (holder !== null && alive(holder.builder, true))
    fail(`이 칸의 빌더(프로세스 그룹 ${holder.builder})가 아직 돌고 있다 — 래퍼가 강제 종료된 뒤 남은 빌드다. 끝나기를 기다리거나 kill -TERM -${holder.builder} 로 멈춘 뒤 다시 실행한다`)
  const taken = `${lock}.stale-${process.pid}`
  try {
    fs.renameSync(lock, taken)
    fs.rmSync(taken, { force: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!takeLock()) fail(`다른 herdr:guard 가 방금 이 칸의 잠금을 잡았다 — 끝난 뒤 다시 실행한다 (${lock})`)
}
const releaseLock = () => {
  try {
    if (readLock(lock).wrapper === process.pid) fs.rmSync(lock, { force: true })
  } catch {
    // 이미 없다
  }
}
process.on('exit', releaseLock)

// 공유 툴체인 점검 (fix2 N1) — 상류 archive·zig·rustup 은 모든 칸·worktree 가 같이 쓴다. 끊긴 다운로드·부분 풀기·부분 설치가 남으면
// build-terminal-backend.sh 는 「있는 파일」 로 보고 건너뛰어 영구 실패한다. 래퍼가 빌드 전에 검사해 깨진 것만 지우고 다시 받는다.
// 받는 위치·sha256 은 build-terminal-backend.sh 원문에서 읽는다(상수를 두 곳에 두지 않는다). 직접 호출(CORRAL_BACKEND_BUILD_ROOT)은 이 점검을 거치지 않는다 — 종전 그대로.
const tools = path.join(base, 'toolchain')
const recipe = fs.readFileSync(path.join(app, 'scripts/build-terminal-backend.sh'), 'utf8')
const archive = (name) => {
  const url = new RegExp(`curl -fSL (\\S+) -o "\\$tools/${name.replaceAll('.', '\\.')}"`).exec(recipe)?.[1]
  const digest = new RegExp(`'([0-9a-f]{64})  ${name.replaceAll('.', '\\.')}'`).exec(recipe)?.[1]
  if (url === undefined || digest === undefined) fail(`build-terminal-backend.sh 에서 ${name} 의 주소·sha256 을 찾지 못했다`)
  return { name, url, digest, file: path.join(tools, name) }
}
const fileSHA = (file) => sha(fs.readFileSync(file))
function ensureArchive(item) {
  if (fs.existsSync(item.file)) {
    if (fileSHA(item.file) === item.digest) return
    console.log(`herdr:guard: 툴체인 ${item.name} 의 sha256 이 맞지 않는다(끊긴 다운로드 등) — 지우고 다시 받는다`)
    fs.rmSync(item.file, { force: true })
  }
  const part = `${item.file}.part`
  fs.rmSync(part, { force: true })
  const got = spawnSync('curl', ['-fSL', item.url, '-o', part], { stdio: 'inherit' })
  if (got.status !== 0 || !fs.existsSync(part) || fileSHA(part) !== item.digest) {
    fs.rmSync(part, { force: true })
    fail(`툴체인 ${item.name} 을 받지 못했다(curl exit ${String(got.status)} 또는 sha256 불일치) — 네트워크를 확인하고 다시 실행한다`)
  }
  fs.renameSync(part, item.file)
}
fs.mkdirSync(tools, { recursive: true })
const zigArchive = archive('zig.tar.xz')
ensureArchive(archive('herdr.tar.gz'))
ensureArchive(zigArchive)
// zig 풀기 — 끝까지 풀린 폴더에만 표식을 둔다. 표식 없는 기존 폴더는 archive 목록과 파일 수를 대조해 완전하면 표식을 달고, 아니면 지운다
// (지우면 build-terminal-backend.sh 가 다시 푼다).
const zigDir = path.join(tools, 'zig-aarch64-macos-0.15.2')
const zigMark = path.join(zigDir, '.corral-complete')
if (fs.existsSync(zigDir) && !fs.existsSync(zigMark)) {
  const listed = execFileSync('tar', ['-tf', zigArchive.file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'))
  const missing = listed.filter((entry) => !fs.existsSync(path.join(tools, entry)))
  if (missing.length === 0) fs.writeFileSync(zigMark, `${listed.length}\n`)
  else {
    console.log(`herdr:guard: 툴체인 zig 폴더가 덜 풀려 있다(빠진 파일 ${missing.length}개) — 지우고 다시 푼다`)
    fs.rmSync(zigDir, { recursive: true, force: true })
  }
}
// rustup — cargo shim 은 있는데 툴체인이 덜 깔렸으면 build-terminal-backend.sh 가 설치를 건너뛴다. cargo·rustc 가 답하지 않으면 둘 다 지운다.
const cargoBin = path.join(tools, 'cargo', 'bin', 'cargo')
if (fs.existsSync(cargoBin)) {
  const env = { ...process.env, CARGO_HOME: path.join(tools, 'cargo'), RUSTUP_HOME: path.join(tools, 'rustup') }
  const works = ['cargo', 'rustc'].every((tool) => spawnSync(path.join(tools, 'cargo', 'bin', tool), ['--version'], { env, stdio: 'ignore' }).status === 0)
  if (!works) {
    console.log('herdr:guard: 툴체인 rustup 설치가 깨져 있다(cargo·rustc 가 답하지 않는다) — 지우고 다시 깐다')
    fs.rmSync(path.join(tools, 'cargo'), { recursive: true, force: true })
    fs.rmSync(path.join(tools, 'rustup'), { recursive: true, force: true })
  }
}

// 중단된 칸 (fix1 L1) — 압축 풀기·패치 적용 중 끊겨 트리는 있는데 패치 표식이 없거나 다르면, build-terminal-backend.sh 가
// 「Patch set changed」 로 영구 거절한다. 칸의 트리는 파생물이라 지우고 새로 푼다. 잠금을 잡은 뒤라 살아 있는 빌더 밑이 아니다(fix2 N2).
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
// 빌더는 자기 프로세스 그룹으로 띄운다(detached) — 래퍼가 받은 SIGINT·SIGTERM·SIGHUP 을 그룹 전체(sh·cargo·rustc)에 넘기고 끝나기를 기다린다(fix2 N2).
const builder = spawn('sh', [path.join(app, 'scripts/build-terminal-backend.sh')], {
  stdio: 'inherit',
  detached: true,
  env: { ...process.env, CORRAL_BACKEND_PROFILE: 'debug', CORRAL_BACKEND_BUILD_ROOT: cell, CORRAL_BACKEND_TOOLCHAIN_ROOT: tools },
})
writeLock({ wrapper: process.pid, builder: builder.pid }, 'w')
let forwarded = null
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    forwarded = signal
    try {
      process.kill(-builder.pid, signal)
    } catch {
      // 이미 끝났다
    }
  })
}
const status = await new Promise((resolve) => {
  builder.once('error', () => resolve(-1))
  builder.once('exit', (code, signal) => resolve(code ?? (signal === null ? -1 : 128)))
})
if (forwarded !== null) fail(`${forwarded} 를 받아 빌드를 멈췄다 — 다시 실행하면 이어서(중단된 칸은 다시 풀어) 빌드한다`)
if (status !== 0)
  fail(`build-terminal-backend.sh 실패 (exit ${String(status)}) — 툴체인이 깨진 것 같으면 ${tools} 의 해당 파일·폴더(herdr.tar.gz·zig.tar.xz·zig-aarch64-macos-0.15.2·cargo·rustup)를 지우고 다시 실행한다`)
const after = receiptProblem()
if (after !== null) fail(`빌드 뒤에도 영수증이 맞지 않는다 — ${after}`)
report('built')
