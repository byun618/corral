// LIFE-603 R4-A 자기점검 — 장치 다섯을 심볼릭 링크 낀 경로로 불러도 main 이 돈다(출력 있음 · 잘못된 인자면 exit ≠ 0).
// 고침 전: `import.meta.url === file://${argv[1]}` 문자열 비교라 `/tmp`(→ `/private/tmp`) 경로로 부르면 출력 0줄 exit 0(fail-open, f3-i12).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEVICES = ['user-turns.mjs', 'snapshot.mjs', 'delay-cancel.mjs', 'provider-state.mjs', 'unguarded.mjs']

function check(dir) {
  for (const name of DEVICES) {
    const run = spawnSync(process.execPath, [path.join(dir, name)], { encoding: 'utf8', cwd: dir, timeout: 30_000 })
    assert.notEqual(run.stdout.trim(), '', `${name} @ ${dir} — 출력 0줄`)
    assert.notEqual(run.status, 0, `${name} @ ${dir} — 인자 없이 exit 0`)
  }
}

test('R4-A 링크 낀 경로 — 명시 심볼릭 링크 디렉터리 · macOS /tmp(→ /private/tmp) 둘 다 main 이 돈다', () => {
  const real = fs.mkdtempSync('/tmp/l603-entry-real-')
  const link = `${real}-link`
  try {
    for (const name of DEVICES) fs.copyFileSync(path.join(here, name), path.join(real, name))
    fs.symlinkSync(real, link)
    check(link) // 명시 링크
    check(real) // `/tmp` 경로 — macOS 에선 그 자체가 링크(실경로 /private/tmp)
    check(here) // 대조: 레포 경로
  } finally {
    fs.rmSync(link, { force: true })
    fs.rmSync(real, { recursive: true, force: true })
  }
})
