// ⑩′ 마무리 — B7 통과선이 같이 요구한 두 가지를 채운다.
//   기준서 B7: "0.9.0 신규 pane.scroll·pane.edit_scrollback·pane.selection.read 를 함께 잰다 —
//   스크롤백을 xterm.js 에 재구성해 넣는 대신 herdr 에게 스크롤을 시키고 다시 읽는 쪽이 되는지"
//
// 앞선 프로브들이 pane.scroll 과 pane.edit_scrollback 은 쟀는데 pane.selection.read 는 안 쟀다.
// 그리고 "스크롤시켜 다시 읽기" 왕복이 실제로 전체를 복원하는지는 세어본 적이 없다.
// 이번엔 스크롤백이 살아 있는 판(= 알트가 아닌 split 판)에서 잰다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b7-selection.mjs

import { Raw, sleep } from '../lib/raw.mjs'
import { makeApi, run, readText } from '../lib/pane.mjs'

const raw = new Raw('b7-selection')
const api = makeApi(raw)
const R = {}
const N = 300
const TAG = 'B7SEL'

const panes = async () => (await api('pane.list', {})).panes
const info = async (id) => (await panes()).find((p) => p.pane_id === id) ?? null
const nums = (t) => [...String(t).matchAll(new RegExp(`${TAG}-(\\d{3})`, 'g'))].map((m) => +m[1])
const span = (t) => {
  const n = nums(t)
  return n.length ? { min: Math.min(...n), max: Math.max(...n), count: new Set(n).size } : null
}

for (const p of (await panes()).slice(1)) await api('pane.close', { pane_id: p.pane_id }).catch(() => {})
await sleep(600)

const sp = await api('pane.split', { direction: 'right' })
const P = sp.pane.pane_id
await sleep(1500)
await run(api, P, "printf '\\033[2J\\033[H'", { settleMs: 400 })
await run(api, P, `for i in $(seq 1 ${N}); do printf '${TAG}-%03d\\n' $i; done`, { settleMs: 3000 })

const i0 = await info(P)
R.pane = { paneId: P, maxOffsetFromBottom: i0?.scroll?.max_offset_from_bottom ?? null }
const vis0 = await readText(api, P, 'visible')
R.viewportRows = vis0.text.split('\n').length
R.viewportSpan = span(vis0.text)

// --- ① pane.selection.read 가 뷰포트 위쪽(스크롤백)까지 닿는가 -------------
{
  const tries = []
  // row 좌표가 뷰포트 기준인지 스크롤백 포함 절대 좌표인지 모른다 — 둘 다 시험한다.
  for (const [label, anchor, cursor] of [
    ['뷰포트 첫 줄', { row: 0, col: 0 }, { row: 0, col: 40 }],
    ['뷰포트 여러 줄', { row: 0, col: 0 }, { row: 5, col: 40 }],
    ['뷰포트 위 (row 큰 값)', { row: 250, col: 0 }, { row: 255, col: 40 }],
    ['맨 위부터 전체', { row: 0, col: 0 }, { row: 999, col: 0 }],
  ]) {
    try {
      const r = await api('pane.selection.read', { pane_id: P, anchor, cursor })
      const text = r.text ?? r.read?.text ?? JSON.stringify(r).slice(0, 200)
      tries.push({ label, anchor, cursor, ok: true, bytes: String(text).length, span: span(text), sample: String(text).slice(0, 60) })
    } catch (err) {
      tries.push({ label, anchor, cursor, ok: false, error: String(err).replace(/^Error: /, '').slice(0, 160) })
    }
  }
  R.selectionRead = { tries, reachesScrollback: tries.some((t) => t.ok && t.span && t.span.min < (R.viewportSpan?.min ?? 1e9)) }
  console.log('① selection.read:', JSON.stringify(tries.map((t) => [t.label, t.ok ? t.span : t.error]), null, 0).slice(0, 500))
}

// --- ② herdr 에게 스크롤을 시키고 다시 읽어 전체를 복원할 수 있는가 --------
// 기준서가 물은 "xterm.js 에 재구성해 넣는 대신" 경로다.
{
  const max = (await info(P))?.scroll?.max_offset_from_bottom ?? 0
  const step = Math.max(1, Math.floor((R.viewportRows || 40) / 2))
  const seen = new Set()
  const walk = []
  for (let off = max; off >= 0; off -= step) {
    await api('pane.scroll', { pane_id: P, offset_from_bottom: off })
    await sleep(120)
    const v = await readText(api, P, 'visible')
    const n = nums(v.text)
    n.forEach((x) => seen.add(x))
    walk.push({ offset: off, got: n.length ? { min: Math.min(...n), max: Math.max(...n) } : null })
  }
  await api('pane.scroll', { pane_id: P, offset_from_bottom: 0 })
  const missing = []
  for (let i = 1; i <= N; i++) if (!seen.has(i)) missing.push(i)
  R.scrollAndRead = {
    maxOffset: max,
    step,
    reads: walk.length,
    recovered: seen.size,
    ofTotal: N,
    missing: missing.slice(0, 20),
    missingCount: missing.length,
    complete: missing.length === 0,
    walk,
  }
  console.log('② 스크롤+재읽기:', seen.size, '/', N, '누락', missing.length, `(읽기 ${walk.length}회)`)
}

// --- ③ 대조: 한 번의 recent_unwrapped 로도 되는가 --------------------------
{
  const ru = await readText(api, P, 'recent_unwrapped', 5000)
  R.singleRead = { bytes: ru.text.length, truncated: ru.truncated, span: span(ru.text) }
  console.log('③ recent_unwrapped 한 방:', JSON.stringify(R.singleRead.span))
}

await api('pane.close', { pane_id: P }).catch(() => {})
for (const p of (await panes()).slice(1)) await api('pane.close', { pane_id: p.pane_id }).catch(() => {})

raw.close({ probe: 'b7-selection', at: new Date().toISOString(), lines: N, results: R })
process.exit(0)
