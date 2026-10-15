#!/usr/bin/env node
// LIFE-603 R1-H ③ — 가드 없는 사본: 빌드 산출물(out/)을 복사해 `sanitizeDraftBody` 를 항등으로 바꾼다(양성 대조용 — 정제가 없으면
// 적대 본문이 정말 새는지 보여야 정제가 막았다는 판정이 선다). 레포의 out/ 은 건드리지 않는다.
//
//   app/ 에서(먼저 npm run build): node scripts/l603/unguarded.mjs <DEST=/tmp/l603g-*/unguarded>
//   그다음 L603_APP_DIR=<DEST> sh scripts/l603/up.sh <ROOT>  — 사본 앱으로 격리 기동.
//
// 바꾸는 법: 번들마다 `function sanitizeDraftBody(<인자>) {` 바로 뒤에 `return <인자>;` 를 넣는다(본문은 남겨 둔다 — diff 가 한 줄).
// 실패 전파: DEST 가 /tmp/l603g-* 밖이면 exit 2 · out/ 이 없으면 exit 2 · 번들(main · runtime) 중 하나라도 그 함수를 못 찾으면 exit 3
//   (번들 이름이 바뀌어 조용히 「가드 있는 사본」 이 되는 것을 막는다). 성공은 exit 0 + 바꾼 파일·자리 수 JSON.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const PATTERN = /function sanitizeDraftBody\(([A-Za-z_$][\w$]*)\)\s*\{/g
const REQUIRED = ['main/index.js', 'runtime/cli.mjs']

/** 번들 글 하나를 바꾼다 — 자리 수와 결과. */
export function patchBundle(text) {
  let sites = 0
  const out = text.replace(PATTERN, (whole, arg) => { sites += 1; return `${whole} return ${arg}; /* l603 unguarded */` })
  return { sites, text: out }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : /\.(m?js|cjs)$/.test(entry.name) ? [full] : []
  })
}

function main([dest]) {
  if (dest === undefined || !/^\/tmp\/l603g-[^/]+\/[^.][^/]*$/.test(dest)) { console.log(JSON.stringify({ ok: false, code: 'bad_dest', want: '/tmp/l603g-*/<name>' })); return 2 }
  const app = process.cwd()
  if (!fs.existsSync(path.join(app, 'out', 'main', 'index.js'))) { console.log(JSON.stringify({ ok: false, code: 'no_build', hint: 'npm run build' })); return 2 }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(path.join(app, 'out'), path.join(dest, 'out'), { recursive: true })
  fs.copyFileSync(path.join(app, 'package.json'), path.join(dest, 'package.json'))
  fs.symlinkSync(path.join(app, 'node_modules'), path.join(dest, 'node_modules'))
  for (const extra of ['resources', 'backend']) if (fs.existsSync(path.join(app, extra))) fs.symlinkSync(path.join(app, extra), path.join(dest, extra))
  const patched = []
  for (const file of walk(path.join(dest, 'out'))) {
    const before = fs.readFileSync(file, 'utf8')
    const { sites, text } = patchBundle(before)
    if (sites === 0) continue
    fs.writeFileSync(file, text)
    patched.push({ file: path.relative(path.join(dest, 'out'), file), sites, sha256: createHash('sha256').update(text).digest('hex').slice(0, 16) })
  }
  const missing = REQUIRED.filter((name) => !patched.some((entry) => entry.file === name))
  const report = { ok: missing.length === 0, dest, patched, missing }
  fs.writeFileSync(path.join(dest, 'unguarded.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  return missing.length === 0 ? 0 : 3
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
