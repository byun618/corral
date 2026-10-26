// LIFE-532 최종 관문 K5 원인 `link` — 세션 running(조회 정상) + 링크 최종 실패(소켓 경로 길이 초과).
// 만드는 법: 가짜 herdr 가 `session list` 출력의 루트를 긴 심링크 경로로 바꾼다(fake-rewrite). 서버는 짧은 실제 경로에서 돈다.
// ⓐ 카드 원인 link·lastError·버튼 1개 + 스크린샷 ⓑ 원인 그대로 클릭 → link.open + 새 시도 → 다시 failed·카드 유지
// R1-07 클릭 전후 사이드바·pane DOM · R1-03① 원인을 걷고(rewrite 해제) 클릭 → live·카드 걷힘·pane·터미널 그려짐. 사용: node fg-k5.mjs [ROOT=/tmp/l532c]
import fs from 'node:fs'
import path from 'node:path'
import { check, fail, finish, Iso, sleep, until } from './lib.mjs'

const iso = new Iso(process.argv[2] ?? '/tmp/l532c')
iso.fresh()
const repo = iso.makeRepo()
const longDir = path.join(iso.root, `L${'x'.repeat(90)}`)
fs.symlinkSync(iso.xdg, longDir)
iso.knob('fake-xdg', iso.xdg)

const snapshot = async (label) => {
  const dom = await iso.dom()
  const state = await iso.state()
  const view = { label, dom, link: { phase: state.link.phase, attempt: state.link.attempt, lastError: state.link.lastError }, backend: state.backend, herdrTabIds: state.herdrTabIds, terminalGroups: state.terminalGroups.length }
  console.log(`## ${label}: ${JSON.stringify(view)}`)
  return view
}
const phaseLines = () => iso.lines('link.phase')

try {
  await iso.startServer()
  console.log(iso.herdr(['workspace', 'create', '--cwd', repo]).slice(0, 120))
  const list = JSON.parse(iso.herdr(['session', 'list', '--json']))
  const socketPath = list.sessions.find((session) => session.default).socket_path
  const from = socketPath.slice(0, socketPath.length - '/herdr/herdr.sock'.length)
  const longSocket = `${longDir}/herdr/herdr.sock`
  console.log(`## 실제 소켓 ${socketPath} · 긴 소켓 ${longSocket} (${Buffer.byteLength(longSocket)} bytes, 한계 104) · 심링크로 같은 곳: ${fs.realpathSync(path.dirname(longSocket)) === fs.realpathSync(path.dirname(socketPath))}`)
  iso.knob('fake-rewrite', `${from}|${longDir}`)
  await iso.launch({ label: 'k5', appXdg: longDir })
  await iso.addRepo()

  // ⓐ
  await until('link.phase failed 로그', () => phaseLines().some((line) => line.phase === 'failed'), 20_000)
  console.log(`## link.socket_path_too_long: ${JSON.stringify(iso.lines('link.socket_path_too_long').at(-1))}`)
  console.log(`## link.phase failed: ${JSON.stringify(phaseLines().find((line) => line.phase === 'failed'))}`)
  const before = await until('원인 link 카드', async () => { const view = await snapshot('ⓐ 카드 대기'); return view.dom.card?.cause === 'link' ? view : null }, 10_000, 500)
  check('K5ⓐ 세션 running(조회 정상)', [(await iso.state()).sessions, (await iso.state()).sessionsError], [[{ name: 'default', isDefault: true, running: true }], null])
  check('K5ⓐ 카드', [before.dom.card.kind, before.dom.card.cause], ['unreachable', 'link'])
  check('K5ⓐ 제목', before.dom.card.title, 'herdr 세션 default 에 연결하지 못했습니다')
  check('K5ⓐ 본문 줄', before.dom.card.line, '자동으로 다시 연결하지 않는 오류입니다')
  check('K5ⓐ 오류 원문 = 링크 lastError', before.dom.card.error, before.link.lastError)
  check('K5ⓐ lastError 가 경로 길이 초과', before.link.lastError.includes('유닉스 소켓 경로가'), true)
  check('K5ⓐ 버튼 1개 = 다시 시도', before.dom.card.buttons, [{ text: '다시 시도', retry: true, start: false }])
  await iso.shot('fg-k5a-link-card')

  // ⓑ 원인 그대로 클릭
  const opens = iso.lines('link.open').length
  const fails = phaseLines().filter((line) => line.phase === 'failed').length
  const click1 = await iso.clickRetry()
  console.log(`## 클릭(원인 그대로): ${JSON.stringify(click1)}`)
  check('K5ⓑ 클릭 요소 1개', click1.clicked, true)
  await until('link.open 새 줄', () => iso.lines('link.open').length > opens, 5_000, 100)
  await until('다시 failed', () => phaseLines().filter((line) => line.phase === 'failed').length > fails, 5_000, 100)
  const openLine = iso.lines('link.open').at(-1)
  const retryLine = iso.lines('backend.retry').at(-1)
  const newAttempt = phaseLines().filter((line) => line.at >= openLine.at)
  console.log(`## backend.retry: ${JSON.stringify(retryLine)}\n## link.open: ${JSON.stringify(openLine)}\n## 새 시도 link.phase: ${JSON.stringify(newAttempt)}`)
  check('K5ⓑ backend.retry 원인 link·세션 default', [retryLine.cause, retryLine.session], ['link', 'default'])
  check('K5ⓑ link.open 세션', openLine.session, 'default')
  check('K5ⓑ 새 시도 attempt 1(0 에서 다시)', newAttempt.find((line) => line.phase === 'connecting')?.attempt ?? null, 1)
  await sleep(500)
  const afterSame = await snapshot('ⓑ 클릭 뒤(원인 그대로)')
  check('K5ⓑ 원인 그대로 → 카드 유지', afterSame.dom.card?.cause ?? null, 'link')
  check('R1-07 클릭 전 사이드바 herdr 행(링크 한 번도 live 아님)', [before.herdrTabIds, before.dom.termPanes], [null, 0])
  check('R1-07 원인 그대로 클릭 뒤 빈 채 유지', [afterSame.herdrTabIds, afterSame.dom.termPanes], [null, 0])

  // R1-03① 원인을 걷고 클릭
  const knobAt = Date.now()
  iso.knob('fake-rewrite', null)
  await until('rewrite 해제 뒤 조회 1회', () => iso.lines('sessions.poll').some((line) => line.at > knobAt), 8_000, 100)
  const stillCard = await snapshot('원인 걷음, 클릭 전')
  check('R1-03① 원인을 걷어도 클릭 전엔 카드 유지(링크는 스스로 다시 열지 않는다)', stillCard.dom.card?.cause ?? null, 'link')
  const opens2 = iso.lines('link.open').length
  const click2 = await iso.clickRetry()
  console.log(`## 클릭(원인 걷음): ${JSON.stringify(click2)}`)
  await until('link.open 새 줄(2)', () => iso.lines('link.open').length > opens2, 5_000, 100)
  console.log(`## link.open(2): ${JSON.stringify(iso.lines('link.open').at(-1))}`)
  await until('link live', async () => (await iso.state()).link.phase === 'live', 15_000)
  const recovered = await until('카드 걷힘 + pane 그려짐', async () => {
    const view = await snapshot('복구 대기')
    return view.dom.card === null && view.dom.termPanes > 0 && view.dom.termText.length > 0 ? view : null
  }, 15_000, 500)
  check('R1-03① live·카드 걷힘', [recovered.link.phase, recovered.backend], ['live', { kind: 'ok' }])
  check('R1-03①·R1-07 사이드바 herdr 행 다시 채워짐(탭 ≥1)', (recovered.herdrTabIds ?? []).length >= 1, true)
  check('R1-03① 터미널 pane DOM ≥1·빈 영역 아님', [recovered.dom.termPanes >= 1, recovered.dom.termEmpty], [true, false])
  check('R1-03① 터미널 내용이 그려짐(xterm 행 텍스트)', recovered.dom.termText.length > 0, true)
  await iso.shot('fg-k5-recovered')
  console.log('## link.phase 전부')
  for (const line of phaseLines()) console.log(JSON.stringify(line))
  console.log('## backend.status 전이')
  for (const line of iso.lines('backend.status')) console.log(JSON.stringify(line).slice(0, 300))
} catch (error) {
  fail(`예외: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await iso.quit()
  iso.g7()
  iso.stopServer()
}
finish()
