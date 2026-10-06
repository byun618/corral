// LIFE-516 K9ⓕ — 사용자 settings.json·ui-prefs.json·repos.json 의 전(백업 manifest)·회차 직후·원복 뒤 해시를 따로 보인다(킥오프 격리 7).
// 사용: node app/scripts/l516/three-files.mjs <raw 폴더(ud-manifest-before/after-run/after-restore.json 이 있는 곳)>
import fs from 'node:fs'
import path from 'node:path'
const rawd = process.argv[2]
const load = (name) => JSON.parse(fs.readFileSync(path.join(rawd, name), 'utf8')).files
const before = load('ud-manifest-before.json')
const afterRun = load('ud-manifest-after-run.json')
const afterRestore = load('ud-manifest-after-restore.json')
let bad = 0
for (const file of ['settings.json', 'ui-prefs.json', 'repos.json']) {
  const row = (m) => (m[file] === undefined ? '(없음)' : `${m[file].sha256 ?? m[file].hash ?? JSON.stringify(m[file])} ${m[file].size}B`)
  const same = JSON.stringify(before[file]) === JSON.stringify(afterRestore[file])
  if (!same) bad += 1
  console.log(`${file}\n  전       ${row(before)}\n  회차 직후 ${row(afterRun)}${JSON.stringify(before[file]) === JSON.stringify(afterRun[file]) ? ' (회차가 안 바꿈)' : ' (회차가 바꿈)'}\n  원복 뒤  ${row(afterRestore)}  ${same ? '✔ 전=후' : '✘ 불일치'}`)
}
process.exit(bad === 0 ? 0 : 1)
