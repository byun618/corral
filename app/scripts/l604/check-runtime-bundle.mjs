#!/usr/bin/env node
// LIFE-604 R2-D — C11 「작업 코드는 runtime(CLI·serve) 번들에 들어가지 않는다」 를 build 산출물에서 센다.
//   node scripts/l604/check-runtime-bundle.mjs [--extra <파일>]   (app/ 에서, `npm run build` 뒤)
// out/runtime/ 아래 모든 .mjs·.js(소스맵 제외)에서 작업 코드 표지 createItem · getCreateMeta · WorkService · quick-create 를 센다 → 합 0 이어야 exit 0.
// 읽은 번들 0 개면 exit 2(관측 없음 — build 전). `--extra` = 양성 대조: 표지가 든 파일을 함께 세면 ≥1 이라 exit 1 이어야 한다.
// 같은 표지가 out/main 에는 있어야 한다(표지 이름이 바뀌어 runtime 이 늘 0 으로 나오는 것을 막는 대조) — main 합 0 이면 exit 2.
import fs from 'node:fs'
import path from 'node:path'

const MARKERS = ['createItem', 'getCreateMeta', 'WorkService', 'quick-create']
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
