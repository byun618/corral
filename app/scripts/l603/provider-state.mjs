#!/usr/bin/env node
// LIFE-603 fix2 R2-L — provider 전역 상태 전후 대조(최종 관문 절차용). take · diff 는 파일 **내용은 읽어 해시만** 남기고 쓰지 않는다.
//
//   node scripts/l603/provider-state.mjs take <out.json> [--home <HOME 대신 — 자기점검용>]
//   node scripts/l603/provider-state.mjs diff <before.json> <after.json>     # 같으면 exit 0, 다르면 exit 1 + 바뀐 파일
//   node scripts/l603/provider-state.mjs backup <dir> [--home <h>]          # (R3-K) 허용 목록 5파일 바이트 사본 + manifest.json. dir 은 없거나 비어 있어야 한다
//   node scripts/l603/provider-state.mjs restore <dir> [--home <h>]         # 사본으로 되돌린다(없던 파일은 지운다) → 다시 읽어 해시 대조, 모두 같으면 exit 0
//   사본은 사용자 데이터다 — 레포 밖(/tmp 등)에 두고 커밋하지 않는다(validation.md 원자료 보관). 경로 · 해시만 기록한다.
//
// 대조 대상(허용 목록 — provider 가 사람 설정으로 읽는 파일):
//   ~/.codex/config.toml · ~/.claude/settings.json · ~/.claude/settings.local.json · ~/.grok/config.toml · ~/.grok/trusted_folders.toml
//   (CODEX_HOME · CLAUDE_CONFIG_DIR · GROK_HOME 가 있으면 그 아래)
// 빼는 것과 이유:
//   ~/.claude.json — Claude Code 세션이 스스로 쓴다(프로젝트 목록 · 카운터; 다른 활성 세션도 동시에 쓴다). 관문과 무관한 변경이 늘 생겨 해시 대조가 판별력이 없다
//     (메모리 「~/.claude.json 은 해시 관문에 넣지 않는다」, LIFE-561 C9 보류 원인). 리뷰 r2 의 격리 claude 기동도 projects 항목을 남겼다.
//   ~/.grok 의 active_sessions · tip_cursor · slash-mru · *_cache · version — grok 이 실행마다 쓰는 상태.
//   auth.json 류 — 비밀값. 해시라도 남기지 않는다.
// 주의: codex 는 실행 중 config.toml 을 스스로 고친다(nux 카운터 · exec 신뢰 줄 — 메모리 「codex 는 자기 config 를 고친다」).
//   그래서 이 대조의 「다름」 은 곧 실패가 아니라 **원복 대상 표시**다 — 관문은 백업 바이트로 되돌린 뒤 다시 take 해 「같음」 을 확인한다.
// 실패 전파: 읽을 수 없는 파일(권한)은 `unreadable` 로 적고 exit 2 — 「없음」 과 섞지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function watchedFiles({ home, env = process.env }) {
  const codex = env.CODEX_HOME ?? path.join(home, '.codex')
  const claude = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')
  const grok = env.GROK_HOME ?? path.join(home, '.grok')
  return [path.join(codex, 'config.toml'), path.join(claude, 'settings.json'), path.join(claude, 'settings.local.json'), path.join(grok, 'config.toml'), path.join(grok, 'trusted_folders.toml')]
}

export function take({ home, env }) {
  const files = {}
  let unreadable = 0
  for (const file of watchedFiles({ home, env })) {
    if (!fs.existsSync(file)) { files[file] = { state: 'absent' }; continue }
    try {
      const bytes = fs.readFileSync(file)
      files[file] = { state: 'present', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch (error) {
      unreadable += 1
      files[file] = { state: 'unreadable', error: String(error) }
    }
  }
  return { at: new Date().toISOString(), excluded: ['~/.claude.json (Claude Code 가 스스로 씀)', '~/.grok 실행 상태 · 캐시', 'auth 류(비밀값)'], files, unreadable }
}

export function diff({ a, b }) {
  const names = [...new Set([...Object.keys(a.files ?? {}), ...Object.keys(b.files ?? {})])].sort()
  return names.flatMap((name) => (JSON.stringify(a.files?.[name] ?? null) === JSON.stringify(b.files?.[name] ?? null) ? [] : [{ file: name, before: a.files?.[name] ?? null, after: b.files?.[name] ?? null }]))
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** 허용 목록 5파일의 바이트 사본(R3-K). 실패하면 아무것도 남기지 않는다(만든 dir 은 지운다). */
export function backup({ dir, home, env }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return { ok: false, code: 'backup_dir_not_empty', exit: 2, dir }
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true, mode: 0o700 })
  const entries = []
  try {
    watchedFiles({ home, env }).forEach((file, index) => {
      if (!fs.existsSync(file)) { entries.push({ file, state: 'absent' }); return }
      const bytes = fs.readFileSync(file)
      const blob = `blobs/${index}.bin`
      fs.writeFileSync(path.join(dir, blob), bytes, { mode: 0o600 })
      entries.push({ file, state: 'present', bytes: bytes.length, sha256: sha(bytes), mode: fs.statSync(file).mode & 0o777, blob })
    })
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: false, code: 'unreadable', exit: 2, error: String(error) }
  }
  const manifest = { version: 1, at: new Date().toISOString(), home, entries }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  return { ok: true, dir, entries: entries.map(({ file, state, sha256 }) => ({ file, state, sha256: sha256 ?? null })) }
}

/**
 * 사본으로 되돌린다(R3-K). 먼저 전부 검증하고(같은 HOME · 같은 허용 목록 · 사본 해시) 하나라도 어긋나면 **아무것도 쓰지 않고** exit 2.
 * 있던 파일은 사본 바이트 · 권한으로(임시 파일 → rename), 없던 파일은 지운다. 끝나면 다시 읽어 해시를 대조한다 — 하나라도 다르면 exit 1.
 */
export function restore({ dir, home, env }) {
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch (error) { return { ok: false, code: 'manifest_unreadable', exit: 2, error: String(error) } }
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) return { ok: false, code: 'manifest_bad', exit: 2 }
  if (manifest.home !== home) return { ok: false, code: 'home_mismatch', exit: 2, manifest: manifest.home, home }
  const expected = watchedFiles({ home, env })
  if (JSON.stringify(manifest.entries.map((entry) => entry.file)) !== JSON.stringify(expected)) return { ok: false, code: 'file_list_mismatch', exit: 2 }
  const plan = []
  for (const entry of manifest.entries) {
    if (entry.state === 'absent') { plan.push({ file: entry.file, bytes: null, mode: null, sha256: null }); continue }
    let bytes
    try { bytes = fs.readFileSync(path.join(dir, entry.blob)) } catch (error) { return { ok: false, code: 'blob_unreadable', exit: 2, file: entry.file, error: String(error) } }
    if (sha(bytes) !== entry.sha256) return { ok: false, code: 'blob_corrupt', exit: 2, file: entry.file }
    plan.push({ file: entry.file, bytes, mode: entry.mode, sha256: entry.sha256 })
  }
  for (const step of plan) {
    if (step.bytes === null) { fs.rmSync(step.file, { force: true }); continue }
    fs.mkdirSync(path.dirname(step.file), { recursive: true })
    const tmp = `${step.file}.l603-restore.${process.pid}.tmp`
    fs.writeFileSync(tmp, step.bytes, { mode: step.mode ?? 0o600 })
    fs.chmodSync(tmp, step.mode ?? 0o600)
    fs.renameSync(tmp, step.file)
  }
  const now = take({ home, env })
  const mismatched = plan.flatMap((step) => {
    const seen = now.files[step.file]
    const same = step.bytes === null ? seen?.state === 'absent' : seen?.state === 'present' && seen.sha256 === step.sha256
    return same ? [] : [{ file: step.file, want: step.sha256 ?? 'absent', got: seen?.sha256 ?? seen?.state ?? null }]
  })
  return mismatched.length === 0 ? { ok: true, restored: plan.length } : { ok: false, code: 'hash_mismatch_after_restore', exit: 1, mismatched }
}

function main(argv) {
  const flag = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined }
  const [mode, first, second] = argv
  if (mode === 'take' && first !== undefined) {
    const snapshot = take({ home: flag('home') ?? os.homedir(), env: flag('home') === undefined ? process.env : {} })
    fs.writeFileSync(first, JSON.stringify(snapshot, null, 2) + '\n')
    console.log(JSON.stringify({ ok: snapshot.unreadable === 0, out: first, files: Object.keys(snapshot.files).length, unreadable: snapshot.unreadable }))
    return snapshot.unreadable === 0 ? 0 : 2
  }
  if (mode === 'diff' && first !== undefined && second !== undefined) {
    let a, b
    try { a = JSON.parse(fs.readFileSync(first, 'utf8')); b = JSON.parse(fs.readFileSync(second, 'utf8')) } catch (error) { console.log(JSON.stringify({ ok: false, code: 'unreadable_snapshot', error: String(error) })); return 2 }
    const changes = diff({ a, b })
    console.log(JSON.stringify({ ok: true, same: changes.length === 0, changes }))
    return changes.length === 0 ? 0 : 1
  }
  if ((mode === 'backup' || mode === 'restore') && first !== undefined) {
    const home = flag('home') ?? os.homedir(), env = flag('home') === undefined ? process.env : {}
    const result = mode === 'backup' ? backup({ dir: path.resolve(first), home, env }) : restore({ dir: path.resolve(first), home, env })
    console.log(JSON.stringify(result))
    return result.ok ? 0 : result.exit
  }
  console.log(JSON.stringify({ ok: false, code: 'usage', usage: 'take <out> [--home <h>] | diff <a> <b> | backup <dir> [--home <h>] | restore <dir> [--home <h>]' }))
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
