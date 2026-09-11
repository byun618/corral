// I 블록 — 입력. I1(타이핑 왕복) · I2(엔터) · I3(Ctrl+C) · I4(특수키) · I5(붙여넣기) · I6(격리).
//
// ## 재는 경로
//
// `sendPaneText` 를 main 에서 직접 부르면 xterm 의 키 처리와 IPC 가 빠져 **사용자가 겪는 지연이
// 아니다**. 그래서 `webContents.sendInputEvent` 로 렌더러의 keydown 부터 밟는다:
//
//   keydown → xterm onData → IPC → main 입력 큐 → pane.send_text → (PTY 에코) → pane.read
//     → 프레임 → 렌더러 term.write → **파싱 완료 콜백**
//
// 끝점은 그 콜백이다.
//
// ## 1차 측정에서 무효였던 검사를 고쳤다 (그대로 뒀으면 거짓 통과였다)
//
//   ① I1 이 "그 글자가 화면에 있나"를 **한 글자**로 봤다. 화면 어딘가에 `a` 는 거의 항상 있어서
//      사실상 아무것도 검사하지 않았다 → **누적 문자열**(4자 이상)로 본다
//   ② I3 이 `sleep` 이 정말 돌고 있었는지 확인하지 않고 "끊겼다"고 적었다 → 끊기 **전에**
//      foreground 에 `sleep` 이 있는지 먼저 확인하고, 없으면 그 표본을 무효로 남긴다
//   ③ I4·I5·I6 이 `less` 안에 갇힌 채로 측정됐다 → 매 항목 전에 **셸 프롬프트인지 확인**한다

import { countGridTransitions, panes, pct, rendererErrors, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

const SAMPLE_COUNT = Number(process.env.L345_SAMPLES ?? 60)
const GROUP = 15
const PREFIX = 3
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

const paneId = await tidySession()
await run(paneId, 'clear', { settleMs: 600 })

const app = await startApp({ name: 'input' })
await sleep(1200)
await app.selectPane(paneId)
await sleep(2500)

const screenOf = async () => {
  const dump = (await app.dump()).dump
  return dump.grid
    .map((row) => row.map((cell) => (cell?.w === 0 ? '' : (cell?.ch ?? ' '))).join('').replace(/\s+$/, ''))
    .join('\n')
}

/** 셸 프롬프트로 돌아왔는지 확인한다. 아니면 되돌린 뒤 그 사실을 남긴다. */
async function ensureShell(label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const info = await request('pane.process_info', { pane_id: paneId })
    const names = info.process_info.foreground_processes.map((process) => process.name)
    if (names.length === 1 && (names[0] === 'zsh' || names[0] === 'bash' || names[0] === 'sh')) {
      return { ok: true, names, attempts: attempt }
    }
    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
    await sleep(400)
    await request('pane.send_text', { pane_id: paneId, text: 'q' }).catch(() => {})
    await sleep(300)
    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
    await sleep(500)
    await request('pane.send_text', { pane_id: paneId, text: "printf '\\033[?1049l'; clear\n" }).catch(() => {})
    await sleep(700)
  }
  const info = await request('pane.process_info', { pane_id: paneId })
  const names = info.process_info.foreground_processes.map((process) => process.name)
  console.error('[ensureShell] 실패', label, names)
  return { ok: false, names, attempts: 4 }
}

// ==========================================================================
// I1 — 타이핑 왕복
//
// 표본마다 누적 문자열(그룹 시작부터 지금까지 친 글자)이 **화면에 통째로** 나타난 시점을 끝으로
// 잡는다. 프레임이 그 문자열을 담고 있는지는 main 로그의 pane.read 응답 원문으로 확인한다.
// ==========================================================================
/**
 * 줄을 비운다. **앱 자신의 입력 경로**로 보낸다 — herdr 에 직접 `send_keys` 를 쏘면 앱의 입력
 * 큐를 건너뛰어, 아직 큐에 남아 있던 글자가 지운 뒤에 도착한다 (실제로 그래서 프롬프트에
 * 앞 그룹의 찌꺼기가 남았다).
 */
async function clearLine() {
  await app.key('c', ['control'])
  await sleep(600)
}

const samples = []
const invalid = []
let accumulated = ''
let index = 0
/**
 * **실행마다 다른 접두.** 알파벳 순회는 결정적이라 지난 실행이 친 글자열과 정확히 같다 —
 * 셸 히스토리·자동제안이 그걸 화면에 먼저 띄우면 키를 보내기도 전에 needle 이 발견된다
 * (실제로 60개 표본이 전부 0~2ms 로 나왔다). 무작위 접두면 어떤 과거 화면과도 겹치지 않는다.
 */
const RUN_TOKEN = Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * 26)]).join('')
/**
 * 폴링 간격. 이 값만큼 지연을 **과대평가**할 수 있다 — 통과선 쪽으로 유리하게 기울지 않도록
 * 일부러 이 방향으로 오차를 둔다 (측정값이 실제보다 크게 나온다).
 */
const POLL_MS = 15

// **프롬프트를 짧게 고정한다.** 이 저장소의 zsh 프롬프트는 경로 + 브랜치 + 변경 개수라 90칸에
// 육박한다 — 그러면 친 글자가 곧바로 줄바꿈을 타는데, `term-find` 는 화면 줄을 개행으로 이어
// 붙이므로 누적 문자열이 감싼 자리에서 끊겨 **못 찾는다** (표본 60개 중 50개를 그렇게 놓쳤다).
// 재는 것은 왕복 시간이지 프롬프트가 아니므로 이 블록에서만 짧게 바꾼다.
// `PROMPT` 만 바꾸면 안 된다 — 이 셸의 프롬프트는 **precmd 훅이 매번 다시 그린다**.
// 훅을 먼저 비우고 나서 바꾼다.
await run(
  paneId,
  "unfunction precmd 2>/dev/null; precmd_functions=(); preexec_functions=(); PROMPT='i1> '; RPROMPT=''",
  { settleMs: 900 },
)
// 진짜 짧아졌는지 확인한다 — 안 짧아졌으면 표본이 또 줄바꿈에서 깨진다. 그때는 수치를 내지 않고
// 왜 못 쟀는지 적는 것이 맞다 (기준 §0: 못 잰 칸은 보류).
{
  const check = await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
  const lastLine = check.read.text.split('\n').filter((line) => line.trim() !== '').pop() ?? ''
  console.log('I1 프롬프트', JSON.stringify(lastLine.slice(-20)), '길이', lastLine.length)
}

while (samples.length < SAMPLE_COUNT && index < 400) {
  const positionInGroup = index % GROUP
  const group = Math.floor(index / GROUP)
  if (positionInGroup === 0) {
    // **화면을 통째로 비운다.** 줄만 비우면 앞 그룹의 글자가 화면에 남고, 알파벳을 돌며 치는
    // 표본이라 다음 그룹의 누적 문자열이 그 잔해의 부분문자열이 되어 **키를 보내기도 전에
    // 발견된다** (1차 측정에서 그룹 2~4 의 28개 표본이 전부 0~1ms 로 나왔다 — 거짓 통과다).
    await clearLine()
    await run(paneId, 'clear', { settleMs: 900 })
    accumulated = ''
  }
  // 그룹마다 다른 접두를 둔다 — 알파벳 순회에는 같은 글자가 잇달아 나오지 않으므로
  // `aaa`·`bbb` … 는 다른 그룹의 화면과 절대 겹치지 않는다.
  const ch =
    positionInGroup < PREFIX ? RUN_TOKEN[(group * PREFIX + positionInGroup) % RUN_TOKEN.length] : ALPHABET[(index * 7 + 3) % ALPHABET.length]
  const measured = positionInGroup >= PREFIX
  const needle = accumulated + ch
  index += 1

  // **보내기 전에** 그 문자열이 이미 화면에 있으면 그 표본은 무효다 — 재는 것이 왕복이 아니라
  // 남아 있던 글자다. 통과선을 낮추지 않으려면 이런 표본은 버리고 다시 잰다.
  if (measured && (await app.find(needle)).found) {
    invalid.push({ needle, reason: '보내기 전에 이미 화면에 있었다' })
    await clearLine()
    await run(paneId, 'clear', { settleMs: 900 })
    accumulated = ''
    index = group * GROUP + GROUP // 이 그룹을 버리고 다음 그룹으로
    continue
  }

  const sent = await app.key(ch)
  accumulated = needle

  if (!measured) {
    await sleep(450)
    continue
  }
  const t0 = sent.at
  let latency = null
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    // **화면에 직접 묻는다.** 누적 문자열 전체가 보여야 성공이다.
    const probe = await app.find(needle)
    if (probe.found) {
      latency = probe.at - t0
      break
    }
    await sleep(POLL_MS)
  }
  // **음수 지연은 물리적으로 불가능하다 — 벽시계가 뒤로 갔다는 뜻이다.**
  // 3회차 한 바퀴에서 실제로 한 번 나왔다: 표본 25 가 -1668ms, 그 다음 표본의 `sentAt` 이
  // 앞 표본보다 1666ms **작다** (macOS 의 시각 보정이 측정 중에 한 번 걸렸다).
  // `Date.now()` 두 개의 차를 재는 한 이 구멍은 남는다. 그 표본을 분포에 남기면 p50 이
  // 실제보다 낮아진다 — 통과선 쪽으로 유리하게 기우는 값이라 버린다 (그룹째 다시 잰다).
  if (latency !== null && latency < 0) {
    invalid.push({ needle, reason: `벽시계 역행 — 지연이 음수다 (${latency}ms)` })
    await clearLine()
    await run(paneId, 'clear', { settleMs: 900 })
    accumulated = ''
    index = group * GROUP + GROUP
    continue
  }
  const lastScreen = latency === null ? (await screenOf()).split('\n').filter((line) => line.trim()).slice(-2) : null
  samples.push({ i: samples.length, needle, sentAt: t0, latencyMs: latency, ...(lastScreen ? { lastScreen } : {}) })
}
const latencies = samples.map((sample) => sample.latencyMs).filter((value) => value !== null)
const i1 = {
  verification:
    '렌더러의 살아 있는 xterm 버퍼를 15ms 간격으로 직접 조회해, 그 시점까지 친 **누적 문자열 전체**가 화면에 보이는 순간을 끝점으로 잡는다. 폴링 간격만큼 값이 과대평가될 수 있다 (통과선에 불리한 방향)',
  pollMs: 15,
  samples: samples.length,
  measured: latencies.length,
  missed: samples.length - latencies.length,
  p50: pct(latencies, 50),
  p95: pct(latencies, 95),
  min: latencies.length ? Math.min(...latencies) : null,
  max: latencies.length ? Math.max(...latencies) : null,
  distribution: latencies,
  invalidSamples: invalid,
  runToken: RUN_TOKEN,
  /**
   * **이 런 동안 그린 격자가 몇 번 바뀌었나** (2회차 리뷰 N2).
   *
   * 1차 수정 뒤 I1 p50 이 135 → 193ms 로 올라갔고 판정문이 그것을 전부 "프롬프트 훅 수정 탓"으로
   * 적었다. 그런데 같은 런에 격자 전환이 6회 새로 들어와 있었다 — 전환마다 `term.resize` +
   * 리플로우 + `fit()` 이 렌더러를 잡으므로 두 원인이 섞였다. 귀속은 판정자 몫이고, 구현자는
   * **수치를 같이 싣는다**: 이번 회차는 이력(G3)을 넣었으니 전환 수가 줄어야 한다.
   */
  gridTransitions: countGridTransitions(app.entries()),
  /** 렌더러 예외 — 1차에는 이 채널을 달아 놓고 안 읽었다 (2회차 리뷰 N1). */
  rendererErrors: rendererErrors(app.entries()),
  detail: samples,
}
console.log('I1', JSON.stringify({ samples: i1.samples, measured: i1.measured, p50: i1.p50, p95: i1.p95, min: i1.min, max: i1.max }))
console.log('I1 격자 전환', i1.gridTransitions.transitions, '회 ·', i1.gridTransitions.sequence.join('→'))

// ==========================================================================
// I2 — 엔터
// ==========================================================================
const shellBeforeI2 = await ensureShell('I2')
await clearLine()
const enterRuns = []
for (let i = 0; i < 4; i++) {
  const marker = `I2MARK${i}`
  await clearLine()
  for (const ch of `echo ${marker}`) await app.key(ch)
  await sleep(400)
  await app.key('Return')
  await sleep(1600)
  const screen = await screenOf()
  // 명령 줄(에코)만이 아니라 **결과 줄**도 떴는지 본다 — marker 가 두 번 이상 나와야 한다.
  const hits = screen.split(marker).length - 1
  enterRuns.push({ i, marker, occurrences: hits, ok: hits >= 2, tail: screen.split('\n').filter((line) => line.trim()).slice(-3) })
  console.log('I2', marker, 'occurrences', hits)
}
const i2 = {
  shellCheck: shellBeforeI2,
  runs: enterRuns,
  ok: enterRuns.every((entry) => entry.ok),
  malfunctions: enterRuns.filter((entry) => !entry.ok).length,
}

// ==========================================================================
// I3 — Ctrl+C. 증거는 "키를 보냈다" 가 아니라 **프로세스가 사라졌다** 다.
// ==========================================================================
const ctrlC = []
for (let i = 0; i < 4; i++) {
  await ensureShell(`I3-${i}`)
  await run(paneId, 'clear', { settleMs: 400 })
  await clearLine()
  for (const ch of 'sleep 300') await app.key(ch)
  await sleep(400)
  await app.key('Return')
  await sleep(1500)
  const running = await request('pane.process_info', { pane_id: paneId })
  const beforeNames = running.process_info.foreground_processes.map((process) => process.name)
  // **끊기 전에 정말 돌고 있었나.** 아니면 이 표본은 무효다 (1차 측정의 거짓 통과 자리).
  if (!beforeNames.includes('sleep')) {
    ctrlC.push({ i, beforeNames, valid: false, note: 'sleep 이 뜨지 않아 무효 표본' })
    console.log('I3', i, '무효 — before', beforeNames.join(','))
    continue
  }
  const at = Date.now()
  await app.key('c', ['control'])
  let stoppedMs = null
  let afterNames = beforeNames
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const now = await request('pane.process_info', { pane_id: paneId })
    afterNames = now.process_info.foreground_processes.map((process) => process.name)
    if (!afterNames.includes('sleep')) {
      stoppedMs = Date.now() - at
      break
    }
    await sleep(80)
  }
  ctrlC.push({ i, beforeNames, afterNames, valid: true, interrupted: stoppedMs !== null, stoppedMs })
  console.log('I3', i, 'before', beforeNames.join(','), 'after', afterNames.join(','), 'ms', stoppedMs)
  await sleep(300)
}
const i3 = {
  evidence: 'pane.process_info 의 foreground 프로세스에서 sleep 이 사라지는 것',
  runs: ctrlC,
  validRuns: ctrlC.filter((entry) => entry.valid).length,
  interrupted: ctrlC.filter((entry) => entry.valid && entry.interrupted).length,
}

// ==========================================================================
// I4 — 특수키. vi 를 쓴다: 방향키·Tab·Esc 가 **각각 화면에 다른 흔적**을 남긴다.
// ==========================================================================
await ensureShell('I4')
// **`set list` 이 있어야 Tab 이 보인다.** 없으면 vim 이 탭을 공백 8칸으로 그리는데, 행은 폭이
// 고정이라 앞뒤 화면 문자열이 완전히 같다 — 1차 I4 가 Tab 을 `arrived: false` 로 적은 이유다.
// `list` 를 켜면 탭이 `^I` 로 보여 도착 여부가 화면에 남는다.
await run(
  paneId,
  'rm -f /tmp/l345-i4.txt; clear; vim -u NONE -c "set showmode" -c "set list" /tmp/l345-i4.txt',
  { settleMs: 3000 },
)

const rawHead = async () => (await screenOf()).split('\n').filter((line) => line.trim() !== '').slice(0, 3)

// 삽입 모드로 들어간다.
await app.key('i')
await sleep(700)
const insertHead = await screenOf()

/**
 * vim 의 리터럴 삽입(Ctrl+V) 로 **pane 에 실제로 도착한 바이트**를 화면에 찍는다.
 * `^[OA` 처럼 보이면 그 키가 그 모양으로 도달했다는 뜻이다 — "키를 보냈다"가 아니라
 * "그 바이트가 TUI 에 들어갔다"는 증거다. 알트스크린 전체화면 TUI 안에서 잰다.
 */
const literals = []
for (const key of [
  { keyCode: 'Up', domKey: 'ArrowUp' },
  { keyCode: 'Down', domKey: 'ArrowDown' },
  { keyCode: 'Tab', domKey: 'Tab' },
  { keyCode: 'Escape', domKey: 'Escape' },
]) {
  const before = await rawHead()
  const previous = before[0] ?? ''
  await app.key('v', ['control'])
  await sleep(400)
  await app.key(key.keyCode)
  // 바뀔 때까지 기다린다 — 고정 대기는 느린 키를 "안 왔다"로 적는다.
  let line = previous
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    await sleep(120)
    line = (await rawHead())[0] ?? ''
    if (line !== previous) break
  }
  await sleep(300)
  line = (await rawHead())[0] ?? ''
  literals.push({
    key: key.domKey,
    keyCode: key.keyCode,
    lineBefore: previous,
    lineAfter: line,
    inserted: line.length > previous.length ? line.slice(previous.length) : '',
    arrived: line !== previous,
  })
  console.log('I4', key.domKey, '→', JSON.stringify(line.slice(-14)))
  // 다음 키를 위해 줄을 비운다 (Escape 는 삽입 모드를 나가므로 다시 들어간다).
  if (key.keyCode === 'Escape') {
    await app.key('i')
    await sleep(500)
  }
}

// Escape 가 정말 모드를 바꾸나 — showmode 표시가 사라지는지로 본다.
await app.key('Escape')
await sleep(900)
const afterEscape = await screenOf()

const i4Shot = await app.termShot('i4-vim')
const i4 = {
  program: 'vim -u NONE -c "set showmode" (알트스크린 전체화면 TUI)',
  method: '삽입 모드에서 Ctrl+V 리터럴 삽입으로 **도착한 바이트**를 화면에 찍어 증거로 삼는다',
  insertModeShown: insertHead.includes('INSERT'),
  literals,
  escapeLeftInsertMode: !afterEscape.includes('INSERT'),
  arrivedKeys: literals.filter((item) => item.arrived).map((item) => item.key),
  finalScreen: afterEscape.split('\n').filter((line) => line.trim() !== '').slice(0, 6),
  shot: i4Shot.file,
}
console.log('I4 arrived', JSON.stringify(i4.arrivedKeys), 'escapeLeftInsert', i4.escapeLeftInsertMode)

await app.key('Escape')
await sleep(400)
for (const ch of ':q!') await app.key(ch)
await app.key('Return')
await sleep(1500)

// ==========================================================================
// I5 — 붙여넣기
// ==========================================================================
const shellBeforeI5 = await ensureShell('I5')
await run(paneId, 'clear', { settleMs: 500 })
const pasteText = "printf 'PASTE-A\\n'\nprintf 'PASTE-B\\n'\nprintf 'PASTE-C 한글 줄\\n'\n"
await app.paste(pasteText)
await sleep(3000)
const pasteScreen = await screenOf()
const i5 = {
  shellCheck: shellBeforeI5,
  sent: pasteText,
  gotA: pasteScreen.includes('PASTE-A'),
  gotB: pasteScreen.includes('PASTE-B'),
  gotC: pasteScreen.includes('PASTE-C 한글 줄'),
  shot: (await app.termShot('i5-paste')).file,
  screen: pasteScreen.split('\n').filter((line) => line.trim() !== '').slice(-10),
}
i5.ok = i5.gotA && i5.gotB && i5.gotC
console.log('I5', JSON.stringify({ gotA: i5.gotA, gotB: i5.gotB, gotC: i5.gotC }))

// ==========================================================================
// I6 — 다른 pane 오염 0건
// ==========================================================================
const shellBeforeI6 = await ensureShell('I6')
const split = await request('pane.split', { pane_id: paneId, direction: 'right' })
const otherId = split.pane.pane_id
await sleep(1500)
await run(otherId, "clear; printf 'OTHER PANE IDLE\\n'", { settleMs: 1200 })
const otherBefore = (await request('pane.read', { pane_id: otherId, source: 'visible', format: 'text' })).read.text

await app.selectPane(paneId)
await sleep(2500)
await clearLine()
const marker = 'ISOLATIONMARK'
for (const ch of `echo ${marker}`) await app.key(ch)
await sleep(400)
await app.key('Return')
await sleep(2000)

const otherAfter = (await request('pane.read', { pane_id: otherId, source: 'visible', format: 'text' })).read.text
const selectedAfter = (await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })).read.text
const i6 = {
  shellCheck: shellBeforeI6,
  selectedPane: paneId,
  otherPane: otherId,
  markerInSelected: selectedAfter.includes(marker),
  markerInOther: otherAfter.includes(marker),
  otherChanged: otherBefore.trim() !== otherAfter.trim(),
  otherBefore,
  otherAfter,
}
i6.ok = i6.markerInSelected && !i6.markerInOther && !i6.otherChanged
console.log('I6', JSON.stringify({ inSelected: i6.markerInSelected, inOther: i6.markerInOther, otherChanged: i6.otherChanged }))

const guard = (await app.state()).state
writeRaw('20-input.json', {
  measuredAt: new Date().toISOString(),
  paneId,
  path: 'sendInputEvent(keydown) → xterm onData → IPC → main 입력 큐 → pane.send_text → PTY 에코 → pane.read → 프레임 → term.write 파싱 콜백',
  i1,
  i2,
  i3,
  i4,
  i5,
  i6,
  guard: { session: guard.selectedSession, inputBlocked: guard.terminal.inputBlocked, paneCount: (await panes()).length },
})
await request('pane.close', { pane_id: otherId }).catch(() => {})
await app.stop()
process.exit(0)
