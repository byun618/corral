// LIFE-470 수정 라운드 2 (R2-02) — 익명화 멱등 자기점검. 지어낸 사용자 레포로 `sanitize-raw.mjs` 를 끝까지 돌린다(대응표는 임시 비공개 위치).
//   ① 원래 값 회차 → sanitize 1회   ② 같은 raw 에 sanitize 다시 → 바이트·대응표 그대로여야 한다(멱등)
//   ③ 이미 익명화된 회차 옆에 **새 원래 값 회차**를 더하고 sanitize → 옛 회차 바이트 그대로 + 새 회차가 같은 키(repo#1·wt#1·br#N)
//   ④ 예전 코드가 남긴 별칭 대응표(`repo#1 → repo#2` — 라운드 1 실제 대응표가 이 모양이었다)에서 sanitize → 다른 출처의 정상 익명 키
//      (`repo#1`)를 고쳐 쓰지 않고, 새 원래 값 회차는 별칭 끝 키(이미 커밋된 raw 의 키)로 적힌다
// 하나라도 어기면 종료코드 1. 사용: node anon-check.mjs [--scripts <sanitize-raw.mjs·anon.mjs 가 든 폴더>] — 음성 대조는 옛 코드 폴더를 준다.
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scriptsIndex = process.argv.indexOf('--scripts')
const scripts = scriptsIndex > 0 ? path.resolve(process.argv[scriptsIndex + 1]) : path.dirname(new URL(import.meta.url).pathname)
const work = fs.mkdtempSync('/tmp/l470-anoncheck-')
const raw = path.join(work, 'raw')
const privateDir = path.join(work, 'private')
const HOME = os.homedir()

// 지어낸 사용자 레포 — 홈 아래 경로(`~` 치환 대상)와 홈 밖 경로를 섞는다. 실제 파일은 만들지 않는다.
const root = path.join(HOME, 'l470-synthetic', 'proj')
const linked = path.join(HOME, 'l470-synthetic', 'proj-wt', 'feature')
const other = '/synthetic-elsewhere/repo'
const original = {
  step: 'state',
  read: { groups: [{ root, worktrees: [root, linked] }, { root: other, worktrees: [other] }], all: null, branches: { [root]: 'main', [linked]: 'feature/x', [other]: 'trunk' } },
}
const writeRun = (dir) => {
  fs.mkdirSync(path.join(raw, dir), { recursive: true })
  fs.writeFileSync(path.join(raw, dir, 'state-1.json'), JSON.stringify(original, null, 2) + '\n')
  fs.writeFileSync(path.join(raw, dir, 'note.md'), `원래 경로 ${root} · ${linked}\n`)
}
const sanitize = () => spawnSync(process.execPath, [path.join(scripts, 'sanitize-raw.mjs'), raw], { encoding: 'utf8', env: { ...process.env, L470_PRIVATE_DIR: privateDir } })
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
const tree = () => Object.fromEntries(walk(raw).sort().map((file) => [path.relative(raw, file), sha(file)]))
const mapFile = path.join(privateDir, 'anon-map.json')
const mapCounts = () => {
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  return { repo: Object.keys(map.repo).length, wt: Object.keys(map.wt).length, br: Object.keys(map.br).length }
}

const checks = []
const check = (id, ok, detail) => checks.push({ id, ok, detail })

writeRun('native1')
const pass1 = sanitize()
const tree1 = tree()
const map1 = mapCounts()
const anon1 = fs.readFileSync(path.join(raw, 'native1', 'state-1.json'), 'utf8')
check('pass1-ran', pass1.status === 0, { status: pass1.status })
check('pass1-anonymized', !anon1.includes(root) && !anon1.includes(HOME) && !anon1.includes(other), { leftOriginal: anon1.includes(root) || anon1.includes(other) })

const pass2 = sanitize()
const tree2 = tree()
check('pass2-bytes-same', pass2.status === 0 && JSON.stringify(tree1) === JSON.stringify(tree2), { status: pass2.status, changed: Object.keys(tree2).filter((file) => tree1[file] !== tree2[file]) })
check('pass2-map-same', JSON.stringify(mapCounts()) === JSON.stringify(map1), { before: map1, after: mapCounts() })

writeRun('native2')
const pass3 = sanitize()
const tree3 = tree()
const anon2 = fs.readFileSync(path.join(raw, 'native2', 'state-1.json'), 'utf8')
check('pass3-old-run-same', pass3.status === 0 && Object.keys(tree1).every((file) => tree3[file] === tree1[file]), { status: pass3.status, changed: Object.keys(tree1).filter((file) => tree3[file] !== tree1[file]) })
check('pass3-new-run-same-keys', anon2 === anon1, { equal: anon2 === anon1 })
check('pass3-map-same', JSON.stringify(mapCounts()) === JSON.stringify(map1), { before: map1, after: mapCounts() })

// ④ 별칭 대응표 — 새 폴더에서. 이미 처리된 회차(끝 키 repo#2·wt#2)·다른 출처의 익명 키 글(repo#1)·새 원래 값 회차.
fs.rmSync(raw, { recursive: true, force: true })
fs.rmSync(privateDir, { recursive: true, force: true })
fs.mkdirSync(privateDir, { recursive: true })
fs.writeFileSync(mapFile, JSON.stringify({ repo: { [root]: 'repo#1', 'repo#1': 'repo#2', [other]: 'repo#3' }, wt: { [linked]: 'wt#1', 'wt#1': 'wt#2' }, br: {} }))
fs.mkdirSync(path.join(raw, 'checks'), { recursive: true })
fs.writeFileSync(path.join(raw, 'checks', 'other-source.md'), '자기점검 출력의 익명 키 repo#1 · wt#1\n')
writeRun('native3')
const pass4 = sanitize()
const aliased = JSON.parse(fs.readFileSync(path.join(raw, 'native3', 'state-1.json'), 'utf8')).read
check('pass4-other-source-kept', pass4.status === 0 && fs.readFileSync(path.join(raw, 'checks', 'other-source.md'), 'utf8') === '자기점검 출력의 익명 키 repo#1 · wt#1\n', { status: pass4.status })
check('pass4-new-run-final-key', aliased.groups[0].root === 'repo#2' && aliased.groups[0].worktrees[1] === 'wt#2' && aliased.groups[1].root === 'repo#3', { roots: aliased.groups.map((group) => group.root) })
const collapsed = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
check('pass4-map-collapsed', Object.keys(collapsed.repo).every((value) => !/^(repo|wt|br)#\d+$/.test(value)) && Object.keys(collapsed.wt).every((value) => !/^(repo|wt|br)#\d+$/.test(value)), { repo: Object.values(collapsed.repo), wt: Object.values(collapsed.wt) })

fs.rmSync(work, { recursive: true, force: true })
const ok = checks.every((item) => item.ok)
// 출력에는 지어낸 값의 익명 결과와 개수만 — 홈 경로는 싣지 않는다.
console.log(JSON.stringify({ scripts: path.basename(scripts), verdict: ok ? 'pass' : 'fail', checks, anonymizedRun1: JSON.parse(anon1).read }, null, 2))
process.exit(ok ? 0 : 1)
