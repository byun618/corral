// 수정 라운드 6 — **늦게 붙는 첫 발화**(C6′-①) 회귀 프로브.
//
// codex 가 r5 를 깬 재현(`/tmp/l366-review/r5-src.fKd7PI/head-race.mts`)을 **내 사본**으로 옮겼다.
// 원본은 안 건드린다. 바뀐 것은 셋뿐이다:
//   · import 경로가 이 worktree 다
//   · HOME 이 **하네스 격리 HOME** 이다 (관문 ④ — codex 의 `/tmp/l366-review/home-*` 도, 사용자
//     HOME 도 안 쓴다)
//   · `afterClear` 뿐 아니라 **`afterGrowth` 를 판정 칸으로** 싣는다. r5 는 여기가 `null` 이었다
//
// 같은 파일에서 C6′-④(끝나는 조건)도 같이 잰다 — 창을 꽉 채운 파일은 못 찾아도 다시 안 읽는다.
// 못 고친 채 돌리면 `afterGrowth` 가 `null` 로 떨어진다(관문 ⑤ 반례 ⓐ).

import fs from 'node:fs'
import path from 'node:path'
import { clearTranscriptCache, readSessionDigest, HEAD_WINDOW_BYTES } from '../../src/main/transcript.js'
import type { AgentSessionRef } from '../../src/shared/types.js'

const RAW_DIR = path.join(
  path.dirname(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))),
  'specs/LIFE-366-session-identity/raw/claude',
  process.env['L366_RAW_SUBDIR'] ?? '',
)

// 격리 HOME — 하네스가 쓰는 그 폴더다 (`lib.mjs` 의 `.tmp/l366-home` 을 가리키는 짧은 링크).
// **실물이 worktree 의 `.tmp/` 밖이면 던진다** — 이 한 줄이 관문 ④ 의 마지막 방벽이다.
const HOME = process.env['L366_HOME_LINK'] ?? '/tmp/l366h'
const REPO_DIR = path.dirname(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname))))
const real = fs.existsSync(HOME) ? fs.realpathSync(HOME) : ''
if (!real.startsWith(path.join(REPO_DIR, '.tmp'))) {
  throw new Error(`거부: 격리 HOME(${HOME}) 이 <worktree>/.tmp/ 를 안 가리킨다 — 하네스를 먼저 한 번 돌려 링크를 깔아라`)
}
process.env['HOME'] = HOME

const EXPECTED = '첫 사용자 발화가 조금 늦게 붙는 경우를 확인해라'
const ID = '11111111-2222-4333-8444-555555555555'

const meta = JSON.stringify({ type: 'attachment', sessionId: ID })
const user = JSON.stringify({
  type: 'user',
  sessionId: ID,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: '첫 사용자 발화가 조금 늦게 붙는 경우를 확인해라. 그리고 결과를 알려라.' },
})
const assistant = JSON.stringify({
  type: 'assistant',
  sessionId: ID,
  timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text: '확인했다' }] },
})

const filler = (index: number): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: ID,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `채움 ${index} ${'가'.repeat(2000)}` }] },
  })

function raceProbe() {
  const dir = path.join(HOME, '.claude', 'projects', 'l366-r6-race')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${ID}.jsonl`)
  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id: ID }

  clearTranscriptCache()
  fs.writeFileSync(file, `${meta}\n`)
  const before = readSessionDigest(ref)
  fs.appendFileSync(file, `${user}\n${assistant}\n`)
  const afterGrowth = readSessionDigest(ref) // **캐시를 안 비운다** — 여기가 R1 이 살던 자리다
  const stable = readSessionDigest(ref) // 한 주기 더 — 값이 흔들리지 않는지
  clearTranscriptCache()
  const afterClear = readSessionDigest(ref)

  return {
    'before (메타 한 줄)': before.digest.firstPrompt,
    'afterGrowth (캐시 안 비움)': afterGrowth.digest.firstPrompt,
    'afterGrowth 바이트': afterGrowth.bytes,
    'afterGrowth 머리 바이트': afterGrowth.headBytes,
    '다음 주기에도 유지': stable.digest.firstPrompt,
    'afterClear (캐시 비움)': afterClear.digest.firstPrompt,
    기대: EXPECTED,
    통과: afterGrowth.digest.firstPrompt === EXPECTED && stable.digest.firstPrompt === EXPECTED,
    설명: 'r5 는 여기서 `afterGrowth: null` 이었다 — 못 찾은 것까지 영구 캐시했기 때문이다 (codex R1).',
  }
}

/** C6′-④ — 창을 꽉 채워 읽은 파일은 **못 찾아도** 다시 안 읽는다 (재판독이 안 끝나면 예산이 샌다). */
function terminationProbe() {
  const dir = path.join(HOME, '.claude', 'projects', 'l366-r6-term')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const id = 'c6c6c6c6-e6e6-4e6e-8e6e-000000000066'
  const file = path.join(dir, `${id}.jsonl`)
  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id }

  // 사람 발화 없이 창을 넘기는 파일 — 머리 창을 꽉 채워 읽지만 첫 발화는 안 나온다.
  const lines: string[] = []
  for (let index = 0; index < 200; index += 1) lines.push(filler(index))
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const size = fs.statSync(file).size

  clearTranscriptCache()
  const first = readSessionDigest(ref)
  fs.appendFileSync(file, filler(999) + '\n')
  const grown = readSessionDigest(ref)
  fs.appendFileSync(file, filler(1000) + '\n')
  const grownAgain = readSessionDigest(ref)

  return {
    '파일 바이트': size,
    '창보다 큰가': size > HEAD_WINDOW_BYTES,
    '첫 주기 머리 바이트': first.headBytes,
    '첫 주기 첫 발화': first.digest.firstPrompt,
    '자란 뒤 머리 바이트': grown.headBytes,
    '또 자란 뒤 머리 바이트': grownAgain.headBytes,
    통과: first.headBytes === HEAD_WINDOW_BYTES && grown.headBytes === 0 && grownAgain.headBytes === 0,
    설명: 'append-only 라 앞쪽 256KB 는 다시 안 바뀐다 — 꽉 채워 읽었으면 그만 읽는 게 C6′-④ 다.',
  }
}

/** 아직 안 끝난 파일(창보다 작다)의 재판독이 **추가 0바이트**인지 — C6′-② 가 이 성질에 걸려 있다. */
function freeRereadProbe() {
  const dir = path.join(HOME, '.claude', 'projects', 'l366-r6-free')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const id = 'c6c6c6c6-f6f6-4f6f-8f6f-000000000066'
  const file = path.join(dir, `${id}.jsonl`)
  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id }

  clearTranscriptCache()
  fs.writeFileSync(file, `${meta}\n`)
  const first = readSessionDigest(ref)
  const cycles: number[] = []
  for (let index = 0; index < 5; index += 1) {
    fs.appendFileSync(file, filler(index) + '\n')
    cycles.push(readSessionDigest(ref).headBytes)
  }
  return {
    '첫 주기 머리 바이트': first.headBytes,
    '재판독 5회의 머리 바이트': cycles,
    '파일 바이트': fs.statSync(file).size,
    통과: first.headBytes === 0 && cycles.every((value) => value === 0),
    설명: '창보다 작은 파일은 꼬리 조각이 이미 파일 전체다 — 재판독을 열어도 읽기가 안 늘어난다.',
  }
}

function main(): void {
  const out = {
    at: new Date().toISOString(),
    home: HOME,
    note: '격리 HOME 의 합성 파일이다 — 사용자 트랜스크립트에는 쓰지 않는다 (E6·관문 ④). codex 원본 스크립트는 안 건드렸다.',
    'C6′-① 늦게 붙는 첫 발화': raceProbe(),
    'C6′-④ 재판독이 끝난다': terminationProbe(),
    'C6′-② 안 끝난 파일의 재판독은 0바이트': freeRereadProbe(),
  }
  const verdict = {
    'C6′-①': out['C6′-① 늦게 붙는 첫 발화'].통과,
    'C6′-④': out['C6′-④ 재판독이 끝난다'].통과,
    'C6′-②': out['C6′-② 안 끝난 파일의 재판독은 0바이트'].통과,
  }
  fs.mkdirSync(RAW_DIR, { recursive: true })
  fs.writeFileSync(path.join(RAW_DIR, 'c6-race-r6.json'), JSON.stringify({ ...out, 판정: verdict }, null, 2) + '\n')
  console.log(JSON.stringify(verdict, null, 1))
}

main()
