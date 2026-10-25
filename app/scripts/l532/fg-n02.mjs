// LIFE-532 최종 관문 N-02 — 앱 XDG 의 herdr/sessions 폴더 mode 000 + CLI 조회 실패 → 폴백이 EACCES 를 조회 오류로 돌려주고 3회 뒤 원인 scan 카드.
// 회차 끝에 권한 원복을 확인한다. 사용: node fg-n02.mjs [ROOT=/tmp/l532b]
import fs from 'node:fs'
import { check, fail, finish, Iso, until, waitStreak } from './lib.mjs'

const iso = new Iso(process.argv[2] ?? '/tmp/l532b')
iso.fresh()
const sessionsDir = `${iso.xdg}/herdr/sessions`
fs.mkdirSync(sessionsDir, { recursive: true })
fs.chmodSync(sessionsDir, 0o000)
console.log(`## ${sessionsDir} mode ${(fs.statSync(sessionsDir).mode & 0o777).toString(8)}`)
let readable = true
try { fs.readdirSync(sessionsDir) } catch (error) { readable = false; console.log(`## 양성 대조 — 하네스도 못 읽는다: ${String(error)}`) }
check('N-02 sessions 폴더 읽기 불가(하네스 확인)', readable, false)
iso.knob('fake-list', 'fail')
try {
  await iso.launch({ label: 'n02' })
  for (const n of [1, 2]) {
    const line = await waitStreak(iso, n)
    const dom = await iso.dom()
    console.log(`## streak ${n} at ${line.at} · DOM +${dom.at - line.at}ms: ${JSON.stringify(dom)}`)
    check(`N-02 streak ${n} 카드 없음`, dom.card, null)
  }
  const third = await waitStreak(iso, 3)
  const dom3 = await until('streak 3 뒤 카드', async () => { const dom = await iso.dom(); return dom.card !== null ? dom : null }, 3_000, 100)
  console.log(`## streak 3 at ${third.at} · DOM +${dom3.at - third.at}ms: ${JSON.stringify(dom3)}`)
  check('N-02 카드', [dom3.card.kind, dom3.card.cause], ['unreachable', 'scan'])
  check('N-02 오류 원문에 EACCES', dom3.card.error.includes('EACCES'), true)
  check('N-02 오류 원문에 폴더 읽기 실패 문구', dom3.card.error.includes('세션 폴더를 읽지 못했다'), true)
  check('N-02 main.unhandled_rejection 0줄', iso.lines('main.unhandled_rejection').length, 0)
  await iso.shot('fg-n02-eacces-card')
} catch (error) {
  fail(`예외: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await iso.quit()
  iso.g7()
  fs.chmodSync(sessionsDir, 0o755)
  console.log(`## 권한 원복: mode ${(fs.statSync(sessionsDir).mode & 0o777).toString(8)} · 읽기 ${fs.readdirSync(sessionsDir).length}개 항목`)
  check('N-02 권한 원복', (fs.statSync(sessionsDir).mode & 0o777).toString(8), '755')
}
finish()
