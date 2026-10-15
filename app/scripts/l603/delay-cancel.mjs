#!/usr/bin/env node
// LIFE-603 R1-H ⑤ (fix2 R2-D) — 효과 시작 뒤 취소를 만드는 지연 주입(C7 · R1-B). 격리 런타임에만 쏜다.
//
//   app/ 에서(npm run build 뒤): node scripts/l603/delay-cancel.mjs --socket /tmp/l603g-*/ud/runtime/rpc.sock --repo <레포> --name <이름>
//        [--short-ms 400] [--long-ms 120000] [--settle-ms 1500] [--request-id r1.<13자리 ms>.<UUID>]
//        [--extra '["--agent","claude","--prompt-file","/tmp/x.txt","--draft"]']   # JSON 배열 — 따옴표·공백 든 인자를 그대로 넘긴다
//        [--cli <대체 CLI — 자기점검용>]
//
// 진입점 = 실제 `cli/corral.mjs`(기본). 소켓은 **환경변수 `CORRAL_RUNTIME_SOCKET`** 으로 넘긴다 — workspace 명령은 `--socket` 플래그를 받지 않는다.
// 기본 `--request-id` 는 런타임 형식 `r1.<Date.now()>.<UUID>`(다른 모양은 효과 전에 invalid_argument).
// 1회차: 같은 id 로 `worktree create` 를 짧은 `--timeout-ms` 로 → 호출자 기한이 끊는다. settle-ms 기다린 뒤 예정 경로(`<repo>/.claude/worktrees/<name>`)의 `.git` 을 본다.
// 2회차: 같은 id 를 긴 기한으로 다시 → 런타임 영수증이 돌려주는 것을 원자료로 남긴다.
// 분류(`classify`) — **효과 시작 여부**로 가른다(R2-D):
//   after_effect  = 취소·미확정 코드이고, **런타임이 답한** `_meta.outcome: unknown` 이거나 예정 경로에 worktree 가 생겼다 → R1-B 실측으로 센다(exit 0)
//                   (CLI 자기 기한의 응답은 `runtimeId: 'unknown'` — 그 outcome 은 증거로 쓰지 않는다)
//   before_effect = 취소 코드인데 outcome `not_started` 이고 경로도 없다(줄에서 끊김 — 효과 0) → R1-B 가 아니다(exit 3)
//   too_slow      = 1회차가 그냥 끝났다(지연이 효과보다 길었다, exit 3) · not_started = 다른 거절(인자 · 경로, exit 3) · no_response(exit 3)
// 실패 전파: 소켓이 /tmp/l603g-* 밖이면 exit 2 · 자식이 예산(긴 기한 + 15초) 안에 안 끝나면 죽이고 exit 4 — 시간 초과를 성공으로 읽지 않는다.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const CANCEL = new Set(['request_cancelled', 'outcome_unknown'])
export const REQUEST_ID = /^r1\.\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function classify({ first, worktreeAppeared }) {
  if (first === null) return 'no_response'
  if (first.ok === true) return 'too_slow'
  const code = first.error?.code ?? null
  // `_meta.outcome` 은 **런타임이 답했을 때만** 효과의 증거다. CLI 가 자기 기한으로 끊은 응답(`runtimeId: 'unknown'`)의 `unknown` 은
  // 「모른다」 일 뿐이다 — 격리 실측(f2-iso-delay-30)에서 그 응답 뒤 경로는 안 생겼고 2회차는 새 실행이었다.
  const fromRuntime = typeof first._meta?.runtimeId === 'string' && first._meta.runtimeId !== 'unknown'
  const outcome = fromRuntime ? first._meta?.outcome ?? null : null
  if (!CANCEL.has(code) && outcome !== 'unknown') return 'not_started'
  return outcome === 'unknown' || worktreeAppeared ? 'after_effect' : 'before_effect'
}

export function parseExtra(text) {
  if (text === undefined || text === '') return []
  const value = JSON.parse(text)
  if (!Array.isArray(value) || !value.every((part) => typeof part === 'string')) throw new Error('--extra 는 문자열 JSON 배열')
  return value
}

function parse(stdout) {
  const line = stdout.trim().split('\n').filter((row) => row.startsWith('{')).pop()
  if (line === undefined) return null
  try { return JSON.parse(line) } catch { return null }
}

function call({ cli, socket, args, timeoutMs, budgetMs }) {
  const started = Date.now()
  const child = spawnSync(process.execPath, [cli, ...args, '--timeout-ms', String(timeoutMs), '--json'], { encoding: 'utf8', timeout: budgetMs, killSignal: 'SIGKILL', env: { ...process.env, CORRAL_RUNTIME_SOCKET: socket } })
  return { elapsedMs: Date.now() - started, status: child.status, signal: child.signal, timedOut: child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGKILL', response: parse(child.stdout ?? ''), stderr: (child.stderr ?? '').slice(0, 2000) }
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function main(argv) {
  const flag = (name, fallback) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : fallback }
  const socket = flag('socket')
  if (socket === undefined || !/^\/tmp\/l603g-[^/.]+\/ud\/runtime\/rpc\.sock$/.test(socket)) { console.log(JSON.stringify({ ok: false, code: 'bad_socket', want: '/tmp/l603g-*/ud/runtime/rpc.sock' })); return 2 }
  const repo = flag('repo'), name = flag('name')
  if (repo === undefined || name === undefined) { console.log(JSON.stringify({ ok: false, code: 'usage' })); return 2 }
  const requestId = flag('request-id', `r1.${Date.now()}.${randomUUID()}`)
  if (!REQUEST_ID.test(requestId)) { console.log(JSON.stringify({ ok: false, code: 'bad_request_id', want: 'r1.<13자리 ms>.<UUID>' })); return 2 }
  let extra
  try { extra = parseExtra(flag('extra', '')) } catch (error) { console.log(JSON.stringify({ ok: false, code: 'bad_extra', error: String(error) })); return 2 }
  const cli = path.resolve(flag('cli', 'cli/corral.mjs'))
  const shortMs = Number(flag('short-ms', '400')), longMs = Number(flag('long-ms', '120000')), settleMs = Number(flag('settle-ms', '1500'))
  const expected = `${repo.replace(/\/+$/, '')}/.claude/worktrees/${name}`
  const args = ['worktree', 'create', '--repo', repo, '--name', name, '--request-id', requestId, ...extra]
  const budget = longMs + 15_000
  const existedBefore = fs.existsSync(path.join(expected, '.git'))
  if (existedBefore) { console.log(JSON.stringify({ ok: false, code: 'path_preexisting', expected })); return 3 }
  const first = call({ cli, socket, args, timeoutMs: shortMs, budgetMs: budget })
  if (first.timedOut) { console.log(JSON.stringify({ ok: false, code: 'child_timeout', round: 1, first })); return 4 }
  sleep(settleMs)
  const worktreeAppeared = fs.existsSync(path.join(expected, '.git'))
  const kind = classify({ first: first.response, worktreeAppeared })
  if (kind !== 'after_effect') { console.log(JSON.stringify({ ok: false, code: kind, requestId, expected, worktreeAppeared, first })); return 3 }
  const second = call({ cli, socket, args, timeoutMs: longMs, budgetMs: budget })
  if (second.timedOut) { console.log(JSON.stringify({ ok: false, code: 'child_timeout', round: 2, requestId, first, second })); return 4 }
  // 2회차가 새 실행이었나(replay 아님 · 미확정 아님) — 그렇다면 1회차는 효과가 없었다는 반증이다. 판정표가 읽는 칸.
  const secondFresh = second.response?.ok === true && second.response?.result?.replayed !== true
  console.log(JSON.stringify({ ok: second.response !== null, kind, requestId, expected, worktreeAppeared, worktreeAfter: fs.existsSync(path.join(expected, '.git')), secondFresh, first, second }))
  return second.response === null ? 4 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
