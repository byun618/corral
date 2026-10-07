// LIFE-518 K5ⓒ — eslint JSON 두 개(기준·HEAD)를 비교해 HEAD 에만 있는 경고·오류를 낸다(l516/lint-compare 는 오류만 봐서 경고까지 본다).
// 키 = 앱 기준 상대 경로 · 심각도 · 규칙 · 문구(줄 번호 제외), 개수 비교. 사용: node scripts/l518/lint-compare.mjs <base.json> <head.json> — 새 항목이 있으면 종료코드 1.
import fs from 'node:fs'
import path from 'node:path'
const APP_DIR = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))
const [baseFile, headFile] = process.argv.slice(2)
const count = (file) => {
  const map = new Map()
  const totals = { errors: 0, warnings: 0, files: 0 }
  for (const entry of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    totals.files += 1
    for (const m of entry.messages) {
      if (m.severity === 2) totals.errors += 1
      else totals.warnings += 1
      const key = `${path.relative(APP_DIR, entry.filePath)} · ${m.severity === 2 ? 'error' : 'warn'} · ${m.ruleId} · ${m.message}`
      map.set(key, (map.get(key) ?? 0) + 1)
    }
  }
  return { map, totals }
}
const base = count(baseFile)
const head = count(headFile)
const added = []
for (const [key, n] of head.map) { const before = base.map.get(key) ?? 0; if (n > before) added.push(`${key} (+${n - before})`) }
const removed = []
for (const [key, n] of base.map) { const after = head.map.get(key) ?? 0; if (n > after) removed.push(`${key} (-${n - after})`) }
console.log(`기준 오류 ${base.totals.errors} · 경고 ${base.totals.warnings} · 파일 ${base.totals.files}`)
console.log(`HEAD 오류 ${head.totals.errors} · 경고 ${head.totals.warnings} · 파일 ${head.totals.files}`)
console.log(`HEAD 에만 있는 항목 ${added.length}`)
for (const line of added) console.log(`+ ${line}`)
console.log(`기준에만 있는 항목 ${removed.length}`)
for (const line of removed) console.log(`- ${line}`)
process.exit(added.length === 0 ? 0 : 1)
