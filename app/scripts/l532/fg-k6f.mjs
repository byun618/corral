// LIFE-532 최종 관문 K6ⓕ — 평시(조회 정상·링크 live): 카드·배너 없음 + sessions.scan 0줄(F7). 조회가 실제로 돌았다는 양성 대조로 sessions.poll ≥4.
// 사용: node fg-k6f.mjs [ROOT=/tmp/l532e]
import { check, fail, finish, Iso, sleep, until } from './lib.mjs'

const iso = new Iso(process.argv[2] ?? '/tmp/l532e')
iso.fresh()
const repo = iso.makeRepo()
try {
  await iso.startServer()
  console.log(iso.herdr(['workspace', 'create', '--cwd', repo]).slice(0, 120))
  await iso.launch({ label: 'k6f' })
  await iso.addRepo()
  await until('link live', async () => (await iso.state()).link.phase === 'live', 20_000)
  const polls = iso.lines('sessions.poll').length
  await sleep(15_000)
  const dom = await iso.dom()
  const state = await iso.state()
  console.log(`## 15초 뒤 DOM: ${JSON.stringify(dom)}\n## backend ${JSON.stringify(state.backend)} · link ${state.link.phase}`)
  check('K6ⓕ 카드 없음', dom.card, null)
  check('K6ⓕ 배너 없음', dom.banner, null)
  check('K6ⓕ backend ok·link live', [state.backend, state.link.phase], [{ kind: 'ok' }, 'live'])
  check('K6ⓕ 터미널 pane 그려짐', dom.termPanes >= 1, true)
  const pollCount = iso.lines('sessions.poll').length - polls
  console.log(`## 15초 동안 sessions.poll ${pollCount}줄 (source ${[...new Set(iso.lines('sessions.poll').map((line) => line.source))].join(',')})`)
  check('K6ⓕ 양성 대조 — 조회가 돌았다(sessions.poll ≥4)', pollCount >= 4, true)
  check('F7 평시 sessions.scan 0줄(기동부터 전체)', iso.lines('sessions.scan').length, 0)
  check('K6ⓕ backend.status 는 ok 만', [...new Set(iso.lines('backend.status').map((line) => line.status.kind))], ['ok'])
  await iso.shot('fg-k6f-normal')
} catch (error) {
  fail(`예외: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await iso.quit()
  iso.g7()
  iso.stopServer()
}
finish()
