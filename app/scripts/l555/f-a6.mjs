// LIFE-555 A6 ⓑⓒ — LaunchServices 로 뜬 설치본(제어 소켓 실림)에서 사이드바 스크린샷 · pane 1개 열기 → 명령 → 화면 텍스트 → 닫기.
// 판정은 종료코드(실패 수). pane 은 **이미 herdr 워크스페이스가 있는 worktree** 에서만 연다 — 행 클릭이 새 워크스페이스를 만들지 않게.
// 사용: node f-a6.mjs <ctl.sock> <원자료 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, out] = process.argv.slice(2)
const control = (request, timeout = 20_000) => rpc(sock, request, timeout)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let fails = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`CHECK ${name} ${ok ? 'pass' : 'fail'} (실측 ${JSON.stringify(actual)} / 기대 ${JSON.stringify(expected)})`)
  if (!ok) fails += 1
}
const control_ = (name, actual, wrong) => {
  const ok = JSON.stringify(actual) !== JSON.stringify(wrong)
  console.log(`CONTROL ${name} ${ok ? 'pass' : 'fail'} (틀린 기대 ${JSON.stringify(wrong)} — 실측 ${JSON.stringify(actual)})`)
  if (!ok) fails += 1
}
async function until(fn, label, timeout = 30_000, every = 250) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}
const state = async () => (await control({ cmd: 'state' })).state
const shot = async (name, selector) => {
  const res = await control({ cmd: 'shot', name, ...(selector ? { selector } : {}) })
  if (!res.ok) throw new Error(`shot 실패 ${JSON.stringify(res).slice(0, 200)}`)
  const target = path.join(out, `${name}.png`)
  fs.copyFileSync(res.file, target)
  console.log(`shot ${path.basename(target)}`)
}
const tabsOf = (s, wtPath) => {
  for (const repo of s.repos ?? []) for (const row of repo.worktrees ?? []) if (row.path === wtPath) return (row.workspace?.tabs ?? []).map((tab) => tab.tabId)
  return []
}

try {
  // ⓑ 사이드바 저장소 목록
  const s0 = await until(async () => { const s = await state(); return (s.repos ?? []).length > 0 ? s : null }, '저장소 목록', 30_000)
  const repoRoots = s0.repos.map((repo) => repo.root ?? repo.path ?? null)
  console.log(`repos=${s0.repos.length} ${JSON.stringify(repoRoots).slice(0, 400)}`)
  fs.writeFileSync(path.join(out, 'a6-repos.json'), `${JSON.stringify(repoRoots, null, 1)}\n`)
  check('a6b.repos_nonempty', s0.repos.length > 0, true)
  const rows = (await control({ cmd: 'query', selector: '[data-worktree]' })).found ?? []
  console.log(`sidebar [data-worktree] rows=${rows.length}`)
  check('a6b.sidebar_rows_nonempty', rows.length > 0, true)
  control_('a6b.sidebar_rows_nonempty', ((await control({ cmd: 'query', selector: '[data-l555-no-such]' })).found ?? []).length > 0, true)
  await shot('a6b-sidebar')
  // ⓒ pane 1개 — 이 corral 레포 본체 행. 워크스페이스가 닫혀 있으면 행 클릭이 herdr workspace.create 로 워크스페이스 + pane 1개를 연다(L6),
  //    열려 있으면 `+` → 새 터미널로 탭 1개를 더한다. 어느 쪽이든 그 pane 하나를 쓰고 닫는다.
  const rowsAll = []
  for (const repo of s0.repos) for (const row of repo.worktrees ?? []) rowsAll.push(row)
  const targetRow = rowsAll.find((row) => row.path.endsWith('/byun618/corral')) ?? rowsAll[0]
  const target = targetRow.path
  console.log(`target worktree=${target} workspace=${targetRow.workspace ? 'open' : 'closed'}`)
  const before = new Set(tabsOf(s0, target))
  let tabId
  if (targetRow.workspace === null) {
    check('a6c.select_row_click', (await control({ cmd: 'click', selector: `[data-worktree="${target}"] [data-worktree-card-surface]` })).ok, true)
    tabId = await until(async () => tabsOf(await state(), target)[0] ?? null, '워크스페이스 열림', 30_000)
    console.log('opened by row click (workspace.create)')
  } else {
    check('a6c.select_row_click', (await control({ cmd: 'click', selector: `[data-worktree="${target}"] [data-worktree-card-surface]` })).ok, true)
    await pause(800)
    check('a6c.plus_click', (await control({ cmd: 'click', selector: '[data-main-tabbar-add]' })).ok, true)
    await until(async () => ((await control({ cmd: 'query', selector: '[data-tab-create-item="new-terminal"]' })).found ?? []).length > 0, '+ 메뉴', 5_000)
    check('a6c.new_terminal_click', (await control({ cmd: 'click', selector: '[data-tab-create-item="new-terminal"]' })).ok, true)
    tabId = await until(async () => tabsOf(await state(), target).find((id) => !before.has(id)) ?? null, '새 탭', 20_000)
  }
  console.log(`new tab=${tabId}`)
  // 셸 프롬프트가 그려질 때까지
  await until(async () => { const r = await control({ cmd: 'term-read' }); return r.ok && JSON.stringify(r.term).length > 40 ? r : null }, '터미널 준비', 20_000)
  await pause(1500)
  await control({ cmd: 'type', text: 'echo $PATH; command -v git herdr; git --version' })
  await control({ cmd: 'key', keyCode: 'Return' })
  const term = await until(async () => { const r = await control({ cmd: 'term-read' }); return r.ok && JSON.stringify(r.term).includes('git version') ? r : null }, 'git --version 출력', 15_000)
  fs.writeFileSync(path.join(out, 'a6c-term-read.json'), `${JSON.stringify(term.term, null, 1)}\n`)
  const text = JSON.stringify(term.term)
  check('a6c.git_version_seen', /git version \d/.test(text), true)
  check('a6c.herdr_path_seen', text.includes('/opt/homebrew/bin/herdr'), true)
  control_('a6c.git_version_seen', /l555-no-such-output/.test(text), true)
  await shot('a6c-pane')
  // 닫기 — 탭 닫기 버튼, 확인 모달이 뜨면 확인
  const close = await control({ cmd: 'click', selector: `[data-main-tab-close="${tabId}"]` })
  check('a6c.close_click', close.ok, true)
  await pause(600)
  const modal = ((await control({ cmd: 'query', selector: '[data-close-confirm-ok]' })).found ?? []).length > 0
  console.log(`close confirm modal=${modal}`)
  if (modal) await control({ cmd: 'click', selector: '[data-close-confirm-ok]' })
  await until(async () => !tabsOf(await state(), target).includes(tabId), '탭 닫힘', 15_000)
  check('a6c.tab_closed_in_corral', tabsOf(await state(), target).includes(tabId), false)
} catch (error) {
  console.log(`ERROR ${error instanceof Error ? error.message : String(error)}`)
  fails += 1
}
console.log(`fails=${fails}`)
process.exit(fails)
