// S5 — half-open: 중계를 얼려(close 없음) 서버 응답을 끊고, 당겨서 새로고침을 2초마다 하며 「재연결 중」 까지의 시간을 잰다(E7 ≤ 20초).
// 이어서 띠(3초 유예 뒤)·끊김(20초)·D3 를 캡처하고, 풀면 사용자 조작 없이 연결됨까지의 시간을 잰다.
// 사용: node halfopen.mjs <relay 상태 파일> <캡처 폴더>
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
const [stateFile, shots] = process.argv.slice(2)
const emu = (...args) => execFileSync('node', [new URL('./emu.mjs', import.meta.url).pathname, ...args]).toString().trim()
const texts = () => emu('texts')
const setFrozen = (frozen) => {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, frozen }))
}
const log = (event, detail = {}) => console.log(JSON.stringify({ at: Date.now(), event, ...detail }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const swipe = () => execFileSync('adb', ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '540', '700', '540', '1600', '300'])

if (!texts().includes('· 연결됨')) throw new Error('시작 상태가 연결됨이 아니다')
const frozenAt = Date.now()
setFrozen(true)
log('freeze')
let detectedAt = null
let lastSwipe = 0
while (detectedAt === null && Date.now() - frozenAt < 40_000) {
  if (Date.now() - lastSwipe >= 2_000) {
    swipe()
    lastSwipe = Date.now()
    log('pull_refresh')
  }
  const screen = texts()
  if (!screen.includes('· 연결됨')) {
    detectedAt = Date.now()
    log('not_connected', { afterMs: detectedAt - frozenAt, status: screen.split('\n').find((line) => line.includes(' · ')) ?? null })
  }
  await sleep(200)
}
log('half_open_detect', { ms: detectedAt === null ? null : detectedAt - frozenAt, limitMs: 20_000, pass: detectedAt !== null && detectedAt - frozenAt <= 20_000 })
// 3초 유예: 상태 바뀐 직후 1초 = 띠 없음, 4초 뒤 = 띠
await sleep(1_000)
log('screen_1s', { band: texts().includes('재연결 중 ·') })
emu('shot', `${shots}/e-reconnecting-under-3s.png`)
await sleep(3_000)
log('screen_4s', { band: texts().includes('재연결 중 ·') })
emu('shot', `${shots}/e-reconnecting-band.png`)
// 끊김(20초 넘게 실패)
const offline = Date.now()
for (;;) {
  const screen = texts()
  if (screen.includes('끊김 ·')) {
    log('offline_band', { afterFreezeMs: Date.now() - frozenAt, reconnectButton: screen.includes('다시 연결'), line: screen.split('\n').find((line) => line.includes('끊김 ·')) })
    break
  }
  if (Date.now() - offline > 40_000) {
    log('offline_band_timeout')
    break
  }
  await sleep(500)
}
emu('shot', `${shots}/e-offline-band.png`)
emu('tap', '설정')
await sleep(1_500)
log('d3', { state: texts().split('\n').filter((line) => /끊김|재연결|상태/.test(line)) })
emu('shot', `${shots}/d3-settings-offline.png`)
execFileSync('adb', ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_BACK'])
await sleep(1_000)
// 풀기 — 사용자 조작 없이 연결됨까지
const thawAt = Date.now()
setFrozen(false)
log('thaw')
let backAt = null
while (backAt === null && Date.now() - thawAt < 40_000) {
  if (texts().includes('· 연결됨')) backAt = Date.now()
  else await sleep(250)
}
log('recovered', { msAfterThaw: backAt === null ? null : backAt - thawAt, backoffCapMs: 15_000 })
emu('shot', `${shots}/e-recovered-connected.png`)
