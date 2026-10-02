// LIFE-445 G7 — raw 글 파일의 홈 접두(`$HOME`)를 `~` 로 바꾼다(작업 트리만). 사용자 레포·브랜치 값은 감사(l471 audit-raw)가 따로 0 을 확인한다.
// 사용: node tilde-raw.mjs <raw 폴더>  → 바꾼 파일 수·치환 수를 출력한다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const raw = path.resolve(process.argv[2])
const home = os.homedir()
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
let files = 0
let hits = 0
for (const file of walk(raw)) {
  if (!/\.(json|md|log|txt|ndjson)$/.test(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  const count = text.split(home).length - 1
  if (count === 0) continue
  fs.writeFileSync(file, text.split(home).join('~'))
  files += 1
  hits += count
}
console.log(JSON.stringify({ raw: path.relative(process.cwd(), raw), files, replaced: hits }))
