// 수정 라운드 1 · V2 — **`ai-title` 이 첫 꼬리 창 밖이면 provider 제목이 조용히 빠진다.**
//
// codex 리뷰가 556KB 합성 파일로 재현한 모양이다: `ai-title` 은 첫 창(256KB) **밖**, 어시스턴트
// 텍스트는 **안**. 그러면 확장 가지가 안 돌아 `providerTitle` 이 null 이 되고 제목이 C1 의
// provider 티어를 건너뛴다. 고친 뒤 같은 모양에서 제목이 돌아오는지를 여기서 잰다.
//
// 같이 지켜야 하는 것이 **비용**이다 (A6 ≤2MB·≤50ms). 그래서 세 가지를 같이 잰다 —
// ① 제목을 못 찾으면 상한까지 한 번 훑는가 ② 그 훑기가 **파일당 한 번**인가(안 그러면 제목 없는
// 긴 파일이 갱신마다 2MB 를 다시 읽어 A7 을 깬다) ③ 총 읽기가 여전히 2MB 이하인가.
//
// 관문 ⑤ 반례 셋: ⓐ `ai-title` 을 **2MB 밖**에 두면 제목이 여전히 null 이고 읽기가 상한에 걸린다
// (훑기가 무한이 아니다) ⓑ `sessionId` 가 **다른** `ai-title` 은 깊은 창 안에 있어도 안 쓴다
// (C2 가 새 경로에서도 산다) ⓒ 캐시를 안 비우면 두 번째 읽기가 0바이트다 — 비우면 다시 읽는다(V10).
//
// 합성 파일은 전부 격리 HOME 에 만든다. 마지막 §는 **사용자 파일 읽기 전용 실측**이고 거리·개수만 싣는다 (E6).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))
const REPO_DIR = path.dirname(APP_DIR)
const RAW_DIR = path.join(REPO_DIR, 'specs/LIFE-366-session-identity/raw/claude')
const HOME_REAL = path.join(REPO_DIR, '.tmp/l366-home')
const HOME_LINK = '/tmp/l366h'
const USER_HOME = os.homedir()

/** lib.mjs 의 `isolatedHome()` 과 같은 방벽 (관문 ④). */
function isolatedHome(): string {
  const real = path.resolve(HOME_REAL)
  if (real === USER_HOME || !real.startsWith(path.join(REPO_DIR, '.tmp'))) throw new Error('거부: 격리 HOME 이 .tmp 밖이다')
  fs.mkdirSync(path.join(real, '.claude/projects'), { recursive: true })
  if (!fs.existsSync(HOME_LINK) || fs.realpathSync(HOME_LINK) !== fs.realpathSync(real)) {
    fs.rmSync(HOME_LINK, { force: true, recursive: false })
    fs.symlinkSync(real, HOME_LINK)
  }
  if (fs.realpathSync(HOME_LINK) !== fs.realpathSync(real)) throw new Error('거부: 격리 HOME 링크가 어긋났다')
  return HOME_LINK
}

process.env['HOME'] = isolatedHome()

const { clearTranscriptCache, readSessionDigest, TAIL_MAX_BYTES, TAIL_WINDOW_BYTES } = await import(
  '../../src/main/transcript.js'
)
type Ref = Parameters<typeof readSessionDigest>[0]

const KB = 1024
const MB = 1024 * KB
const DIR = path.join(isolatedHome(), '.claude', 'projects', '-l366-aititle')

const stamp = (index: number): string => new Date(Date.UTC(2026, 8, 15, 0, 0, index % 60)).toISOString()

/** 어시스턴트 텍스트가 **없는** 레코드 — 창을 채우는 데만 쓴다. */
function filler(index: number): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: stamp(index),
      message: { content: [{ type: 'tool_use', id: `t${index}`, name: 'Bash', input: { command: 'x'.repeat(200) } }] },
    }) + '\n'
  )
}

function grow(target: number, from: number): string {
  let out = ''
  let index = from
  while (Buffer.byteLength(out) < target) out += filler(index++)
  return out
}

const titleLine = (title: string, sessionId: string): string =>
  JSON.stringify({ type: 'ai-title', sessionId, aiTitle: title, timestamp: stamp(1) }) + '\n'

const textLine = (text: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: stamp(2), message: { content: [{ type: 'text', text }] } }) + '\n'

/**
 * 「맨 앞 ai-title → filler → 맨 뒤 어시스턴트 텍스트」 모양의 파일 (codex 재현 모양).
 * `titleAtEnd` 면 제목을 **꼬리 끝**에 둔다 — 첫 창 안에 제목이 있는 대조군용이다.
 */
function makeFile(input: {
  id: string
  titleOwner: string | null
  title: string
  gapBytes: number
  text: string
  titleAtEnd?: boolean
}): string {
  fs.mkdirSync(DIR, { recursive: true })
  const file = path.join(DIR, `${input.id}.jsonl`)
  const title = input.titleOwner === null ? '' : titleLine(input.title, input.titleOwner)
  const body = grow(input.gapBytes, 1000) + textLine(input.text)
  fs.writeFileSync(file, input.titleAtEnd === true ? body + title : title + body)
  return file
}

const TEXT = 'Recent text — 꼬리 창 안에 있는 마지막 어시스턴트 텍스트'
const TITLE = '창 밖에 있는 provider 제목'

type Row = {
  경우: string
  파일_바이트: number
  'ai-title 이 EOF 에서 떨어진 거리': number | null
  activity: string
  텍스트_일치: boolean
  providerTitle: string | null
  읽은_바이트: number
  '첫 창을 넘겼나': boolean
  '2MB 상한에 걸렸나': boolean
  ms: number
}

function measure(input: { 경우: string; id: string; titleOwner: string | null; gapBytes: number; titleAtEnd?: boolean }): Row {
  const file = makeFile({
    id: input.id,
    titleOwner: input.titleOwner,
    title: TITLE,
    gapBytes: input.gapBytes,
    text: TEXT,
    titleAtEnd: input.titleAtEnd,
  })
  const size = fs.statSync(file).size
  const ref: Ref = { kind: 'id', agent: 'claude', source: 'l366:v2', id: input.id }
  clearTranscriptCache()
  const at = process.hrtime.bigint()
  const read = readSessionDigest(ref)
  const ms = Number(process.hrtime.bigint() - at) / 1e6
  const got = read.digest.activity.state === 'text' ? read.digest.activity.text : null
  return {
    경우: input.경우,
    파일_바이트: size,
    'ai-title 이 EOF 에서 떨어진 거리': input.titleOwner === null ? null : size - titleLine(TITLE, input.titleOwner).length,
    activity: read.digest.activity.state,
    텍스트_일치: got === TEXT,
    providerTitle: read.digest.providerTitle,
    읽은_바이트: read.bytes,
    '첫 창을 넘겼나': read.bytes > TAIL_WINDOW_BYTES,
    '2MB 상한에 걸렸나': read.bytes === TAIL_MAX_BYTES,
    ms: Math.round(ms * 100) / 100,
  }
}

fs.rmSync(DIR, { recursive: true, force: true })

const OWNER_IN = 'cc000000-0000-4000-8000-000000000001'
const OWNER_OUT = 'cc000000-0000-4000-8000-000000000002'
const OWNER_FAR = 'cc000000-0000-4000-8000-000000000003'
const OWNER_ALIEN = 'cc000000-0000-4000-8000-000000000004'
const OWNER_NONE = 'cc000000-0000-4000-8000-000000000005'

// ① codex 가 재현한 모양 — 556KB, ai-title 은 첫 창 밖. **고쳐졌다면 제목이 돌아온다.**
const codexShape = measure({ 경우: '① codex 재현 모양 (556KB · ai-title 이 첫 창 밖)', id: OWNER_OUT, titleOwner: OWNER_OUT, gapBytes: 556 * KB })
// ② 대조군 — **첫 창보다 큰 파일**인데 ai-title 이 꼬리 끝(첫 창 안)에 있다. 확장이 안 돌아야
// 한다: 읽은 바이트가 정확히 첫 창(256KB)이어야 대조가 성립한다. 파일이 창보다 작으면 어차피
// 통째로 읽히므로 "확장이 안 돌았다" 가 증명되지 않는다.
const inWindow = measure({ 경우: '② 대조군 (첫 창보다 큰 파일 · ai-title 이 꼬리 안)', id: OWNER_IN, titleOwner: OWNER_IN, gapBytes: 400 * KB, titleAtEnd: true })
// ③ 반례 ⓐ — ai-title 이 **2MB 밖**. 훑기가 무한이 아니면 제목은 여전히 null 이고 읽기는 상한에 걸린다.
const beyondCap = measure({ 경우: '③ 반례ⓐ ai-title 이 2MB 밖', id: OWNER_FAR, titleOwner: OWNER_FAR, gapBytes: 3 * MB })
// ④ 반례 ⓑ — 깊은 창 안에 있지만 **다른 세션의** ai-title. C2 가 새 경로에서도 살아야 한다.
const alien = measure({ 경우: '④ 반례ⓑ 다른 세션의 ai-title (C2)', id: OWNER_ALIEN, titleOwner: 'zz999999-9999-4999-8999-999999999999', gapBytes: 556 * KB })
// ⑤ 제목이 아예 없는 긴 파일 — 훑기가 **파일당 한 번**인지 보는 출발점.
const noTitle = measure({ 경우: '⑤ ai-title 이 아예 없는 긴 파일 (첫 읽기)', id: OWNER_NONE, titleOwner: null, gapBytes: 556 * KB })

// ⑥ 같은 파일을 키워 다시 읽는다 — 깊은 훑기를 **되풀이하면 안 된다** (A7 주기 비용 보호).
const noTitleFile = path.join(DIR, `${OWNER_NONE}.jsonl`)
fs.appendFileSync(noTitleFile, textLine('두 번째 말'))
const secondRead = readSessionDigest({ kind: 'id', agent: 'claude', source: 'l366:v2', id: OWNER_NONE })

// ⑦ 제목이 첫 창 안에 있던 파일을 **창 밖으로 밀어낸다** — 한 번 확인한 제목은 유지돼야 한다.
const stickyFile = path.join(DIR, `${OWNER_IN}.jsonl`)
fs.appendFileSync(stickyFile, grow(400 * KB, 9000) + textLine('밀어낸 뒤의 마지막 말'))
const sticky = readSessionDigest({ kind: 'id', agent: 'claude', source: 'l366:v2', id: OWNER_IN })

// ⑧ V10 — 캐시. 안 바뀐 파일의 두 번째 읽기는 0바이트, `clearTranscriptCache()` 뒤엔 다시 읽는다.
const cachedAgain = readSessionDigest({ kind: 'id', agent: 'claude', source: 'l366:v2', id: OWNER_IN })
clearTranscriptCache()
const afterClear = readSessionDigest({ kind: 'id', agent: 'claude', source: 'l366:v2', id: OWNER_IN })

// --- 사용자 코퍼스 실측 (읽기 전용 · 거리와 개수만) ------------------------------------------
//
// "한 번만 훑는다" 가 실환경에서 몇 번인지 = **ai-title 이 없는 claude 파일이 몇 개인가**.
// 그리고 "첫 창 밖" 이 실제로 몇 건인가 — 0 이면 이 고침은 잠재 결함을 막는 것이고, >0 이면
// 지금 화면이 실제로 제목을 잃고 있었다는 뜻이다.
const PROBE_TAIL = 4 * MB
function lastTitleDistance(file: string, size: number): number | null {
  const from = Math.max(0, size - PROBE_TAIL)
  const handle = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size - from)
    fs.readSync(handle, buffer, 0, buffer.length, from)
    const text = buffer.toString('utf8')
    const at = text.lastIndexOf('"type":"ai-title"')
    if (at === -1) return null
    const lineStart = text.lastIndexOf('\n', at) + 1
    return size - (from + Buffer.byteLength(text.slice(0, lineStart)))
  } finally {
    fs.closeSync(handle)
  }
}

const corpus = {
  파일수: 0,
  'ai-title 있음': 0,
  '없음(4MB 꼬리 안)': 0,
  // 제목이 없어도 **첫 창보다 작은 파일은 어차피 통째로 읽힌다** — 깊은 훑기가 따로 안 돈다.
  // 실제로 한 번의 추가 읽기를 무는 파일은 이 수다.
  '없음 & 첫 창보다 큼 (깊은 훑기 1회 대상)': 0,
  '그 파일들의 최대 바이트': 0,
  '첫 창(256KB) 밖': 0,
  '2MB 밖': 0,
  최대_거리: 0,
}
const projects = path.join(USER_HOME, '.claude', 'projects')
for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  for (const name of fs.readdirSync(path.join(projects, entry.name))) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(projects, entry.name, name)
    const size = fs.statSync(file).size
    if (size === 0) continue
    corpus.파일수 += 1
    const distance = lastTitleDistance(file, size)
    if (distance === null) {
      corpus['없음(4MB 꼬리 안)'] += 1
      if (size > TAIL_WINDOW_BYTES) {
        corpus['없음 & 첫 창보다 큼 (깊은 훑기 1회 대상)'] += 1
        corpus['그 파일들의 최대 바이트'] = Math.max(corpus['그 파일들의 최대 바이트'], size)
      }
      continue
    }
    corpus['ai-title 있음'] += 1
    if (distance > TAIL_WINDOW_BYTES) corpus['첫 창(256KB) 밖'] += 1
    if (distance > TAIL_MAX_BYTES) corpus['2MB 밖'] += 1
    corpus.최대_거리 = Math.max(corpus.최대_거리, distance)
  }
}

const out = {
  at: new Date().toISOString(),
  note: '합성 파일은 격리 HOME. 마지막 §만 사용자 파일 읽기 전용이고 거리·개수만 싣는다 (E6).',
  창: { 첫_창: TAIL_WINDOW_BYTES, 상한: TAIL_MAX_BYTES },
  표: [codexShape, inWindow, beyondCap, alien, noTitle],
  '⑥ 제목 없는 파일을 키워 다시 읽기': {
    설명: '깊은 훑기는 파일당 한 번이다 — 되풀이하면 A7 주기 비용이 8배가 된다',
    읽은_바이트: secondRead.bytes,
    '첫 창 이하인가': secondRead.bytes <= TAIL_WINDOW_BYTES,
    activity: secondRead.digest.activity.state,
  },
  '⑦ 제목이 창 밖으로 밀려난 뒤': {
    설명: '한 번 확인한 제목은 파일이 자라 창 밖으로 나가도 유지한다 — 대화 중에 이름이 폴백으로 되돌아가면 안 된다',
    providerTitle: sticky.digest.providerTitle,
    유지됐나: sticky.digest.providerTitle === TITLE,
    읽은_바이트: sticky.bytes,
  },
  '⑧ V10 — 캐시 비우기': {
    '안 바뀐 파일 두 번째 읽기 바이트': cachedAgain.bytes,
    statOnly: cachedAgain.statOnly,
    'clearTranscriptCache() 뒤 바이트': afterClear.bytes,
    '비우면 다시 읽나': cachedAgain.bytes === 0 && afterClear.bytes > 0,
  },
  '사용자 코퍼스 (읽기 전용)': corpus,
  판정: {
    'V2 고쳐졌나 (① providerTitle non-null)': codexShape.providerTitle === TITLE,
    '① 비용 통과선 (≤2MB · ≤50ms)': codexShape.읽은_바이트 <= TAIL_MAX_BYTES && codexShape.ms <= 50,
    '② 대조군은 확장이 안 돈다': inWindow.읽은_바이트 === TAIL_WINDOW_BYTES && inWindow.providerTitle === TITLE,
    '③ 반례ⓐ 2MB 밖은 여전히 null': beyondCap.providerTitle === null && beyondCap['2MB 상한에 걸렸나'],
    '④ 반례ⓑ 다른 세션 제목은 안 쓴다': alien.providerTitle === null,
    '⑤⑥ 훑기는 파일당 한 번': secondRead.bytes <= TAIL_WINDOW_BYTES,
    '⑦ 제목 유지': sticky.digest.providerTitle === TITLE,
    '⑧ 캐시 비우기': cachedAgain.bytes === 0 && afterClear.bytes > 0,
  },
}

fs.mkdirSync(RAW_DIR, { recursive: true })
fs.writeFileSync(path.join(RAW_DIR, 'a6-aititle-r1.json'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 1))
