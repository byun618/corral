#!/usr/bin/env node
// LIFE-603 R1-H ③ (fix2 R2-F) — 가드 없는 사본: 빌드 산출물(out/)을 복사해 **두 자리**를 항등으로 바꾼다(양성 대조용 — 가드가 없으면
// 적대 본문이 정말 새는지 보여야 가드가 막았다는 판정이 선다). 레포의 out/ 은 건드리지 않는다.
//   ① `sanitizeDraftBody` — 제어 문자 · 비가시 문자 제거
//   ② `wrapBracketedPaste` 의 안쪽 ESC → U+241B 치환 — 이것이 남아 있으면 사본에서도 `ESC[201~` 가 틀을 닫지 못해 양성 대조가 안 선다(리뷰 C2-4)
// 대가: 사본에서는 ⌘V 텍스트 · 이미지 드롭의 붙여넣기 틀도 안쪽 ESC 를 그대로 보낸다 — 사본은 관문 회차 전용, 끝나면 지운다.
//
//   app/ 에서(먼저 npm run build): node scripts/l603/unguarded.mjs <DEST=/tmp/l603g-*/unguarded>
//   그다음 L603_APP_DIR=<DEST> sh scripts/l603/up.sh <ROOT>  — 사본 앱으로 격리 기동.
//
// 바꾸는 법: ① 번들마다 `function sanitizeDraftBody(<인자>) {` 바로 뒤에 `return <인자>;` 를 넣는다(본문은 남겨 둔다 — diff 가 한 줄).
//   ② `wrapBracketedPaste` 의 `.split(ESCAPE).join("\u241B")`(또는 글자 그대로 `"␛"`)를 `.split(ESCAPE).join(ESCAPE)` 로.
// 실패 전파: DEST 가 /tmp/l603g-* 밖이면 exit 2 · out/ 이 없으면 exit 2 · 번들(main · runtime) 중 하나라도 **두 자리 중 하나라도** 못 찾으면 exit 3
//   (번들 이름이 바뀌어 조용히 「가드 있는 사본」 이 되는 것을 막는다). 성공은 exit 0 + 바꾼 파일·자리 수 JSON.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'

const PATTERN = /function sanitizeDraftBody\(([A-Za-z_$][\w$]*)\)\s*\{/g
const REQUIRED = ['main/index.js', 'runtime/cli.mjs']

const ESC_SWAP = /\.split\(ESCAPE\)\.join\((?:"\\u241[bB]"|'\\u241[bB]'|"\u241b"|'\u241b')\)/g

/** 번들 글 하나를 바꾼다 — 자리별 수와 결과. `sites` = 정제 함수 자리, `escSites` = 틀의 ESC 치환 자리. */
export function patchBundle(text) {
  let sites = 0, escSites = 0
  const out = text
    .replace(PATTERN, (whole, arg) => { sites += 1; return `${whole} return ${arg}; /* l603 unguarded */` })
    .replace(ESC_SWAP, () => { escSites += 1; return '.split(ESCAPE).join(ESCAPE) /* l603 unguarded */' })
  return { sites, escSites, text: out }
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
    const { sites, escSites, text } = patchBundle(before)
    if (sites === 0 && escSites === 0) continue
    fs.writeFileSync(file, text)
    patched.push({ file: path.relative(path.join(dest, 'out'), file), sites, escSites, sha256: createHash('sha256').update(text).digest('hex').slice(0, 16) })
  }
  const missing = REQUIRED.filter((name) => !patched.some((entry) => entry.file === name && entry.sites > 0 && entry.escSites > 0))
  const report = { ok: missing.length === 0, dest, patched, missing }
  fs.writeFileSync(path.join(dest, 'unguarded.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  return missing.length === 0 ? 0 : 3
}

// 진입 판별은 실경로로(R4-A) — `/tmp`→`/private/tmp` 같은 심볼릭 링크 낀 경로로 부르면 문자열 비교가 거짓이라 main 이 안 돌고 출력 0줄 exit 0 이 됐다.
const invokedDirectly = () => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (invokedDirectly()) process.exit(main(process.argv.slice(2)))
