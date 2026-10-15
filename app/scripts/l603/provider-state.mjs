#!/usr/bin/env node
// LIFE-603 fix2 R2-L — provider 전역 상태 전후 대조(최종 관문 절차용). 파일 **내용은 읽어 해시만** 남기고 쓰지 않는다.
//
//   node scripts/l603/provider-state.mjs take <out.json> [--home <HOME 대신 — 자기점검용>]
//   node scripts/l603/provider-state.mjs diff <before.json> <after.json>     # 같으면 exit 0, 다르면 exit 1 + 바뀐 파일
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
  console.log(JSON.stringify({ ok: false, code: 'usage', usage: 'take <out> [--home <h>] | diff <a> <b>' }))
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
