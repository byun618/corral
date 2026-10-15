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

// --- fix3 R3-K (b) -------------------------------------------------------------------------------
test('R3-K 가짜 HOME — backup → 바꿈 · 생김 · 지움 → restore → take 가 backup 전과 같다(exit 0)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-br-'))
  const run = (args) => spawnSync(process.execPath, [path.join(here, 'provider-state.mjs'), ...args], { encoding: 'utf8' })
  try {
    const home = path.join(root, 'home')
    const codex = path.join(home, '.codex', 'config.toml'), claude = path.join(home, '.claude', 'settings.json'), trusted = path.join(home, '.grok', 'trusted_folders.toml')
    fs.mkdirSync(path.dirname(codex), { recursive: true }); fs.writeFileSync(codex, 'model = "x"\n'); fs.chmodSync(codex, 0o640)
    fs.mkdirSync(path.dirname(claude), { recursive: true }); fs.writeFileSync(claude, '{"a":1}')
    const before = take({ home, env: {} })
    const backupDir = path.join(root, 'bk')
    const made = run(['backup', backupDir, '--home', home])
    assert.equal(made.status, 0, made.stdout)
    // 관문 중 provider 가 하는 일 흉내: codex 자기 수정 · grok 신뢰 목록 생성 · claude 설정 삭제
    fs.writeFileSync(codex, 'model = "x"\n[projects."/tmp/l603g-x"]\ntrust_level = "trusted"\n')
    fs.mkdirSync(path.dirname(trusted), { recursive: true }); fs.writeFileSync(trusted, 'paths = ["/tmp/l603g-x"]\n')
    fs.rmSync(claude)
    assert.equal(diff({ a: before, b: take({ home, env: {} }) }).length, 3)
    const back = run(['restore', backupDir, '--home', home])
    assert.equal(back.status, 0, back.stdout)
    assert.deepEqual(diff({ a: before, b: take({ home, env: {} }) }), [])
    assert.equal(fs.statSync(codex).mode & 0o777, 0o640)
    assert.ok(!fs.existsSync(trusted))
    // 비어 있지 않은 dir 에는 backup 하지 않는다
    assert.equal(run(['backup', backupDir, '--home', home]).status, 2)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('R3-K restore 는 먼저 전부 검증한다 — 사본 손상 · 다른 HOME · 목록 조작이면 아무것도 쓰지 않고 exit 2', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-br2-'))
  const run = (args) => spawnSync(process.execPath, [path.join(here, 'provider-state.mjs'), ...args], { encoding: 'utf8' })
  try {
    const home = path.join(root, 'home')
    const codex = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(codex), { recursive: true }); fs.writeFileSync(codex, 'orig\n')
    const backupDir = path.join(root, 'bk')
    assert.equal(run(['backup', backupDir, '--home', home]).status, 0)
    fs.writeFileSync(codex, 'changed\n')
    const manifestFile = path.join(backupDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    const blob = path.join(backupDir, manifest.entries[0].blob)
    fs.writeFileSync(blob, 'tampered\n')
    const corrupt = run(['restore', backupDir, '--home', home])
    assert.equal(corrupt.status, 2)
    assert.equal(JSON.parse(corrupt.stdout).code, 'blob_corrupt')
    assert.equal(fs.readFileSync(codex, 'utf8'), 'changed\n')
    fs.writeFileSync(blob, 'orig\n')
    assert.equal(JSON.parse(run(['restore', backupDir, '--home', path.join(root, 'other')]).stdout).code, 'home_mismatch')
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, entries: [{ ...manifest.entries[0], file: path.join(root, 'elsewhere') }, ...manifest.entries.slice(1)] }))
    assert.equal(JSON.parse(run(['restore', backupDir, '--home', home]).stdout).code, 'file_list_mismatch')
    assert.ok(!fs.existsSync(path.join(root, 'elsewhere')))
    assert.equal(fs.readFileSync(codex, 'utf8'), 'changed\n')
    // 양성 대조: 고친 manifest 로는 되돌아간다
    fs.writeFileSync(manifestFile, JSON.stringify(manifest))
    assert.equal(run(['restore', backupDir, '--home', home]).status, 0)
    assert.equal(fs.readFileSync(codex, 'utf8'), 'orig\n')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
