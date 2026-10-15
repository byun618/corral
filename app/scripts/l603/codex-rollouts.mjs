// LIFE-603 C3 재관문 — codex ① 판독 장치. codex 는 제출 전에 rollout 파일을 만들지 않아(최종 관문 g42) `user-turns before` 가 읽을 경로가 없다.
// 그래서 기록 루트 **전체**를 훑어 session_meta 의 cwd 가 그 worktree 인 rollout 을 모두 찾는다 — 제출 전에는 0 개, Enter 뒤에는 정확히 1 개 · 사용자 턴 1 이어야 한다.
//
//   node scripts/l603/codex-rollouts.mjs --root <~/.codex/sessions> --cwd <worktree 실경로>
//
// 출력 JSON 한 줄: scanned(읽은 rollout 수) · matches[{ file, sessionId, metaTimestamp, birthtime, userTurns, turnSha }].
// 판독 대상이 보이는지(양성 대조): scanned 0 이면 루트를 못 본 것이라 exit 3 — 「0 개」 와 「못 봄」 을 섞지 않는다. 루트를 못 읽으면 exit 2. 그 밖 exit 0.
// 턴 셈은 user-turns.mjs 의 countUserTurns(codex 규칙) 그대로다.
import fs from 'node:fs'
import path from 'node:path'
import { countUserTurns } from './user-turns.mjs'

const argv = process.argv.slice(2)
const flag = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined }
const root = flag('root'), cwd = flag('cwd')
if (!root || !cwd) { console.log(JSON.stringify({ ok: false, code: 'usage', usage: '--root <dir> --cwd <path>' })); process.exit(2) }

const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(full)
  }
}
try { walk(root) } catch (error) { console.log(JSON.stringify({ ok: false, code: 'root_unreadable', error: String(error) })); process.exit(2) }

const matches = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  let meta = null
  try { meta = JSON.parse(text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length)) } catch { continue }
  if (meta?.type !== 'session_meta' || meta.payload?.cwd !== cwd) continue
  const counted = countUserTurns({ kind: 'codex', text })
  matches.push({ file, sessionId: meta.payload.id ?? null, metaTimestamp: meta.payload.timestamp ?? null, birthtime: fs.statSync(file).birthtime.toISOString(), userTurns: counted.ok ? counted.userTurns : null, turnSha: counted.ok ? counted.turnSha : null })
}
console.log(JSON.stringify({ ok: files.length > 0, scanned: files.length, cwd, matches }))
process.exit(files.length > 0 ? 0 : 3)
