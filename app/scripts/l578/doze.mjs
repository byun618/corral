// S6 — P6ⓑ 복귀 프로브: 앱 백그라운드 ≥ 60초(Doze force-idle 포함) 뒤 복귀 → 연결됨까지 시간(격리 ≤ 5초).
// 시각 근거 둘: ① 앱 기록(logcat)의 resume → probe_ok/hello_ok ② 호스트에서 am start 순간 → 화면 「· 연결됨」(덤프 지연 ~1–2초 포함, 보수적).
// 사용: node doze.mjs <백그라운드 ms>
import { execFileSync, spawn } from 'node:child_process'
const awayMs = Number(process.argv[2] ?? 65_000)
const doze = process.argv[3] !== 'nodoze' // nodoze = 앱 전환만(망 유지) — 복귀 프로브 경로
const adb = (...args) => execFileSync('adb', ['-s', 'emulator-5554', ...args]).toString().trim()
const emu = (...args) => execFileSync('node', [new URL('./emu.mjs', import.meta.url).pathname, ...args]).toString().trim()
const log = (event, detail = {}) => console.log(JSON.stringify({ at: Date.now(), event, ...detail }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
if (!emu('texts').includes('· 연결됨')) throw new Error('시작 상태가 연결됨이 아니다')
adb('logcat', '-c')
const lines = []
const cat = spawn('adb', ['-s', 'emulator-5554', 'logcat', '-v', 'epoch', '-s', 'ReactNativeJS'])
cat.stdout.on('data', (chunk) => { for (const line of chunk.toString().split('\n')) if (line.includes('corral-conn')) lines.push(line) })
adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
log('home_pressed')
await sleep(1_000)
if (doze) {
  log('battery_unplug', { out: adb('shell', 'dumpsys', 'battery', 'unplug') })
  log('force_idle', { out: adb('shell', 'dumpsys', 'deviceidle', 'force-idle') })
  log('idle_state', { out: adb('shell', 'dumpsys', 'deviceidle', 'get', 'deep') })
}
await sleep(awayMs)
if (doze) {
  log('idle_state_before_exit', { out: adb('shell', 'dumpsys', 'deviceidle', 'get', 'deep') })
  log('unforce', { out: adb('shell', 'dumpsys', 'deviceidle', 'unforce') })
  log('battery_reset', { out: adb('shell', 'dumpsys', 'battery', 'reset') })
}
const resumeAt = Date.now()
adb('shell', 'am', 'start', '-n', 'io.github.byun618.corral.mobile.dev/.MainActivity')
log('app_front')
let uiAt = null
while (uiAt === null && Date.now() - resumeAt < 30_000) {
  if (emu('texts').includes('· 연결됨')) uiAt = Date.now()
  else await sleep(100)
}
await sleep(1_500)
cat.kill()
const events = lines.map((line) => { try { return JSON.parse(line.slice(line.indexOf('{'))) } catch { return null } }).filter(Boolean)
const resume = events.find((event) => event.event === 'resume')
const ok = events.find((event) => resume && Date.parse(event.at) >= Date.parse(resume.at) && (event.event === 'probe_ok' || event.event === 'hello_ok'))
const appMs = resume && ok ? Date.parse(ok.at) - Date.parse(resume.at) : null
log('result', { awayMsActual: resume?.awayMs ?? null, appResumeToConnectedMs: appMs, hostFrontToUiConnectedMs: uiAt === null ? null : uiAt - resumeAt, limitMs: 5_000, pass: appMs !== null && appMs <= 5_000 && uiAt !== null && uiAt - resumeAt <= 5_000 })
for (const event of events) console.log('  conn', JSON.stringify(event))
