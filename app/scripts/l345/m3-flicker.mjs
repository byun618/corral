// T3 (플리커) — 정지 화면에 주기 재생을 20회 이상 반복해 ① 스크롤백 증가 0줄 ② 육안 확인.
//
// ## 최적화를 끄고 잰다
//
// 평시 corral 은 스냅샷이 같으면 프레임을 아예 안 보낸다. 그대로 재면 "재생을 안 해서 0줄" 이
// 나오고 그건 재생 전략을 잰 것이 아니다. 그래서 `CORRAL_FORCE_REPAINT=1` 로 최적화를 끄고
// **정말로 20번 넘게 다시 그린다**.
//
// ## 대조군을 같은 화면에서 함께 돌린다
//
// "0줄" 이 전략 덕분이라는 것을 보이려면 다른 전략이 0 이 아니어야 한다. 같은 스냅샷을
// naive(그냥 이어쓰기) · reset(RIS) 으로 재생해 스크롤백이 어떻게 되는지 나란히 잰다.
// 대조군은 계측 전용 경로(`term-write`)로 넣는다 — 앱은 home 전략만 쓴다.
//
// ## 육안 (관문 ④)
//
// 정지 화면이면 프레임마다 화면이 **픽셀 단위로 같아야** 한다. 그래서 재생 중 연속 스크린샷을
// 찍고 해시를 비교한다. 한 프레임이라도 반쯤 지워진 상태가 잡히면 해시가 갈라진다.
// 판정자가 직접 열어 볼 수 있게 PNG 도 전부 남긴다.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

const paneId = await tidySession()
// 정지 화면 — 시계처럼 스스로 바뀌는 것이 없어야 한다. 프롬프트 줄도 다시 그리지 않는다.
await run(paneId, 'clear; for i in $(seq 1 12); do printf "\\033[3%dm정지 화면 줄 %02d — static line\\033[0m\\n" $((i % 8)) $i; done', {
  settleMs: 1500,
})

const app = await startApp({ name: 'flicker', env: { CORRAL_FORCE_REPAINT: '1' } })
await sleep(1200)
await app.selectPane(paneId)
await sleep(2500)

const before = (await app.dump()).dump
const startFrames = (await app.state()).state.terminal.frames

// --- ① 주기 재생 20회 이상 ------------------------------------------------
// 하트비트가 hot 1000ms / idle 3000ms 다. 25회를 확실히 넘기려면 넉넉히 기다린다.
const shots = []
const hashes = []
const deadline = Date.now() + 80_000
let frames = startFrames
while (Date.now() < deadline) {
  const state = (await app.state()).state.terminal
  frames = state.frames
  if (shots.length < 24) {
    // **터미널 표면만** 찍는다. 창 전체를 찍으면 헤더의 rev 카운터와 목록의 경과 초가
    // 매초 바뀌어 터미널과 무관하게 그림이 달라진다 (첫 측정에서 24장 중 18장이 그래서 달랐다).
    const shot = await app.termShot(`t3-static-${String(shots.length).padStart(2, '0')}`)
    shots.push({ file: shot.file, at: Date.now(), frames })
    hashes.push(crypto.createHash('sha256').update(fs.readFileSync(shot.file)).digest('hex').slice(0, 16))
  }
  if (frames - startFrames >= 25 && shots.length >= 24) break
  await sleep(700)
}

const after = (await app.dump()).dump
const uniqueHashes = [...new Set(hashes)]

const home = {
  replays: frames - startFrames,
  baseYBefore: before.baseY,
  baseYAfter: after.baseY,
  scrollbackGrowth: after.baseY - before.baseY,
  bufferLengthBefore: before.length,
  bufferLengthAfter: after.length,
  shots: shots.map((shot) => shot.file),
  shotHashes: hashes,
  uniqueShotHashes: uniqueHashes.length,
  // 정지 화면인데 스크린샷이 여러 종류면 화면이 흔들린 것이다.
  visuallyStable: uniqueHashes.length === 1,
}
console.log('home', JSON.stringify({ ...home, shots: home.shots.length, shotHashes: undefined }))

// --- ② 대조군 (naive · reset) ---------------------------------------------
// 같은 스냅샷을 다른 전략으로 20회 재생한다. 앱은 이 경로를 쓰지 않는다 — 대조 전용이다.
const snapshot = await request('pane.read', {
  pane_id: paneId,
  source: 'visible',
  format: 'ansi',
  strip_ansi: false,
})
const lines = snapshot.read.text.split(/\r?\n/)
if (lines[lines.length - 1] === '') lines.pop()
const rows = after.rows

const strategies = {
  naive: () => lines.join('\r\n') + '\r\n',
  reset: () => '\x1bc' + lines.join('\r\n'),
}

const contrast = {}
for (const [name, build] of Object.entries(strategies)) {
  // 대조군마다 화면을 처음부터 세운다 (앞 대조군의 잔해를 물려받지 않게).
  await app.selectPane(null)
  await sleep(500)
  await app.selectPane(paneId)
  await sleep(2500)
  const start = (await app.dump()).dump
  for (let i = 0; i < 20; i++) await app.write(build())
  await sleep(400)
  const end = (await app.dump()).dump
  const shot = await app.termShot(`t3-contrast-${name}`)
  contrast[name] = {
    replays: 20,
    baseYBefore: start.baseY,
    baseYAfter: end.baseY,
    scrollbackGrowth: end.baseY - start.baseY,
    shot: shot.file,
  }
  console.log('contrast', name, JSON.stringify(contrast[name]))
}

writeRaw('12-t3-flicker.json', {
  measuredAt: new Date().toISOString(),
  paneId,
  rows,
  note: 'CORRAL_FORCE_REPAINT=1 로 "같으면 안 그린다" 최적화를 끄고 진짜로 다시 그렸다',
  strategy: {
    home: 'CUP 행마다 + 내용 + SGR리셋 + EL, 마지막 행 LF 없음, 끝에 ED0. 전체를 BSU/ESU 로 감싸고 칠하는 동안 autowrap off',
    naive: '(대조) 그냥 줄마다 이어쓰기 + LF',
    reset: '(대조) RIS(ESC c) 후 다시 쓰기',
  },
  home,
  contrast,
})
await app.stop()
process.exit(0)
