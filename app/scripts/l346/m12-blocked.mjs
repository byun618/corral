// M12 — 2차 리뷰 C1: **새 문지기의 거절 쪽을 한 번 연다.**
//
// fix1 원자료에는 `control.click` 158건에 `control.click.blocked` 0건이었다. 통과 쪽만 열린
// 문지기는 "가려지면 안 누르고 던진다" 를 **반사실**로 남긴다 — 그래서 여기서는 H1 을 고치기
// 전 화면(`styles.css` 를 1차 판정 대상 커밋으로 되돌린 빌드)에 **같은 하네스**를 걸고
// `blockedBy` 한 줄을 관측으로 남긴다. M3 의 "고치기 전" 회차와 같은 요령이다.
//
// 이 스크립트는 화면을 되돌리지 않는다 — 되돌린 빌드에서 **돌려야** 한다:
//   git show f59de62:app/src/renderer/src/styles.css > src/renderer/src/styles.css
//   npm run build && LIFE346_RAW_SUBDIR=fix2 node scripts/l346/m12-blocked.mjs
//   git checkout HEAD -- src/renderer/src/styles.css && npm run build
// 되돌린 판인지 아닌지는 **우리가 우기지 않는다** — 돌린 CSS 의 해시와 `.stage`·`.term-wrap`
// 규칙을 화면에서 직접 읽어 원자료에 싣는다.
//
// # 여기서 같이 적는 폭 (C1 둘째 줄)
//
// 프로브(`executeJavaScript`)와 클릭(`sendInputEvent`)은 **IPC 두 번**이라 원자적이지 않다.
// 그 사이에 레이아웃이 움직이면 기록된 `elementFromPoint` 는 클릭 직전의 사진이 아니다.
// 그래서 통과 회차의 `닿을때까지ms` 를 원자료에 같이 남긴다 — 그 값이 이 창의 폭이다.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  APP_DIR,
  clickLog,
  createRowByUi,
  firstWorkspaceId,
  herdrTruth,
  paneProcesses,
  request,
  sleep,
  startApp,
  tidySession,
  until,
  writeRaw,
} from './lib.mjs'

await tidySession()
const app = await startApp({ name: 'm12-blocked' })
const workspaceId = await firstWorkspaceId(app)

// ── 지금 화면이 어느 판인가 — 우리 주장이 아니라 **화면이 답한다** ──────────
// 소스가 아니라 **앱이 실제로 읽은 번들**을 본다 (하네스는 out/ 을 띄운다).
const cssPath = path.join(APP_DIR, 'src/renderer/src/styles.css')
const cssText = fs.readFileSync(cssPath, 'utf8')
const bundleDir = path.join(APP_DIR, 'out/renderer/assets')
const bundlePath = path.join(bundleDir, fs.readdirSync(bundleDir).find((name) => name.endsWith('.css')) ?? '')
const bundleText = fs.readFileSync(bundlePath, 'utf8')
const has = (text) => ({
  'stage safe center': text.includes('safe center'),
  'term-wrap max-width': /\.term-wrap\{[^}]*max-width:100%/.test(text.replace(/\s+/g, '')) || text.includes('max-width: 100%'),
  'sidebar z-index': /\.sidebar\{[^}]*z-index:1/.test(text.replace(/\s+/g, '')) || /\.sidebar \{[^}]*z-index: 1;/s.test(text),
})

const out = {
  at: new Date().toISOString(),
  질문: '가려진 종료 버튼에 새 하네스를 걸면 누르지 않고 거절하는가',
  화면판: {
    'styles.css sha256': crypto.createHash('sha256').update(cssText).digest('hex').slice(0, 16),
    '번들 파일': path.basename(bundlePath),
    '번들 sha256': crypto.createHash('sha256').update(bundleText).digest('hex').slice(0, 16),
    /** ← 이 칸이 "어느 판에서 쟀나" 다. 전부 false 면 H1 이전 화면이다 */
    'H1 세 줄이 번들에 있나': has(bundleText),
    'H1 세 줄이 소스에 있나': has(cssText),
  },
  케이스: [],
}

// ── claude 행 하나를 만들고 터미널이 붙을 때까지 (m6 과 같은 자리) ──────────
const before = new Set((await herdrTruth()).tabs)
await createRowByUi(app, workspaceId, 'claude')
const tabId = (
  await until(async () => (await herdrTruth()).tabs.find((id) => !before.has(id)) ?? null, { what: '새 탭', everyMs: 60 })
).value
const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null
await until(async () => (await paneProcesses(paneId)).foreground.some((item) => (item.argv0 ?? '') === 'claude'), {
  what: 'claude 기동',
  timeoutMs: 60000,
  everyMs: 400,
})
const attached = await until(
  async () => {
    const state = await app.state()
    return state.terminal.paneId === paneId && state.terminal.alive && state.terminal.frames > 0 ? state.terminal : null
  },
  { what: '터미널 부착', timeoutMs: 30000, everyMs: 200 },
)
await sleep(1200) // 격자가 정착할 틈 — 덮개는 격자 폭이 정해진 뒤에 생긴다
const shot = await app.shot('c1-attached')

// ── 문지기에게 묻는다. **누르지 않는다** ────────────────────────────────────
const selector = `[data-close-tab="${tabId}"]`
const inDom = await app.query(selector)
const probe = await app.click(selector) // hit 이 false 면 control.ts 가 좌표를 안 보낸다
const blockedLog = app.entries().filter((entry) => entry.tag === 'control.click.blocked')
const clickLogEntries = app.entries().filter((entry) => entry.tag === 'control.click')

out.케이스.push({
  이름: 'H1 이전 화면에서 행 종료 ×',
  tabId,
  paneId,
  격자: attached.value?.grid ?? null,
  'DOM 에 있나 (1회차 el.click() 이 본 것)': inDom.found.length > 0,
  '문지기 응답': probe,
  '눌렀나': probe.ok === true,
  'blockedBy': probe.blockedBy ?? null,
  '앱 로그 control.click.blocked': blockedLog.map((entry) => ({ selector: entry.selector, blockedBy: entry.blockedBy })),
  '앱 로그 control.click(통과)': clickLogEntries.length,
  샷: shot.file,
})
console.log('종료 × →', probe.hit === true ? 'HIT(안 가려졌다)' : `BLOCKED by ${probe.blockedBy}`)

// 같은 화면에서 **가려지지 않은** 버튼도 한 번 — 문지기가 전부 막는 것이 아님을 보인다.
const control = await app.click(`[data-new-row="${workspaceId}"]`)
out.케이스.push({
  이름: '대조군 — 같은 화면의 + 새 행 버튼',
  '문지기 응답': control,
  '눌렀나': control.ok === true,
})
console.log('+ 새 행 →', control.hit === true ? 'HIT' : `BLOCKED by ${control.blockedBy}`)

out.판정 = {
  '거절이 실제로 열렸나': out.케이스[0]['눌렀나'] === false,
  '무엇이 덮었나': out.케이스[0].blockedBy,
  'DOM 에는 있었나(= el.click() 은 통과했을 것)': out.케이스[0]['DOM 에 있나 (1회차 el.click() 이 본 것)'],
  '대조군은 통과했나': out.케이스[1]['눌렀나'] === true,
}
console.log(JSON.stringify(out.판정, null, 2))

out.클릭증거 = clickLog()
writeRaw('c1-blocked-probe.json', out)
await app.stop()
await tidySession()
