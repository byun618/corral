#!/usr/bin/env node
// LIFE-603 R1-H ⑤ — 효과 시작 뒤 취소를 만드는 지연 주입(C7 · R1-B). 격리 런타임에만 쏜다.
//
//   app/ 에서(npm run build 뒤): node scripts/l603/delay-cancel.mjs --socket /tmp/l603g-*/ud/runtime/rpc.sock --repo <레포> --name <이름>
//        [--short-ms 400] [--long-ms 120000] [--request-id <id>] [--extra "--agent claude --prompt-file f --draft"] [--cli <대체 CLI — 자기점검용>]
//
// 1회차: 같은 `--request-id` 로 `worktree create` 를 짧은 `--timeout-ms` 로 부른다 → 호출자 쪽 기한이 효과(worktree 만들기) 도중에 끊는다.
// 2회차: 같은 id 를 긴 기한으로 다시 부른다 → 런타임 영수증이 무엇을 돌려주는지(replay · in_progress · 미확정) 기록한다.
// 분류(`classify`):
//   injected   = 1회차가 request_cancelled · outcome_unknown(효과 시작 뒤 취소가 만들어졌다)
//   too_slow   = 1회차가 그냥 끝났다(지연이 효과보다 길었다 — 주입 실패, exit 3)
//   not_started= 1회차가 효과 전에 거절(경로·인자 문제 — exit 3)
// 실패 전파: 소켓이 /tmp/l603g-* 밖이면 exit 2 · 자식이 예산(긴 기한 + 15초) 안에 안 끝나면 죽이고 exit 4 — 시간 초과를 성공으로 읽지 않는다.
//   성공은 주입이 됐고 2회차 응답을 받은 것(exit 0). 2회차 결과의 좋고 나쁨은 판정표가 정한다(이 장치는 원자료만 남긴다).
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const UNKNOWN = new Set(['request_cancelled', 'outcome_unknown'])

export function classify(first) {
  if (first === null) return 'no_response'
  if (first.ok === true) return 'too_slow'
  const code = first.error?.code ?? null
  if (UNKNOWN.has(code)) return 'injected'
  return first._meta?.outcome === 'unknown' ? 'injected' : 'not_started'
}

function parse(stdout) {
  const line = stdout.trim().split('\n').filter((row) => row.startsWith('{')).pop()
  if (line === undefined) return null
  try { return JSON.parse(line) } catch { return null }
}

function call({ cli, socket, args, timeoutMs, budgetMs }) {
  const started = Date.now()
  const child = spawnSync(process.execPath, [cli, '--socket', socket, ...args, '--timeout-ms', String(timeoutMs), '--json'], { encoding: 'utf8', timeout: budgetMs, killSignal: 'SIGKILL' })
  return { elapsedMs: Date.now() - started, status: child.status, signal: child.signal, timedOut: child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGKILL', response: parse(child.stdout ?? ''), stderr: (child.stderr ?? '').slice(0, 2000) }
}

function main(argv) {
  const flag = (name, fallback) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : fallback }
  const socket = flag('socket')
  if (socket === undefined || !/^\/tmp\/l603g-[^/.]+\/ud\/runtime\/rpc\.sock$/.test(socket)) { console.log(JSON.stringify({ ok: false, code: 'bad_socket', want: '/tmp/l603g-*/ud/runtime/rpc.sock' })); return 2 }
  const repo = flag('repo'), name = flag('name')
  if (repo === undefined || name === undefined) { console.log(JSON.stringify({ ok: false, code: 'usage' })); return 2 }
  const cli = path.resolve(flag('cli', 'out/runtime/cli.mjs'))
  const shortMs = Number(flag('short-ms', '400')), longMs = Number(flag('long-ms', '120000'))
  const requestId = flag('request-id', `l603-delay-${randomUUID()}`)
  const extra = (flag('extra', '') ?? '').split(' ').filter((part) => part.length > 0)
  const args = ['worktree', 'create', '--repo', repo, '--name', name, '--request-id', requestId, ...extra]
  const budget = longMs + 15_000
  const first = call({ cli, socket, args, timeoutMs: shortMs, budgetMs: budget })
  if (first.timedOut) { console.log(JSON.stringify({ ok: false, code: 'child_timeout', round: 1, first })); return 4 }
  const kind = classify(first.response)
  if (kind !== 'injected') { console.log(JSON.stringify({ ok: false, code: kind, requestId, first })); return 3 }
  const second = call({ cli, socket, args, timeoutMs: longMs, budgetMs: budget })
  if (second.timedOut) { console.log(JSON.stringify({ ok: false, code: 'child_timeout', round: 2, requestId, first, second })); return 4 }
  console.log(JSON.stringify({ ok: second.response !== null, kind, requestId, first, second }))
  return second.response === null ? 4 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
