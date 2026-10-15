// LIFE-593 수정 r1 — 핵심 진입점(quick-entry)이 덮지 않는 지적의 격리 확인(fixture 만).
//   ① R1-C-05 — 추적 중인 폴더 링크(`link-dir`)는 ⌘P 목록에 없다. untracked 폴더 링크(`link-inside-dir` → src, worktree 안)를 고르면 탭을 열지 않고 안내(토스트)만.
//      밖을 가리키는 링크(`link-outside-dir`)는 탐색기 트리에서도 파일 행(`link: 'outside'`)이고 열면 가둠이 `outside_root` 로 거절한다 — ⌘P 도 같은지 기록한다(트리와 같은 결과).
//      (a06 회차는 밖 링크에 「열지 않음」 을 기대해 실패 — 기대가 트리 동작과 어긋났다. 원자료는 남긴다)
//   ② R1-C-06 — 편집기 없는 보기(바이너리 `bin/l593.bin`)를 ⌘P 로 열면 포커스가 그 보기 자리(`.file-group[data-file-view]`)에 간다.
//   ③ R1-C-08 — 이름 필터 다시 읽기: 패널이 열려 있으면 잦은 변경에도 최소 간격(2 s)으로 몰아 읽고(main 로그 `file.list` 수), 패널을 닫으면 읽지 않으며, 다시 열면 읽는다.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/fix-r1-probe.mjs <ROOT> <OUT.json>
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: fix-r1-probe.mjs /tmp/l593g-* OUT.json')
const repo = path.join(root, 'repo')
const logFile = path.join(root, 'ud', 'corral.ndjson')
const result = { at: new Date().toISOString(), method: 'sendInputEvent (control socket) — not CGEvent', steps: [], checks: {} }
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`# ${name} ${JSON.stringify(data).slice(0, 500)}`)
}
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const fileLists = () => fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('"tag":"file.list"'))
const quickOpen = async (query) => {
  await ctl(root, { cmd: 'key', keyCode: 'Shift' })
  await key('P', ['meta'])
  await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' ? true : null`), { timeoutMs: 10_000, label: `⌘P 준비 ${query}` })
  await ctl(root, { cmd: 'type', text: query })
  await sleep(500)
  return q(`[...document.querySelectorAll('[data-quick-open-row]')].map((e) => e.dataset.quickOpenRow)`)
}
let exitCode = 1
try {
  // 바이너리 파일(untracked — 목록에 든다)
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'bin', 'l593.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3, 0]))
  fs.symlinkSync('src', path.join(repo, 'link-inside-dir'))
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  const { paneId } = await repoPane(root)
  await sleep(1500)
  await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  await until(async () => (await ctl(root, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { timeoutMs: 15_000, label: 'streaming' })
  await giveBack()

  // ① 폴더 링크
  const linkRows = await quickOpen('link')
  await key('Escape')
  await until(() => q(`!document.querySelector('[data-quick-open]')`), { timeoutMs: 3_000, label: '⌘P 닫힘' })
  // (a05 무효 회차: ⌘A 뒤 입력이 질의를 바꾸지 못해 빈 결과로 이 갈래를 건너뛰었다 — 새로 열어 친다)
  const insideRows = await quickOpen('link-inside-dir')
  let insideOpened = null
  let toastSeen = null
  if (insideRows[0] === 'link-inside-dir') {
    await key('Return')
    toastSeen = await until(() => q(`document.body.innerText.includes('폴더(링크)') ? true : null`), { timeoutMs: 3_000, label: '토스트' }).then(() => true, () => false)
    await sleep(500)
    insideOpened = await q(`!!document.querySelector('[data-file-tab="link-inside-dir"]')`)
  } else await key('Escape')
  await sleep(500)
  const outsideRows = await quickOpen('link-outside-dir')
  let outside = null
  if (outsideRows[0] === 'link-outside-dir') {
    await key('Return')
    outside = (await until(() => q(`(() => { const v = document.querySelector('.file-group[data-file-view="link-outside-dir"]'); const n = v?.querySelector('.file-view-notice')?.dataset.fileNotice ?? null; return n === null || n === 'loading' ? null : { tab: !!document.querySelector('[data-file-tab="link-outside-dir"]'), notice: n } })()`), { timeoutMs: 5_000, label: '밖 링크 보기' }).catch(() => ({ value: null }))).value
  } else await key('Escape')
  step('c05.dirLinks', { linkRows, insideRows: insideRows.slice(0, 5), insideOpened, toastSeen, outsideRows: outsideRows.slice(0, 3), outside })
  result.checks.dirLinks = !linkRows.includes('link-dir') && linkRows.includes('link-file') && insideRows[0] === 'link-inside-dir' && insideOpened === false && toastSeen === true
  // 밖 링크 — 트리와 같은 결과(탭은 열리고 가둠 거절 안내)인지 기록만(판정 항목 아님).
  result.observed = { outsideLink: outside }
  await sleep(500)

  // ② 바이너리 보기 포커스
  const binRows = await quickOpen('l593.bin')
  await key('Return')
  await until(() => q(`!!document.querySelector('[data-file-tab="bin/l593.bin"]') ? true : null`), { timeoutMs: 6_000, label: '바이너리 탭' })
  const binFocus = await until(() => q(`(() => { const a = document.activeElement; return a?.matches('.file-group[data-file-view="bin/l593.bin"]') === true ? { notice: !!a.querySelector('[data-file-notice="binary"]') } : null })()`), { timeoutMs: 4_000, label: '보기 포커스' }).then((hit) => hit.value, () => null)
  const active = await q(`(() => { const a = document.activeElement; return { tag: a?.tagName ?? null, cls: String(a?.className ?? '').slice(0, 60), view: a?.dataset?.fileView ?? null } })()`)
  step('c06.binaryFocus', { binRows: binRows.slice(0, 3), binFocus, active })
  result.checks.binaryFocus = binFocus !== null && binFocus.notice === true

  // ③ 필터 다시 읽기
  const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { label: '탐색기' })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: '[data-explorer-row="README.md"]' })
    await sleep(200)
    return q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
  }, { timeoutMs: 6_000, label: '트리 포커스' })
  await giveBack()
  await key('F', ['meta', 'alt'])
  await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { timeoutMs: 5_000, label: '필터 입력칸' })
  await ctl(root, { cmd: 'type', text: 'needle' })
  await until(() => q(`[...document.querySelectorAll('[data-explorer-row]')].some((e) => e.dataset.explorerRow === 'src/deep/a/b/l593-needle.md') ? true : null`), { timeoutMs: 8_000, label: '걸러진 트리' })
  await sleep(2500)
  const drive = async (tag) => {
    const dir = path.join(repo, 'l593-drive')
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 10; i += 1) {
      const file = path.join(dir, `${tag}-${i}.txt`)
      fs.writeFileSync(file, 'x')
      await sleep(150)
      fs.rmSync(file)
      await sleep(150)
    }
  }
  const before = fileLists().length
  const t0 = Date.now()
  await drive('open')
  await sleep(2500)
  const openLists = fileLists().slice(before)
  const openWindowMs = Date.now() - t0
  step('c08.panelOpen', { changes: 20, windowMs: openWindowMs, fileListCalls: openLists.length, lines: openLists.map((line) => line.slice(0, 160)) })
  await key('L', ['meta'])
  await until(async () => !(await panelOpen()), { label: '패널 닫힘' })
  await sleep(800)
  const beforeClosed = fileLists().length
  await drive('closed')
  await sleep(2500)
  const closedLists = fileLists().slice(beforeClosed)
  step('c08.panelClosed', { changes: 20, fileListCalls: closedLists.length })
  const beforeReopen = fileLists().length
  await key('L', ['meta'])
  await until(panelOpen, { label: '패널 다시 열림' })
  await sleep(2500)
  const reopenLists = fileLists().slice(beforeReopen)
  const filterStill = await q(`!!document.querySelector('[data-explorer-filter-input]')`)
  step('c08.panelReopen', { fileListCalls: reopenLists.length, filterStill })
  // 20 번 변경(3 s) + 2.5 s 안에 다시 읽기는 최소 간격 2 s 로 몰아야 한다 — 1~4 번(변경마다 읽으면 수 번 넘게).
  result.checks.filterReload = openLists.length >= 1 && openLists.length <= 4 && closedLists.length === 0 && reopenLists.length >= 1
  exitCode = Object.values(result.checks).every(Boolean) ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  result.giveBack = giveBackLog
  result.exitCode = exitCode
  writeJson(path.resolve(out), result)
}
process.exit(exitCode)
