// S5b — 띠 3초 유예(E7·디자인 Q10): 중계를 얼리고 당겨서 새로고침 1회 → 앱 기록에 reconnect_wait 가 찍히는 순간을 logcat 스트림으로 잡아
// +0.5초·+1.5초·+4.5초에 화면을 찍는다(screencap 먼저, 가림은 뒤). 띠 글자 「재연결 중 ·」 유무는 각 캡처 직후 덤프로도 본다.
// 사용: node grace.mjs <relay 상태 파일> <캡처 폴더>
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
const [stateFile, shots] = process.argv.slice(2)
const emu = (...args) => execFileSync('node', [new URL('./emu.mjs', import.meta.url).pathname, ...args]).toString().trim()
const setFrozen = (frozen) => fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), frozen }))
const log = (event, detail = {}) => console.log(JSON.stringify({ at: Date.now(), event, ...detail }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
if (!emu('texts').includes('· 연결됨')) throw new Error('시작 상태가 연결됨이 아니다')
execFileSync('adb', ['-s', 'emulator-5554', 'logcat', '-c'])
const cat = spawn('adb', ['-s', 'emulator-5554', 'logcat', '-s', 'ReactNativeJS'])
const seen = new Promise((resolve) => cat.stdout.on('data', (chunk) => { if (chunk.toString().includes('"reconnect_wait"')) resolve(Date.now()) }))
setFrozen(true)
log('freeze')
execFileSync('adb', ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '540', '700', '540', '1600', '300'])
log('pull_refresh')
const t0 = await seen
log('reconnect_wait_seen')
for (const [offset, name] of [[500, 'e-grace-0.5s'], [1_500, 'e-grace-1.5s'], [4_500, 'e-grace-4.5s']]) {
  const wait = t0 + offset - Date.now()
  if (wait > 0) await sleep(wait)
  const shotAt = Date.now()
  emu('shot', `${shots}/${name}.png`)
  log('shot', { name, msAfterReconnecting: shotAt - t0, bandTextNow: emu('texts').includes('재연결 중 ·') })
}
cat.kill()
setFrozen(false)
log('thaw')
const thawAt = Date.now()
for (;;) {
  if (emu('texts').includes('· 연결됨')) { log('recovered', { msAfterThaw: Date.now() - thawAt }); break }
  if (Date.now() - thawAt > 40_000) { log('recover_timeout'); break }
  await sleep(250)
}
