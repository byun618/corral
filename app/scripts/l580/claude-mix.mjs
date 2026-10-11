// LIFE-580 최종 관문 L3 보강 — 질문 대기·권한 대기 전이를 **격리 인스턴스 안의 실제 claude pane** 으로 만들어 3초 반영을 잰다.
// herdr `pane report-agent` 에는 blocked 사유(질문·권한) 옵션이 없다(`--state idle|working|blocked|unknown` 뿐 — 최종 관문 f02 확인).
// 그래서 three-sec.mjs(보고 전이) 에 이 회차를 섞는다.
//
// 회차(라운드)마다 claude 에게 짧은 지시를 보내 권한 대기(Bash `touch`) 또는 질문 대기(AskUserQuestion)를 일으키고, 세 전이를 잰다:
//   ① 지시 Enter            → 대상 점 working                 원인 = Enter 를 보내기 직전
//   ② 대기 화면이 보임       → waiting + approval|question      원인 = herdr `wait-output` 이 화면에서 대화상자를 찾은 시각(폴링이라 실제보다 늦다 — ⓑ 를 짧게 잴 수 있다. ⓐ 는 영향 없음)
//   ③ 답 키(권한 `1` · 질문 Enter) → working(대기 아님)          원인 = 키를 보내기 직전
// 그 뒤 claude 가 한가해질 때까지 기다린다(전이로 세지 않음). 짝 = 원인 뒤 받은 목록 중 대상이 기대 상태로 **바뀐** 첫 목록(직전 목록의 대상 상태는 기대가 아니어야 한다).
// ⓐ = 폰 수신 − (changedAt − 시계차) · ⓑ = 폰 수신 − 원인. 통과: 전이 전부 ⓐ·ⓑ ≤ 3000 ms, 놓침 0.
//
// 사용(app/): node scripts/l580/claude-mix.mjs --root /tmp/l580g-x --fake /tmp/l580g-fx --pane w1:p1 --herdr-bin <격리 guard> --out <폴더> [--rounds approval,question,approval,question]
//   전제: --pane 에 claude 가 떠 있고(수동 권한 모드) 한가하다. 원자료에 제목·토큰을 남기지 않는다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoots, herdrSession, phone, sleep, until, writeJson } from './lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, pane: { type: 'string' }, 'herdr-bin': { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: 'approval,question,approval,question' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (!args.pane || !args.out || !args['herdr-bin'] || !fs.existsSync(args['herdr-bin'])) throw new Error('--pane · --out · --herdr-bin 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const PANE = args.pane
const OUT = path.resolve(args.out)
const LIMIT_MS = 3_000
const ROUNDS = args.rounds.split(',')
const socket = path.join(os.homedir(), '.config/herdr-dev/sessions', herdrSession(ROOT), 'herdr.sock')
// 내 셸은 설치본 런타임 pane 이라 HERDR_* 가 설치본을 가리킨다 — 세 칸을 격리 값으로 덮는다.
const env = { ...process.env, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: args['herdr-bin'], HERDR_PANE_ID: '' }
const cli = (argv, timeout = 15_000) => {
  const run = spawnSync(args['herdr-bin'], argv, { env, encoding: 'utf8', timeout })
  if (run.status !== 0) throw new Error(`herdr ${argv.slice(0, 2).join(' ')} exit ${run.status}: ${(run.stderr ?? '').slice(0, 200)}`)
  return run.stdout
}

fs.mkdirSync(OUT, { recursive: true })
const received = []
const stateOf = (list) => {
  if (!list?.available) return null
  for (const repo of list.repos) for (const task of repo.tasks) for (const channel of task.channels) if (channel.id === PANE) return { dot: channel.dot, waiting: channel.waiting, preview: channel.preview?.kind ?? null }
  return null
}
const EXPECT = {
  working: (s) => s !== null && s.dot === 'working',
  approval: (s) => s !== null && s.dot === 'waiting' && s.waiting === 'approval',
  question: (s) => s !== null && s.dot === 'waiting' && s.waiting === 'question',
  idle: (s) => s !== null && (s.dot === 'idle' || s.dot === 'done'),
}

/** 원인 뒤 목록 중 기대 상태로 바뀐 첫 목록 — 직전 목록의 대상이 이미 기대 상태면 짝이 아니다(보류). */
function match(expect, causeAt, offset) {
  const ok = EXPECT[expect]
  const before = received.filter((item) => item.at - offset < causeAt)
  const prior = before.at(-1)?.state ?? null
  if (ok(prior)) return { kind: 'held', why: `원인 직전 이미 ${expect}` }
  const hit = received.find((item) => item.at - offset >= causeAt && ok(item.state))
  return hit === undefined ? { kind: 'miss' } : { kind: 'hit', item: hit }
}

const rows = []
let client = null
async function measure({ round, step, expect, cause }) {
  const causeAt = Date.now()
  cause()
  const offset0 = client.clockOffset()?.offsetMs ?? 0
  await until(() => (match(expect, causeAt, offset0).kind === 'hit' ? true : null), { timeoutMs: 15_000, label: `${round} ${step}` }).catch(() => null)
  await client.ping()
  const offset = client.clockOffset()?.offsetMs ?? 0
  const result = match(expect, causeAt, offset)
  if (result.kind !== 'hit') {
    rows.push({ round, step, expect, causeAt, [result.kind]: true, why: result.why ?? null })
    console.log(`${round} ${step} ${expect} ${result.kind}`)
    return
  }
  const hit = result.item
  const row = { round, step, expect, causeAt, seq: hit.seq, state: hit.state, changedAt: hit.changedAt, recvAt: hit.recvAt, offsetMs: offset, aMs: hit.recvAt - (hit.changedAt - offset), bMs: hit.recvAt - causeAt }
  rows.push(row)
  console.log(`${round} ${step} ${expect} seq=${hit.seq} ⓐ ${row.aMs}ms ⓑ ${row.bMs}ms`)
}

async function waitIdle(label) {
  await until(() => (EXPECT.idle(received.at(-1)?.state ?? null) ? true : null), { timeoutMs: 120_000, everyMs: 250, label })
}

async function main() {
  client = await phone(ROOT, {
    onList: ({ message, recvAt }) => {
      received.push({ seq: message.seq, at: message.at, changedAt: message.changedAt, recvAt, state: stateOf(message.list) })
    },
  })
  for (let i = 0; i < 5; i += 1) await client.ping()
  await until(() => (received.length > 0 ? true : null), { timeoutMs: 10_000, label: '첫 목록' })
  await waitIdle('처음 한가')
  for (const [n, kind] of ROUNDS.entries()) {
    const round = `${n}-${kind}`
    const prompt = kind === 'approval' ? `Use the Bash tool to run exactly: touch mix-${n}.txt` : `Use the AskUserQuestion tool to ask me one question: red or blue? Then stop.`
    cli(['pane', 'send-text', PANE, prompt])
    await sleep(300)
    await measure({ round, step: '① 지시', expect: 'working', cause: () => cli(['pane', 'send-keys', PANE, 'Enter']) })
    const marker = kind === 'approval' ? 'Do you want to proceed?' : 'Enter to select'
    const seen = spawnSync(args['herdr-bin'], ['pane', 'wait-output', '--match', marker, '--source', 'visible', '--timeout', '60000', PANE], { env, encoding: 'utf8', timeout: 65_000 })
    const seenAt = Date.now()
    if (seen.status !== 0) {
      rows.push({ round, step: '② 대기 화면', expect: kind, miss: true, why: `대화상자 안 보임 exit ${seen.status}` })
      console.log(`${round} ② 대화상자 안 보임`)
      continue
    }
    await measureAt({ round, step: '② 대기 화면', expect: kind, causeAt: seenAt })
    await sleep(500)
    await measure({ round, step: '③ 답', expect: 'working', cause: () => cli(['pane', 'send-keys', PANE, kind === 'approval' ? '1' : 'Enter']) })
    await waitIdle(`${round} 한가`).catch(() => rows.push({ round, step: '한가 대기', note: '120초 안에 한가 아님' }))
    await sleep(1_500)
  }
  const measured = rows.filter((row) => row.expect !== undefined)
  const hits = measured.filter((row) => row.aMs !== undefined)
  const maxA = hits.length ? Math.max(...hits.map((row) => row.aMs)) : null
  const maxB = hits.length ? Math.max(...hits.map((row) => row.bMs)) : null
  const pass = hits.length === measured.length && hits.length > 0 && maxA <= LIMIT_MS && maxB <= LIMIT_MS
  const result = { at: new Date().toISOString(), method: 'claude-mix — ①Enter 직전·②wait-output 발견 시각·③키 직전 → 폰 수신. ⓐ=수신−(changedAt−시계차)', transitions: measured.length, hits: hits.length, maxAMs: maxA, maxBMs: maxB, limitMs: LIMIT_MS, verdict: pass ? '통과' : '미달', rows }
  writeJson(path.join(OUT, 'claude-mix.json'), result)
  fs.writeFileSync(path.join(OUT, 'claude-mix.ndjson'), received.map((item) => JSON.stringify(item)).join('\n') + '\n')
  console.log(`claude-mix 전이 ${measured.length} · 짝 ${hits.length} · ⓐ 최대 ${maxA}ms · ⓑ 최대 ${maxB}ms → ${result.verdict}`)
  await client.close()
  process.exit(pass ? 0 : 1)
}

async function measureAt({ round, step, expect, causeAt }) {
  const offset0 = client.clockOffset()?.offsetMs ?? 0
  await until(() => (match(expect, causeAt, offset0).kind === 'hit' ? true : null), { timeoutMs: 15_000, label: `${round} ${step}` }).catch(() => null)
  await client.ping()
  const offset = client.clockOffset()?.offsetMs ?? 0
  // 대화상자가 화면에 뜬 것보다 목록이 먼저 바뀌었을 수 있다(폴링 늦음) — 그 경우 발견 시각 이전 2초 안의 바뀜도 짝으로 본다(ⓑ 는 음수가 아닌 0 으로).
  let result = match(expect, causeAt, offset)
  if (result.kind !== 'hit') result = match(expect, causeAt - 2_000, offset)
  if (result.kind !== 'hit') {
    rows.push({ round, step, expect, causeAt, [result.kind]: true, why: result.why ?? null })
    console.log(`${round} ${step} ${expect} ${result.kind}`)
    return
  }
  const hit = result.item
  const row = { round, step, expect, causeAt, seq: hit.seq, state: hit.state, changedAt: hit.changedAt, recvAt: hit.recvAt, offsetMs: offset, aMs: hit.recvAt - (hit.changedAt - offset), bMs: Math.max(0, hit.recvAt - causeAt), bNote: hit.recvAt < causeAt ? '목록이 화면 발견보다 먼저 옴' : undefined }
  rows.push(row)
  console.log(`${round} ${step} ${expect} seq=${hit.seq} ⓐ ${row.aMs}ms ⓑ ${row.bMs}ms`)
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
