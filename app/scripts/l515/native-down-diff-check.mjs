// LIFE-515 종료 수정 R4-02 — native-down.sh ③ 의 내장 JS(`diff({ before, after })`)만 떼어 임시 manifest 로 합성 확인한다.
// native-down 전체는 돌리지 않고 사용자 프로필도 읽지 않는다. 기대: 무변경 → 두 목록 빈 배열 · userData 한 파일 변경 → userData 1건·herdr 0건.
// 사용(저장소 루트): node app/scripts/l515/native-down-diff-check.mjs /tmp/l515dd
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const work = process.argv[2]
if (work === undefined || !work.startsWith('/tmp/l515')) throw new Error('사용: native-down-diff-check.mjs /tmp/l515…')
const source = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'native-down.sh'), 'utf8')
const start = source.indexOf('"$NODE" -e "\nconst fs=require')
const end = source.indexOf('\n" "$ROOT/backup/ud-manifest.json"', start)
if (start < 0 || end < 0) throw new Error('native-down.sh 에서 ③ 내장 JS 를 찾지 못했다')
const code = source.slice(start + '"$NODE" -e "\n'.length, end)
console.log(`떼어 낸 내장 JS(${code.length}자):\n${code}\n`)

fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const write = ({ name, files }) => { const file = path.join(work, name); fs.writeFileSync(file, JSON.stringify({ files })); return file }
const base = { 'settings.json': { size: 431, sha: 'a' }, 'ui-prefs.json': { size: 10, sha: 'b' } }
const herdr = { 'session.json': { size: 5, sha: 'c' } }
const run = ({ label, udAfter }) => {
  const args = [write({ name: `${label}-ud-before.json`, files: base }), write({ name: `${label}-ud-after.json`, files: udAfter }), write({ name: `${label}-h-before.json`, files: herdr }), write({ name: `${label}-h-after.json`, files: herdr })]
  const result = spawnSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${label}: 내장 JS 종료코드 ${result.status} ${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  console.log(`${label}: ${JSON.stringify(parsed)}`)
  return parsed
}
const same = run({ label: 'unchanged', udAfter: base })
const changed = run({ label: 'changed-1', udAfter: { ...base, 'settings.json': { size: 432, sha: 'z' } } })
const checks = [
  ['무변경 → userData 0건', same.userData.length === 0],
  ['무변경 → herdr 0건', same.herdr.length === 0],
  ['변경 1 → userData 1건(settings.json 431→432)', changed.userData.length === 1 && changed.userData[0].file === 'settings.json' && changed.userData[0].before === 431 && changed.userData[0].after === 432],
  ['변경 1 → herdr 0건', changed.herdr.length === 0],
]
for (const [name, pass] of checks) console.log(`${pass ? '✔' : '✘'} ${name}`)
fs.rmSync(work, { recursive: true, force: true })
process.exit(checks.every(([, pass]) => pass) ? 0 : 1)
