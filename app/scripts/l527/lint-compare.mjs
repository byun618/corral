// LIFE-527 K8ⓒ — eslint json 출력 전(작업 브랜치 빌드)·후 비교: 오류 수·경고 수·새 오류 키(파일|규칙|메시지).
// 실행: node lint-compare.mjs <후.json> <전.json>
import fs from 'node:fs'
const [after, before] = process.argv.slice(2)
const read = (file) => {
  const keys = new Set(); let errors = 0, warnings = 0
  for (const result of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const rel = result.filePath.replace(/.*\/app\//, '')
    for (const message of result.messages) {
      if (message.severity === 2) { errors += 1; keys.add(`${rel}|${message.ruleId}|${message.message}`) } else warnings += 1
    }
  }
  return { errors, warnings, keys }
}
const a = read(after), b = read(before)
console.log('errors before', b.errors, 'after', a.errors, '| warnings before', b.warnings, 'after', a.warnings)
const fresh = [...a.keys].filter((key) => !b.keys.has(key))
console.log('new error keys', fresh.length)
for (const key of fresh) console.log(key)
