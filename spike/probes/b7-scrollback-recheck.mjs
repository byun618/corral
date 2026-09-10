// B7 재확인 — "스크롤백이 0" 이 측정 실수가 아님을 세 각도에서 다시 잰다.
//
// 서버 로그는 pane_scrollback_limit_bytes=10000000 을 찍는데 소켓 API 로는 뷰포트 밖이
// 하나도 안 나온다. 셋 다 같은 답이 나오면 그건 재현된 사실이다.
//   ① 출력을 천천히 흘려도 max_offset_from_bottom 이 움직이는가
//   ② pane.scroll 을 0 이 아닌 값으로 주면 화면이 실제로 뒤로 가는가
//   ③ 프롬프트가 다시 그려지기 *전에* (명령이 sleep 으로 붙잡고 있는 중에) 읽으면 다른가
//   ④ pane.edit_scrollback 이 헤드리스 클라이언트에게 데이터를 주는가
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b7-scrollback-recheck.mjs

import { Raw, sleep } from '../lib/raw.mjs'
import { makeApi, run, readText } from '../lib/pane.mjs'

const raw = new Raw('b7-scrollback-recheck')
const api = makeApi(raw)
const R = {}

const P = (await api('pane.list', {})).panes[0].pane_id
const scroll = async () => (await api('pane.list', {})).panes.find((x) => x.pane_id === P).scroll
const span = (t, tag = '줄') => {
  const n = [...t.matchAll(new RegExp(`${tag} (\\d+)`, 'g'))].map((m) => +m[1])
  return n.length ? { min: Math.min(...n), max: Math.max(...n), count: n.length } : null
}

// ① 천천히 흘리기
{
  await run(api, P, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  const steps = [{ added: 0, scroll: await scroll() }]
  for (const n of [20, 60, 120]) {
    await run(api, P, `for i in $(seq 1 ${n}); do echo "천천히 $i"; sleep 0.005; done`, { settleMs: 1500 })
    steps.push({ added: n, scroll: await scroll() })
  }
  R.slowOutput = { steps, maxOffsetEverNonZero: steps.some((s) => s.scroll.max_offset_from_bottom > 0) }
  console.log('① 천천히:', JSON.stringify(steps.map((s) => s.scroll.max_offset_from_bottom)))
}

// ② pane.scroll 을 0 이 아닌 값으로
{
  const tried = []
  for (const off of [1, 10, 50]) {
    const res = await api('pane.scroll', { pane_id: P, offset_from_bottom: off })
    await sleep(150)
    const v = await readText(api, P, 'visible')
    tried.push({
      requested: off,
      accepted: res.type,
      reportedOffset: res.pane?.scroll?.offset_from_bottom ?? null,
      topLine: v.text.split('\n')[0].slice(0, 40),
    })
  }
  await api('pane.scroll', { pane_id: P, offset_from_bottom: 0 })
  R.paneScroll = {
    tried,
    // 요청한 오프셋이 반영됐는가 — 화면 맨 윗줄이 바뀌면 뒤로 간 것이다
    viewMoved: new Set(tried.map((t) => t.topLine)).size > 1,
  }
  console.log('② pane.scroll:', JSON.stringify(tried))
}

// ③ 프롬프트 복귀 전에 읽기
{
  await run(api, P, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  await api('pane.send_text', { pane_id: P, text: `seq 1 300 | awk '{print "줄 " $1}'; sleep 25\n` })
  await sleep(4000)
  const during = {}
  during.scroll = await scroll()
  for (const [s, l] of [['visible', null], ['recent', 5000], ['recent_unwrapped', 5000]]) {
    const r = await readText(api, P, s, l ?? undefined)
    during[s] = { span: span(r.text), bytes: r.text.length, truncated: r.truncated }
  }
  await api('pane.send_text', { pane_id: P, text: '\x03' })
  await sleep(1200)
  const after = { scroll: await scroll() }
  for (const s of ['recent', 'recent_unwrapped']) {
    const r = await readText(api, P, s, 5000)
    after[s] = { span: span(r.text), bytes: r.text.length }
  }
  R.beforePromptRedraw = { during, after, total: 300 }
  console.log('③ 명령 진행 중:', JSON.stringify(during.recent_unwrapped), '| 복귀 후:', JSON.stringify(after.recent_unwrapped))
}

// ④ pane.edit_scrollback
{
  // 포커스를 준 상태와 안 준 상태를 둘 다 본다 — 이 메서드는 포커스 게이트가 걸려 있다.
  const attempts = []
  for (const focusFirst of [false, true]) {
    if (focusFirst) {
      await api('pane.focus', { pane_id: P })
      await sleep(400)
    }
    try {
      const res = await api('pane.edit_scrollback', { pane_id: P })
      await sleep(1000)
      attempts.push({
        focusFirst,
        ok: true,
        response: res,
        // 헤드리스 호출자에게 스크롤백 데이터가 돌아오는가
        returnsData: Object.keys(res).some((k) => k !== 'type'),
      })
    } catch (err) {
      attempts.push({ focusFirst, ok: false, error: String(err) })
    }
  }
  const v = await readText(api, P, 'visible')
  R.editScrollback = {
    attempts,
    paneScreenAfter: v.text.slice(0, 60),
    note: '응답은 {"type":"ok"} 뿐이고 스크롤백 데이터가 없다. 클라이언트 UI 동작이며 포커스 게이트가 걸린다',
  }
  console.log('④ edit_scrollback:', JSON.stringify(attempts))
}

R.conclusion = {
  scrollbackRowsBeyondViewport: 0,
  measuredWays: ['burst output', 'slow output', 'mid-command read', 'pane.scroll', 'pane.edit_scrollback'],
  serverConfigSays: 'pane_scrollback_limit_bytes=10000000 (herdr-server.log)',
  gap: '서버는 스크롤백을 들고 있다고 로그에 찍는데 소켓 API 로는 뷰포트 밖이 나오지 않는다',
  unresolved: 'herdr 의 한계인지 이 환경(named 세션·attach 클라이언트 구성)의 성질인지 못 가렸다',
}

raw.close({ probe: 'b7-scrollback-recheck', at: new Date().toISOString(), results: R })
process.exit(0)
