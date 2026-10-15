// LIFE-603 R1-H ③ 자기점검 — 바꾼 함수는 적대 본문을 그대로 돌려주고(판별력), 바꾸지 않은 함수는 정제한다(양성 대조). 못 찾으면 실패.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { patchBundle } from './unguarded.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '..', '..')
const HOSTILE = 'a\u001b[201~\r!rm\u202e\u{E0041}b'

/** 소스의 실제 정제 함수를 번들처럼 떼어 와 평가한다(번들러 없이 — 의존 함수 invisibleCodePoint 포함). */
function extract(source) {
  const strip = (code) => code.replace(/export /g, '').replace(/: (string|number|boolean)/g, '').replace(/\): (string|boolean) \{/g, ') {')
  const pick = (name) => {
    const start = source.indexOf(`export function ${name}(`)
    assert.ok(start >= 0, name)
    let depth = 0, end = source.indexOf('{', start)
    for (let index = end; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      if (source[index] === '}') { depth -= 1; if (depth === 0) { end = index + 1; break } }
    }
    return strip(source.slice(start, end))
  }
  return `${pick('invisibleCodePoint')}\n${pick('sanitizeDraftBody')}`
}

test('바꾼 판은 항등, 원판은 정제 — 같은 적대 본문으로 결과가 갈린다', () => {
  const code = extract(fs.readFileSync(path.join(app, 'src/shared/terminal-paste.ts'), 'utf8'))
  const original = new Function(`${code}\nreturn sanitizeDraftBody`)()
  const { sites, text } = patchBundle(code)
  assert.equal(sites, 1)
  const unguarded = new Function(`${text}\nreturn sanitizeDraftBody`)()
  assert.notEqual(original(HOSTILE), HOSTILE)
  assert.ok(!original(HOSTILE).includes('\u001b'))
  assert.equal(unguarded(HOSTILE), HOSTILE)
})

test('함수가 없는 글은 0 자리(호출자가 exit 3), DEST 가드는 exit 2', () => {
  assert.equal(patchBundle('function other(x) { return x }').sites, 0)
  for (const bad of ['/tmp/x', '/Users/x/out', '/tmp/l603g-a/../b', '/tmp/l603g-a']) {
    assert.equal(spawnSync(process.execPath, [path.join(here, 'unguarded.mjs'), bad], { cwd: app, encoding: 'utf8' }).status, 2, bad)
  }
})
