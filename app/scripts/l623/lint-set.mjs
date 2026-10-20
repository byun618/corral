#!/usr/bin/env node
// LIFE-623 C5 — eslint `-f json` 결과를 비교용 집합으로: 줄마다 `상대경로:줄:칸 심각도 규칙`(정렬). 사용: node scripts/l623/lint-set.mjs <json> <앱 루트> > <out>
import fs from 'node:fs'
import path from 'node:path'
const [file, root] = process.argv.slice(2)
const results = JSON.parse(fs.readFileSync(file, 'utf8'))
const lines = []
for (const result of results) for (const message of result.messages) lines.push(`${path.relative(root, result.filePath)}:${message.line ?? 0}:${message.column ?? 0} ${message.severity === 2 ? 'error' : 'warn'} ${message.ruleId ?? 'fatal'}`)
lines.sort()
process.stdout.write(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
console.error(`files ${results.length} · messages ${lines.length} · errors ${lines.filter((line) => line.includes(' error ')).length}`)
