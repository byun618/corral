#!/usr/bin/env node
// LIFE-605 — 「작업 코드는 runtime(CLI·serve) 번들에 넣지 않는다」 를 build 산출물에서 센다(LIFE-604 check-runtime-bundle 본뜸).
//   node scripts/l605/check-runtime-bundle.mjs [--extra <파일>]   (app/ 에서, `npm run build` 뒤)
// out/runtime/ 아래 .mjs·.cjs·.js 에서 Jira 출처 표지를 센다 → 합 0 이어야 exit 0. 읽은 번들 0 이면 exit 2(build 전).
// 같은 표지가 out/main 에는 있어야 한다(표지가 바뀌어 늘 0 이 되는 것을 막는 대조) — main 합 0 이면 exit 2. `--extra` = 양성 대조(≥1 → exit 1).
import fs from 'node:fs'
import path from 'node:path'

const MARKERS = ['/rest/api/3/search/jql', 'atlassian.net', 'X-Seraph-LoginReason', 'corralWriteId']
const app = path.resolve(import.meta.dirname, '../..')
const extraAt = process.argv.indexOf('--extra')
const extra = extraAt === -1 ? null : process.argv[extraAt + 1] ?? null
const bundles = (dir) => {
  if (!fs.existsSync(dir)) return []
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) found.push(path.join(entry.parentPath, entry.name))
  }
  return found
}
const count = (files) => {
  const perMarker = Object.fromEntries(MARKERS.map((marker) => [marker, 0]))
  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8')
    for (const marker of MARKERS) perMarker[marker] += body.split(marker).length - 1
  }
  return { files: files.map((file) => path.relative(app, file)), perMarker, total: Object.values(perMarker).reduce((sum, value) => sum + value, 0) }
}
const runtime = count([...bundles(path.join(app, 'out/runtime')), ...(extra === null ? [] : [path.resolve(extra)])])
const main = count(bundles(path.join(app, 'out/main')))
const exit = runtime.files.length === 0 || main.total === 0 ? 2 : runtime.total === 0 ? 0 : 1
console.log(JSON.stringify({ runtime, mainControl: { files: main.files.length, perMarker: main.perMarker, total: main.total }, exit }))
process.exit(exit)
