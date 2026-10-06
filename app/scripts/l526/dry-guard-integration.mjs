// LIFE-526 fix2 R2-01 대조 ② — native-footer-dry.mjs 를 **무해한 점유 프로세스**가 있는 상태로 실제 실행한다(앱이 뜨면 안 되는 대조).
// 점유 셋: 경로(/private/tmp 꼴을 argv 에 든 sleep 꼴 node) · herdr 세션 이름(argv 에 `--session l443-gui-diff` 를 든 node) · 포트 9527(LISTEN 하는 node).
// 각 경우 기대: 드라이런 exit 3 · 두 폴더의 표식 파일 그대로 · 두 폴더 전체 목록(이름·크기·mtime) 실행 전=후(삭제·fixture·userData·ctl.sock 생성 0) · native-footer 미실행(stdout.log 없음) ·
// 점유 프로세스 말고는 9527 LISTEN·l443-gui-diff 프로세스 0(= launchCorral 미호출). 점유 프로세스는 이 스크립트가 띄우고 끈다.
// 사용(저장소 루트): node app/scripts/l526/dry-guard-integration.mjs <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const out = path.resolve(process.argv[2])
fs.mkdirSync(out, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DIRS = ['/tmp/l526i-dry', '/tmp/l526n-dry']
const MARK = 'l526 fix2 표식 — 가드가 지우면 안 된다\n'
const IDLE = 'setTimeout(() => {}, 120000)'
const OCCUPIERS = {
  path: [process.execPath, ['-e', IDLE, '/private/tmp/l526i-dry/occupied']],
  session: [process.execPath, ['-e', IDLE, '--', '--session', 'l443-gui-diff']],
  port: [process.execPath, ['-e', "require('net').createServer().listen(9527, '127.0.0.1'); setTimeout(() => {}, 120000)"]],
}
const listeners = () => spawnSync('lsof', ['-nP', '-iTCP:9527', '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.startsWith('p')).map((line) => Number(line.slice(1)))
// run1 실패 교정: 이 스크립트를 띄운 셸의 명령줄에 검색어가 들어 있으면 그 셸이 걸렸다 — 조상 pid 를 뺀다.
const ancestors = (() => {
  const set = new Set([process.pid])
  let pid = process.ppid
  for (let i = 0; i < 20 && pid > 1; i += 1) {
    set.add(pid)
    pid = Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || 1
  }
  return set
})()
const sessionProcs = () => spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.includes('l443-gui-diff')).map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => !ancestors.has(pid))
// run1 실패 교정: 앞선 드라이런이 남긴 파일이 이미 있다 — 「생성」 은 실행 전후 폴더 목록(이름·크기·mtime) 비교로 본다.
const listing = () => DIRS.flatMap((dir) => {
  const walk = (at) => fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(at, entry.name)
    const st = fs.lstatSync(full)
    return [`${full} ${st.size} ${st.mtimeMs}`, ...(entry.isDirectory() && !entry.isSymbolicLink() ? walk(full) : [])]
  }) : []
  return walk(dir)
}).sort()

const rows = []
for (const [name, [cmd, argv]] of Object.entries(OCCUPIERS)) {
  for (const dir of DIRS) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'fix2-marker.txt'), MARK) }
  const before = listing()
  const occupier = spawn(cmd, argv, { stdio: 'ignore' })
  await pause(800)
  const rawd = path.join(out, `dry-${name}`)
  const run = spawnSync(process.execPath, [path.join(here, 'native-footer-dry.mjs'), rawd], { encoding: 'utf8', timeout: 60_000 })
  await pause(500)
  const after = {
    markers: DIRS.map((dir) => ({ dir, intact: fs.existsSync(path.join(dir, 'fix2-marker.txt')) && fs.readFileSync(path.join(dir, 'fix2-marker.txt'), 'utf8') === MARK })),
    entriesBefore: before.length,
    changed: (() => { const now = listing(); return { added: now.filter((x) => !before.includes(x)), removed: before.filter((x) => !now.includes(x)) } })(),
    listeners9527: listeners().filter((pid) => pid !== occupier.pid),
    sessionProcs: sessionProcs().filter((pid) => pid !== occupier.pid),
    nativeFooterRan: fs.existsSync(path.join(rawd, 'stdout.log')) || fs.existsSync(path.join(rawd, 'native-footer.json')),
    guardFile: fs.existsSync(path.join(rawd, 'guard-before.json')),
  }
  occupier.kill('SIGTERM')
  await pause(300)
  const pass = run.status === 3 && after.markers.every((m) => m.intact) && after.changed.added.length === 0 && after.changed.removed.length === 0 && after.listeners9527.length === 0 && after.sessionProcs.length === 0 && !after.nativeFooterRan && after.guardFile
  rows.push({ name, occupier: { pid: occupier.pid, argv }, dry: { status: run.status, signal: run.signal, stdout: run.stdout.trim(), stderr: run.stderr.trim().slice(0, 400) }, after, pass })
  console.log(`${pass ? '통과' : '실패'} ${name}: dry exit ${run.status} · 표식 ${after.markers.map((m) => m.intact).join('/')} · 폴더 변화 +${after.changed.added.length}/-${after.changed.removed.length}(전 ${after.entriesBefore}개) · 9527 ${after.listeners9527.length} · 세션 ${after.sessionProcs.length} · native-footer ${after.nativeFooterRan}`)
}
for (const dir of DIRS) fs.rmSync(path.join(dir, 'fix2-marker.txt'), { force: true })
fs.writeFileSync(path.join(out, 'dry-guard-integration.json'), `${JSON.stringify(rows, null, 1)}\n`)
process.exit(rows.every((row) => row.pass) ? 0 : 1)
