// LIFE-603 fix2 R2-L 자기점검 — 바이트 하나 · 생김 · 사라짐을 다름으로(판별력), 같으면 같음, 그리고 실제 HOME 을 읽기만 해서 두 번 찍으면 같다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { take, diff, watchedFiles } from './provider-state.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('가짜 HOME — 같음 · 바이트 하나 · 생김 · 사라짐', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-home-'))
  try {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n')
    const a = take({ home, env: {} })
    assert.deepEqual(diff({ a, b: take({ home, env: {} }) }), [])
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "y"\n')
    assert.deepEqual(diff({ a, b: take({ home, env: {} }) }).map((row) => row.file), [path.join(home, '.codex', 'config.toml')])
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}')
    assert.equal(diff({ a, b: take({ home, env: {} }) }).length, 2)
    // ~/.claude.json 은 대상이 아니다
    fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":{}}')
    assert.ok(!watchedFiles({ home, env: {} }).some((file) => file.endsWith('.claude.json')))
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('실제 HOME(읽기만) — 연달아 두 번 찍으면 같다(exit 0), 해시만 남고 내용은 없다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-ps-'))
  try {
    const run = (args) => spawnSync(process.execPath, [path.join(here, 'provider-state.mjs'), ...args], { encoding: 'utf8' })
    assert.equal(run(['take', path.join(dir, 'a.json')]).status, 0)
    assert.equal(run(['take', path.join(dir, 'b.json')]).status, 0)
    const same = run(['diff', path.join(dir, 'a.json'), path.join(dir, 'b.json')])
    assert.equal(same.status, 0, same.stdout)
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'))
    for (const entry of Object.values(snap.files)) assert.deepEqual(Object.keys(entry).sort(), entry.state === 'present' ? ['bytes', 'sha256', 'state'] : ['state'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
