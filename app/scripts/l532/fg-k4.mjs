// LIFE-532 최종 관문 K4 원인 `scan` (ⓐ~ⓓ) — 격리 herdr 루트, 서버 없음 + 가짜 herdr 의 `session list` 실패.
// ⓐ streak 1·2 시점 DOM 카드 없음 (양성 대조: 같은 덤프가 streak 3 뒤 카드를 잡는다) ⓑ 카드 원인·문구·오류 원문·버튼 1개 + 스크린샷
// ⓓ 회복 없이 클릭 → 카드 유지 ⓒ 회복(서버 기동 + 조회 정상) 뒤 클릭 → 카드 걷힘. 사용: node fg-k4.mjs [ROOT=/tmp/l532a]
import fs from 'node:fs'
import { check, fail, finish, Iso, until, waitStreak } from './lib.mjs'

const iso = new Iso(process.argv[2] ?? '/tmp/l532a')
iso.fresh()
iso.makeRepo()
iso.knob('fake-list', 'fail')
// 앱 XDG 는 빈 폴더 — 파일시스템 폴백이 서버 소켓을 찾아 스스로 붙지 않게 한다(회복을 「다시 시도」 클릭이 일으키게). 진짜 herdr 는 fake-xdg 로 실제 루트를 본다.
const appXdg = `${iso.root}/app-xdg`
fs.mkdirSync(`${appXdg}/herdr`, { recursive: true })
iso.knob('fake-xdg', iso.xdg)
try {
  await iso.launch({ label: 'k4', appXdg })
  await iso.addRepo()
  for (const n of [1, 2]) {
    const line = await waitStreak(iso, n)
    const dom = await iso.dom()
    console.log(`## streak ${n} 로그 at ${line.at} · DOM at ${dom.at} (+${dom.at - line.at}ms): ${JSON.stringify(dom)}`)
    check(`K4ⓐ streak ${n} 카드 없음`, dom.card, null)
    check(`K4ⓐ streak ${n} 조회 오류`, line.scan, 'error')
  }
  const third = await waitStreak(iso, 3)
  const dom3 = await until('streak 3 뒤 카드', async () => {
    const dom = await iso.dom()
    return dom.card !== null ? dom : null
  }, 3_000, 100)
  console.log(`## streak 3 로그 at ${third.at} · DOM at ${dom3.at} (+${dom3.at - third.at}ms): ${JSON.stringify(dom3)}`)
  check('K4ⓐ 양성 대조 — 같은 덤프가 streak 3 뒤 카드를 잡는다', dom3.card.kind, 'unreachable')
  check('K4ⓑ 원인', dom3.card.cause, 'scan')
  check('K4ⓑ 제목', dom3.card.title, 'herdr 세션 목록을 읽지 못했습니다')
  check('K4ⓑ 본문 줄', dom3.card.line, '세션 조회가 계속 실패하고 있습니다. 서버가 돌고 있는지 확인할 수 없습니다')
  check('K4ⓑ 오류 원문(가짜 herdr stderr 포함)', dom3.card.error.includes('fake herdr: session list 일부러 실패'), true)
  check('K4ⓑ 버튼 1개 = 다시 시도(data-backend-retry)', dom3.card.buttons, [{ text: '다시 시도', retry: true, start: false }])
  check('K4ⓑ 세션 표시(아직 붙은 세션 없음)', (await iso.state()).backend, { kind: 'unreachable', cause: 'scan', session: null, error: (await iso.state()).backend.error })
  await iso.shot('fg-k4b-scan-card')

  // ⓓ 회복 없이 클릭
  const retriesBefore = iso.lines('backend.retry').length
  const scansBefore = iso.lines('sessions.scan').length
  const click1 = await iso.clickRetry()
  console.log(`## 클릭(회복 없음): ${JSON.stringify(click1)}`)
  check('K4ⓓ 클릭 요소 1개', click1.clicked, true)
  await until('backend.retry 로그', () => iso.lines('backend.retry').length > retriesBefore, 5_000, 100)
  const retryLine = iso.lines('backend.retry').at(-1)
  console.log(`## backend.retry: ${JSON.stringify(retryLine)}`)
  check('K4ⓓ backend.retry 원인', retryLine.cause, 'scan')
  await until('클릭 뒤 조회 1회', () => iso.lines('sessions.scan').length > scansBefore, 5_000, 100)
  const afterScan = iso.lines('sessions.scan').at(-1)
  console.log(`## 클릭 뒤 조회: ${JSON.stringify(afterScan)} (클릭 뒤 ${afterScan.at - click1.at}ms)`)
  const domD = await iso.dom()
  console.log(`## ⓓ DOM: ${JSON.stringify(domD)}`)
  check('K4ⓓ 회복 없이 클릭 → 카드 유지', domD.card?.kind ?? null, 'unreachable')
  check('K4ⓓ 빈 화면 아님(카드·버튼)', domD.card?.buttons.length ?? 0, 1)
  check('K4ⓓ 계수는 계속 오른다', afterScan.streak > 3, true)

  // ⓒ 회복 뒤 클릭
  await iso.startServer()
  iso.knob('fake-list', 'pass')
  const retries2 = iso.lines('backend.retry').length
  const click2 = await iso.clickRetry()
  console.log(`## 클릭(회복 뒤): ${JSON.stringify(click2)}`)
  check('K4ⓒ 클릭 요소 1개', click2.clicked, true)
  await until('backend.retry 로그(2)', () => iso.lines('backend.retry').length > retries2, 5_000, 100)
  const cleared = await until('카드 걷힘', async () => {
    const dom = await iso.dom()
    return dom.card === null ? dom : null
  }, 10_000, 100)
  const resetLine = iso.lines('sessions.scan').find((line) => line.streak === 0)
  console.log(`## 걷힘 DOM (클릭 뒤 ${cleared.at - click2.at}ms): ${JSON.stringify(cleared)} · 계수 0 로그: ${JSON.stringify(resetLine)}`)
  check('K4ⓒ 계수 0 으로 돌아온 로그 1줄', resetLine?.scan ?? null, 'ok')
  check('K4ⓒ 걷힘이 클릭 뒤 3초(조회 주기) 안', cleared.at - click2.at < 3_000, true)
  const live = await until('링크 live', async () => ((await iso.state()).link.phase === 'live' ? await iso.state() : null), 20_000)
  check('K4ⓒ 걷힌 뒤 backend', live.backend, { kind: 'ok' })
  const scanLinesAfter = iso.lines('sessions.scan').length
  await new Promise((resolve) => setTimeout(resolve, 7_000))
  check('F7 회복 뒤 평시 7초 sessions.scan 추가 0줄', iso.lines('sessions.scan').length - scanLinesAfter, 0)
  console.log(`## sessions.scan 전부(양성 대조 — 이 grep 이 줄을 잡는다): ${iso.lines('sessions.scan').length}줄`)
  for (const line of iso.lines('sessions.scan')) console.log(JSON.stringify(line))
  console.log('## backend.status 전이')
  for (const line of iso.lines('backend.status')) console.log(JSON.stringify(line).slice(0, 300))
  await iso.shot('fg-k4c-cleared')
} catch (error) {
  fail(`예외: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await iso.quit()
  iso.g7()
  iso.stopServer()
}
finish()
