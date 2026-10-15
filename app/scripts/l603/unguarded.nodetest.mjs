// LIFE-603 R1-H ③ 자기점검(fix2 R2-F) — 같은 적대 본문으로: 원판 페이로드는 ESC 가 틀의 2개뿐(끼어든 ESC[201~ 가 틀을 못 닫음),
// 사본 페이로드는 끼어든 ESC[201~ 가 살아 틀이 일찍 닫히고 그 뒤에 `rm` 꼬리가 틀 밖으로 나간다(판별력).
// 소스에서 뗀 함수(번들러 없이)와 **실제 빌드 산출물(out/runtime/cli.mjs)** 을 바꾼 사본 둘 다에서 본다. 못 찾으면 실패.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { patchBundle } from './unguarded.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '..', '..')
const HOSTILE = '첫 줄\u001b[201~\r!rm -rf ~\u0003‮\u{E0041}끝'
const END = '\u001b[201~'

/** 글에서 함수 하나를 중괄호 짝으로 떼어 온다(TS 면 타입 표기를 걷는다). */
function pick({ source, name }) {
  const start = source.search(new RegExp(`(export )?function ${name}\\(`))
  assert.ok(start >= 0, name)
  let depth = 0, end = source.indexOf('{', start)
  for (let index = end; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') { depth -= 1; if (depth === 0) { end = index + 1; break } }
  }
  return source.slice(start, end).replace(/^export /, '').replace(/: (string|number|boolean)/g, '').replace(/\): (string|boolean) \{/, ') {')
}
const NAMES = ['invisibleCodePoint', 'sanitizeDraftBody', 'wrapBracketedPaste']
const extract = (source) => NAMES.map((name) => pick({ source, name })).join('\n')
function payloadFrom(code) {
  return new Function(`const ESCAPE = '\\u001b'; const BRACKETED_PASTE_START = ESCAPE + '[200~'; const BRACKETED_PASTE_END = ESCAPE + '[201~';\n${code}\nreturn (text) => wrapBracketedPaste(sanitizeDraftBody(text))`)()
}
const payloadOf = (source) => payloadFrom(extract(source))
/** 틀이 처음 닫히는 자리 뒤에 남는 글 — 원판은 '', 사본은 「!rm …」 꼬리. */
const tailAfterFirstEnd = (payload) => payload.slice(payload.indexOf(END) + END.length)
const escCount = (payload) => payload.split('\u001b').length - 1

test('소스 함수 — 원판은 ESC 2 · 첫 닫힘 뒤 0바이트, 사본(두 자리 항등)은 끼어든 닫힘 뒤로 rm 꼬리가 샌다', () => {
  const code = extract(fs.readFileSync(path.join(app, 'src/shared/terminal-paste.ts'), 'utf8'))
  const original = payloadFrom(code)(HOSTILE)
  assert.equal(escCount(original), 2)
  assert.equal(tailAfterFirstEnd(original), '')
  const { sites, escSites, text } = patchBundle(code)
  assert.deepEqual({ sites, escSites }, { sites: 1, escSites: 1 })
  const leaked = payloadFrom(text)(HOSTILE)
  assert.ok(escCount(leaked) > 2)
  assert.ok(tailAfterFirstEnd(leaked).startsWith('\r!rm -rf ~\u0003'))
  // 한 자리만 바꾸면(정제만 항등) 리뷰 C2-4 그대로 — ESC 치환이 남아 안 샌다(이 장치가 두 자리를 다 바꾸는 이유).
  const sanitizeOnly = payloadFrom(code.replace(/function sanitizeDraftBody\((\w+)\)\s*\{/, (whole, arg) => `${whole} return ${arg};`))(HOSTILE)
  assert.ok(sanitizeOnly.includes('!rm'))
  assert.equal(tailAfterFirstEnd(sanitizeOnly), '')
})

test('실제 빌드 산출물 — unguarded.mjs 가 main · runtime 번들의 두 자리를 바꾸고, 바꾼 cli.mjs 의 함수가 실제로 샌다', { skip: !fs.existsSync(path.join(app, 'out/runtime/cli.mjs')) && 'npm run build 먼저' }, () => {
  const root = `/tmp/l603g-ug${process.pid}`
  try {
    const run = spawnSync(process.execPath, [path.join(here, 'unguarded.mjs'), `${root}/copy`], { cwd: app, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stdout)
    const report = JSON.parse(run.stdout)
    for (const name of ['main/index.js', 'runtime/cli.mjs']) {
      const entry = report.patched.find((row) => row.file === name)
      assert.ok(entry !== undefined && entry.sites >= 1 && entry.escSites >= 1, name)
    }
    const patched = fs.readFileSync(`${root}/copy/out/runtime/cli.mjs`, 'utf8')
    assert.match(tailAfterFirstEnd(payloadOf(patched)(HOSTILE)), /^\r!rm/)
    const pristine = fs.readFileSync(path.join(app, 'out/runtime/cli.mjs'), 'utf8')
    assert.equal(tailAfterFirstEnd(payloadOf(pristine)(HOSTILE)), '')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('함수가 없는 글은 0 자리(호출자가 exit 3), DEST 가드는 exit 2', () => {
  assert.deepEqual({ ...patchBundle('function other(x) { return x }'), text: undefined }, { sites: 0, escSites: 0, text: undefined })
  for (const bad of ['/tmp/x', '/Users/x/out', '/tmp/l603g-a/../b', '/tmp/l603g-a']) {
    assert.equal(spawnSync(process.execPath, [path.join(here, 'unguarded.mjs'), bad], { cwd: app, encoding: 'utf8' }).status, 2, bad)
  }
})
