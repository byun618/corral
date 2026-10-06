// LIFE-515 K9ⓐ (l513 사본) — eslint JSON 두 개(기준·HEAD)를 비교해 HEAD 에만 있는 오류를 낸다. 키 = 앱 기준 상대 경로 · 규칙 · 문구(줄 번호 제외), 개수 비교.
// 루트는 realpath 로 맞춘다(/tmp → /private/tmp — eslint 는 실경로를 낸다). 사용: node app/scripts/l515/lint-compare.mjs <base.json> <baseRoot> <head.json> <headRoot> — 새 오류가 있으면 종료코드 1.
import fs from 'node:fs'
import path from 'node:path'
const [baseFile, baseRoot, headFile, headRoot] = process.argv.slice(2)
const count = ({ file, root }) => {
  const map = new Map()
  let errors = 0
  for (const entry of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    for (const m of entry.messages) {
      if (m.severity !== 2) continue
      errors += 1
      const key = `${path.relative(fs.realpathSync(root), entry.filePath)} · ${m.ruleId} · ${m.message}`
      map.set(key, (map.get(key) ?? 0) + 1)
    }
  }
  return { map, errors }
}
const base = count({ file: baseFile, root: baseRoot })
const head = count({ file: headFile, root: headRoot })
const added = []
for (const [key, n] of head.map) { const before = base.map.get(key) ?? 0; if (n > before) added.push(`${key} (+${n - before})`) }
console.log(`기준 오류 ${base.errors} · HEAD 오류 ${head.errors} · HEAD 에만 있는 오류 ${added.length}`)
for (const line of added) console.log(`- ${line}`)
process.exit(added.length === 0 ? 0 : 1)
