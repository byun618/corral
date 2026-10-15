// LIFE-593 수정 r2 R2-C-04·R2-G-05 — 결과가 따라잡기 전에 Enter 를 누르면 무엇이 열리나(20만 fixture). 리뷰 r2 `probes/r2c-enter-race.mjs` 를 옮김.
//   D 대화상자를 연 즉시(색인 전 — 캐시 없는 첫 열기) 질의 + Enter · C 짧은 질의 Enter · A 다 치자마자 Enter · B Enter 직후 한 글자 더
// 기대값 = 제품 검색 함수(`top-of.mjs`)로 그 회차 전에 연 파일을 최근 기록으로 넣어 계산(화면에서 다시 재면 앞 회차가 연 파일이 최근 묶음으로 맨 위에 와 자기 확인이 된다 — p2e 무효 회차).
// 판정: 각 회차에서 열린 탭이 「Enter 를 누른 시점 질의의 맨 위 행」 뿐이어야 한다(B 는 그것 또는 아무것도 — 질의가 바뀌면 보류 취소). A·C·D 는 그 행이 열려야 한다.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/enter-race.mjs <ROOT> <REPO=/tmp/l593f-200k> <OUT.json>
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [root, repo, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || !/^\/tmp\/l593f-[^/]+$/.test(repo ?? '') || out === undefined) throw new Error('사용: enter-race.mjs /tmp/l593g-* /tmp/l593f-* OUT.json')
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const res = { at: new Date().toISOString(), runs: [] }
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  const { paneId } = await repoPane(root, { repo })
  await sleep(1500)
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭' })
  await sleep(1500)
  const openQuick = async (wait = true) => {
    await ctl(root, { cmd: 'key', keyCode: 'Shift' })
    await key('P', ['meta'])
    if (wait) await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' ? true : null`), { timeoutMs: 20_000, label: '⌘P' })
    else await until(() => q(`document.activeElement?.matches('[data-quick-open-input]') === true ? true : null`), { timeoutMs: 5_000, label: '⌘P 입력칸' })
  }
  const tabs = () => q(`[...document.querySelectorAll('[data-file-tab]')].map((t) => t.dataset.fileTab)`)
  const closeAllTabs = async () => {
    for (let i = 0; i < 6; i += 1) {
      if ((await tabs()).length === 0) return
      await key('W', ['meta'])
      await sleep(400)
    }
  }
  // D 먼저 — 앱을 띄운 뒤 첫 열기라 목록 캐시가 없다(색인 전 Enter). 질의는 앞 회차가 연 파일과 겹치지 않게 고른다(검사는 아래 기대값이 최근 기록을 넣어 한다).
  const plan = [['D 색인 전 Enter', 'file_12_3', '', false], ['C 짧은 질의 Enter', 'f9', '', true], ['A 다 치자마자 Enter', 'file_45_6', '', true], ['B Enter 직후 한 글자 더', 'file_78_9', '1', true]]
  const opened = []
  const topOf = (query) => execFileSync('npx', ['tsx', 'scripts/l593/top-of.mjs', repo, query, ...opened], { encoding: 'utf8' }).trim()
  for (const [name, first, rest, warm] of plan) {
    const atEnter = topOf(first)
    const final = rest === '' ? atEnter : topOf(first + rest)
    await openQuick(warm)
    const stateAtType = await q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState ?? null`)
    await ctl(root, { cmd: 'type', text: first })
    await key('Return')
    if (rest !== '') await ctl(root, { cmd: 'type', text: rest })
    await sleep(2500)
    const after = await tabs()
    const dialogOpen = await q(`!!document.querySelector('[data-quick-open]')`)
    res.runs.push({ name, first, rest, stateAtType, expectedTopAtEnter: atEnter, expectedFinalTop: final, tabsAfter: after, dialogStillOpen: dialogOpen })
    for (const rel of after) if (!opened.includes(rel)) opened.unshift(rel)
    if (dialogOpen) {
      await key('Escape')
      await sleep(300)
    }
    await closeAllTabs()
  }
  const checks = res.runs.map((run) => {
    const onlyAtEnter = run.tabsAfter.every((rel) => rel === run.expectedTopAtEnter)
    const didOpen = run.tabsAfter.includes(run.expectedTopAtEnter)
    return { name: run.name, ok: run.rest === '' ? onlyAtEnter && didOpen : onlyAtEnter }
  })
  res.checks = checks
  exitCode = checks.every((check) => check.ok) ? 0 : 1
} catch (error) {
  res.error = String(error?.stack ?? error)
  console.error(res.error)
} finally {
  res.giveBack = giveBackLog
  res.exitCode = exitCode
  writeJson(path.resolve(out), res)
  console.log(JSON.stringify({ runs: res.runs, checks: res.checks }))
}
process.exit(exitCode)
