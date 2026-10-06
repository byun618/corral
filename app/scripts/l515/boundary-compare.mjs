// LIFE-515 K3ⓕ — 경계 검사(check-boundary.mjs) 출력 두 개(기준·HEAD)를 비교해 HEAD 에만 있는 위반(규칙·파일·토큰)을 낸다. 있으면 종료코드 1.
// 사용: node app/scripts/l515/boundary-compare.mjs <base.txt> <head.txt>   (run.mjs 원자료는 머리 주석 줄을 건너뛴다)
import fs from 'node:fs'
const read = (file) => {
  const text = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.startsWith('#') && !/^exit=/.test(line)).join('\n')
  const start = text.indexOf('\n[')
  const list = JSON.parse(text.slice(start + 1, text.lastIndexOf(']') + 1))
  return new Set(list.flatMap((row) => (row.tokens ?? [row.specifier ?? '']).map((token) => `${row.rule} · ${row.file} · ${token}`)))
}
const [baseFile, headFile] = process.argv.slice(2)
const base = read(baseFile)
const head = read(headFile)
const added = [...head].filter((key) => !base.has(key))
const removed = [...base].filter((key) => !head.has(key))
console.log(`기준 위반 토큰 ${base.size} · HEAD 위반 토큰 ${head.size} · HEAD 에만 있는 것 ${added.length} · 기준에만 있는 것 ${removed.length}`)
for (const key of added) console.log(`+ ${key}`)
for (const key of removed) console.log(`- ${key}`)
process.exit(added.length === 0 ? 0 : 1)
