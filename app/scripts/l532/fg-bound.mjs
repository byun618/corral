// LIFE-532 최종 관문 R1-03② 바인딩 분기 — CORRAL_SESSION 만(소켓 지름길 없음) + CLI 조회 실패 → 3회 뒤 원인 scan 카드(세션 = 지정 이름).
// 양성 대조: 바인딩이 실제로 걸렸다 — 소켓 지름길이 아니라 CLI 조회가 돌았다(sessions.poll 이 cli/filesystem 폴백 사유를 남김). 사용: node fg-bound.mjs [ROOT=/tmp/l532d]
import fs from 'node:fs'
import { check, fail, finish, Iso, until, waitStreak } from './lib.mjs'

const iso = new Iso(process.argv[2] ?? '/tmp/l532d')
iso.fresh()
const appXdg = `${iso.root}/app-xdg`
fs.mkdirSync(`${appXdg}/herdr`, { recursive: true })
iso.knob('fake-xdg', iso.xdg)
iso.knob('fake-list', 'fail')
try {
  await iso.launch({ label: 'bound', appXdg, extra: { CORRAL_SESSION: 'l532-bound' } })
  for (const n of [1, 2]) {
    const line = await waitStreak(iso, n)
    const dom = await iso.dom()
    console.log(`## streak ${n} at ${line.at} · DOM +${dom.at - line.at}ms: ${JSON.stringify(dom)}`)
    check(`R1-03② streak ${n} 카드 없음`, dom.card, null)
  }
  await waitStreak(iso, 3)
  const dom3 = await until('streak 3 뒤 카드', async () => { const dom = await iso.dom(); return dom.card !== null ? dom : null }, 3_000, 100)
  const state = await iso.state()
  console.log(`## streak 3 DOM: ${JSON.stringify(dom3)}\n## backend: ${JSON.stringify(state.backend)}`)
  check('R1-03② 바인딩 카드', [dom3.card.kind, dom3.card.cause], ['unreachable', 'scan'])
  check('R1-03② 세션 = 지정 이름', state.backend.session, 'l532-bound')
  check('R1-03② 버튼 1개 = 다시 시도', dom3.card.buttons, [{ text: '다시 시도', retry: true, start: false }])
  const poll = iso.lines('sessions.poll').at(-1)
  console.log(`## 마지막 sessions.poll: ${JSON.stringify(poll).slice(0, 400)}`)
  check('R1-03② 지름길 아님 — 폴백 사유가 CLI 실패', [poll.source, String(poll.reason).includes('fake herdr: session list 일부러 실패')], ['filesystem', true])
  check('R1-03② 자동 기동 없음(spawn 0)', iso.lines('herdr.server.spawn').length, 0)
  await iso.shot('fg-bound-scan-card')
} catch (error) {
  fail(`예외: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await iso.quit()
  iso.g7()
}
finish()
