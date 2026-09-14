// A6 보강 — **꼬리 창 확장(256KB → 2MB)이 실제로 도는지** 잰다.
//
// A5·A6 실측(`a5-a6-cost.json`)은 네 파일 전부 첫 창(256KB) 안에서 텍스트를 찾았다. 그래서
// `readDigest` 의 **두 번째 읽기 가지와 2MB 상한은 한 번도 실행되지 않았다.** 통과선은 이미
// 충족했지만 "안 도는 코드"가 판정표 뒤에 남는 건 공백이다 — 여기서 그 공백을 메운다.
//
// 사용자 트랜스크립트로는 이 모양을 못 만든다(읽기 전용, 기준 E6). **격리 HOME 에 합성 파일**
// 셋을 깔고 잰다 — 텍스트가 ① 첫 창 안 ② 첫 창 밖·2MB 안 ③ 2MB 밖 인 세 경우다.
//
// 관문 ⑤ 반례는 ①과 ③ 이 겸한다. ① 은 "확장이 안 돈다"(바이트 ≤ 256KB)를 보여 바이트 계수가
// 확장을 실제로 가른다는 걸 증명하고, ③ 은 **파일 안에 텍스트가 분명히 있는데도** 창 밖이라
// `unknown-format` 으로 돌아온다 — 창을 무한정 늘려 통과시키지 않는다는 증거다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))
const REPO_DIR = path.dirname(APP_DIR)
const RAW_DIR = path.join(REPO_DIR, 'specs/LIFE-366-session-identity/raw/claude')
const HOME_REAL = path.join(REPO_DIR, '.tmp/l366-home')
const HOME_LINK = '/tmp/l366h'

/** lib.mjs 의 `isolatedHome()` 과 **같은 방벽** — 맨 HOME 이거나 .tmp 밖이면 거부한다 (관문 ④). */
function isolatedHome(): string {
  const real = path.resolve(HOME_REAL)
  if (real === os.homedir() || !real.startsWith(path.join(REPO_DIR, '.tmp'))) {
    throw new Error(`거부: 격리 HOME 실물이 <worktree>/.tmp/ 밖이다 (${real})`)
  }
  fs.mkdirSync(path.join(real, '.claude/projects'), { recursive: true })
  if (!fs.existsSync(HOME_LINK) || fs.realpathSync(HOME_LINK) !== fs.realpathSync(real)) {
    fs.rmSync(HOME_LINK, { force: true, recursive: false })
    fs.symlinkSync(real, HOME_LINK)
  }
  if (fs.realpathSync(HOME_LINK) !== fs.realpathSync(real)) throw new Error('거부: 격리 HOME 링크가 어긋났다')
  return HOME_LINK
}

// **import 보다 먼저** HOME 을 갈아끼운다 — `transcript.ts` 는 `os.homedir()` 로 파일을 찾고,
// POSIX 의 `os.homedir()` 는 `$HOME` 을 먼저 본다.
process.env['HOME'] = isolatedHome()

const { clearTranscriptCacheForTest, readSessionDigest, TAIL_MAX_BYTES, TAIL_WINDOW_BYTES } = await import(
  '../../src/main/transcript.js'
)
type Ref = Parameters<typeof readSessionDigest>[0]

const KB = 1024
const MB = 1024 * KB

const stamp = (index: number): string => new Date(Date.UTC(2026, 8, 15, 0, 0, index)).toISOString()

/** 어시스턴트 텍스트가 **없는** 레코드 — 창을 채우는 데만 쓴다 (도구 호출 한 턴). */
function filler(index: number): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: stamp(index),
      message: { content: [{ type: 'tool_use', id: `t${index}`, name: 'Bash', input: { command: 'x'.repeat(200) } }] },
    }) +
    '\n' +
    JSON.stringify({
      type: 'user',
      timestamp: stamp(index),
      message: { content: [{ type: 'tool_result', tool_use_id: `t${index}`, content: 'y'.repeat(300) }] },
    }) +
    '\n'
  )
}

/** 꼬리에서 `tailBytes` 바이트쯤 앞에 어시스턴트 텍스트 하나를 심은 파일을 만든다. */
function makeFile(input: { home: string; id: string; text: string; tailBytes: number; headBytes: number }): string {
  const dir = path.join(input.home, '.claude', 'projects', '-l366-window')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${input.id}.jsonl`)
  const grow = (target: number, from: number): string => {
    let out = ''
    let index = from
    while (Buffer.byteLength(out) < target) out += filler(index++)
    return out
  }
  const head = grow(input.headBytes, 1000)
  const mark = JSON.stringify({
    type: 'assistant',
    timestamp: stamp(1),
    message: { content: [{ type: 'text', text: input.text }] },
  })
  const tail = grow(input.tailBytes, 5000)
  fs.writeFileSync(file, head + mark + '\n' + tail)
  return file
}

type Row = {
  경우: string
  파일_바이트: number
  '텍스트가 꼬리에서 떨어진 거리': number
  상태: string
  텍스트_일치: boolean | null
  읽은_바이트: number
  '첫 창(256KB)을 넘겼나': boolean
  '2MB 상한에 걸렸나': boolean
  ms: number
}

function measure(input: { 경우: string; id: string; text: string; tailBytes: number; headBytes: number }): Row {
  const home = isolatedHome()
  const file = makeFile({ home, id: input.id, text: input.text, tailBytes: input.tailBytes, headBytes: input.headBytes })
  const size = fs.statSync(file).size
  const ref: Ref = { kind: 'id', agent: 'claude', source: 'l366:window', id: input.id }
  clearTranscriptCacheForTest()
  const at = process.hrtime.bigint()
  const read = readSessionDigest(ref)
  const ms = Number(process.hrtime.bigint() - at) / 1e6
  const got = read.digest.activity.state === 'text' ? read.digest.activity.text : null
  return {
    경우: input.경우,
    파일_바이트: size,
    '텍스트가 꼬리에서 떨어진 거리': input.tailBytes,
    상태: read.digest.activity.state,
    텍스트_일치: got === null ? null : got === input.text,
    읽은_바이트: read.bytes,
    '첫 창(256KB)을 넘겼나': read.bytes > TAIL_WINDOW_BYTES,
    '2MB 상한에 걸렸나': read.bytes === TAIL_MAX_BYTES,
    ms: Math.round(ms * 100) / 100,
  }
}

const TEXT = '창 확장 실측용 어시스턴트 텍스트 — 이 문자열이 그대로 돌아와야 한다.'

// ① 첫 창 안 — 확장이 **안 돌아야** 한다 (반례: 바이트 계수가 확장을 실제로 가르나).
const inWindow = measure({ 경우: '① 텍스트가 첫 창(256KB) 안', id: 'l366-win-in', text: TEXT, tailBytes: 100 * KB, headBytes: 400 * KB })
// ② 첫 창 밖, 2MB 안 — 확장이 **돌아야** 한다.
const midWindow = measure({ 경우: '② 첫 창 밖 · 2MB 안', id: 'l366-win-mid', text: TEXT, tailBytes: 700 * KB, headBytes: 200 * KB })
// ③ 2MB 밖 — 파일 안에 텍스트가 **있는데도** 모른다고 말해야 한다.
const outWindow = measure({ 경우: '③ 2MB 밖', id: 'l366-win-out', text: TEXT, tailBytes: 3 * MB, headBytes: 64 * KB })

const out = {
  at: new Date().toISOString(),
  note: '격리 HOME(<worktree>/.tmp/l366-home)의 합성 파일이다. 사용자 트랜스크립트는 건드리지 않는다 (E6).',
  창: { 첫_창: TAIL_WINDOW_BYTES, 상한: TAIL_MAX_BYTES },
  표: [inWindow, midWindow, outWindow],
  판정: {
    '① 확장 안 돎': inWindow.상태 === 'text' && inWindow.텍스트_일치 === true && !inWindow['첫 창(256KB)을 넘겼나'],
    '② 확장 돌아 찾음': midWindow.상태 === 'text' && midWindow.텍스트_일치 === true && midWindow['첫 창(256KB)을 넘겼나'],
    '② 2MB 이내': midWindow.읽은_바이트 <= TAIL_MAX_BYTES,
    '③ 상한에 걸려 모른다고 함': outWindow.상태 === 'unknown-format' && outWindow['2MB 상한에 걸렸나'],
    '반례 요지': '①은 확장 없이 통과하고 ③은 텍스트가 파일에 있어도 통과하지 못한다 — 창 계수가 실제로 가른다',
  },
}

fs.mkdirSync(RAW_DIR, { recursive: true })
fs.writeFileSync(path.join(RAW_DIR, 'a6-window.json'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 1))
