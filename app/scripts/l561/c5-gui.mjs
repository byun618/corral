// LIFE-561 C5 ⓒⓓⓔ — 개발 GUI(제어 소켓 실림)에서 이 레포 등록 → 사이드바 스크린샷 → 본체 행에 pane 1개 → `echo ok` → 닫기.
// l555/f-a6.mjs 의 흐름을 따른다. 판정은 종료코드(실패 수). 원자료는 <원자료 폴더> 에 둔다.
// 사용: node c5-gui.mjs <ctl.sock> <원자료 폴더> <등록할 레포 본체 경로>
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, out, repoRoot] = process.argv.slice(2)
const control = (request, timeout = 20_000) => rpc(sock, request, timeout)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`CHECK ${name} ${ok ? 'pass' : 'fail'}${detail ? ` (${detail})` : ''}`)
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
const count = async (selector) => ((await control({ cmd: 'query', selector })).found ?? []).length
const shot = async (name) => {
  const res = await control({ cmd: 'shot', name })
  if (!res.ok) throw new Error(`shot 실패 ${JSON.stringify(res).slice(0, 200)}`)
  fs.copyFileSync(res.file, path.join(out, `${name}.png`))
  console.log(`shot ${name}.png`)
}
const tabsOf = (s, wtPath) => {
  for (const repo of s.repos ?? []) for (const row of repo.worktrees ?? []) if (row.path === wtPath) return (row.workspace?.tabs ?? []).map((tab) => tab.tabId)
  return []
}
const brief = (s) => ({ selectedSession: s.selectedSession, sessions: s.sessions, sessionNote: s.sessionNote, backend: s.backend?.kind, link: s.link?.phase })

try {
  // 백엔드가 default 에 live 로 붙을 때까지 (자동 기동 포함)
  const live = await until(async () => { const s = await state(); return s.link?.phase === 'live' ? s : null }, 'link live', 60_000)
  console.log(`state_live=${JSON.stringify(brief(live))}`)
  check('e.selected_default', live.selectedSession === 'default', `selectedSession=${live.selectedSession}`)
  check('e.no_other_session_listed', (live.sessions ?? []).every((session) => session.name === 'default'), JSON.stringify(live.sessions))
  check('d.no_install_card', (await count('[data-backend-install]')) === 0)
  // ⓒ 이 레포 등록(격리 userData 라 비어 있다) → 사이드바
  const added = await control({ cmd: 'add-repo', root: repoRoot })
  console.log(`add-repo=${JSON.stringify(added).slice(0, 300)}`)
  const s0 = await until(async () => { const s = await state(); return (s.repos ?? []).length > 0 ? s : null }, '저장소 목록', 30_000)
  const rowsAll = []
  for (const repo of s0.repos) for (const row of repo.worktrees ?? []) rowsAll.push(row)
  console.log(`repos=${s0.repos.length} worktree_rows=${rowsAll.length}`)
  check('c.repos_nonempty', s0.repos.length > 0)
  check('c.sidebar_rows_nonempty', (await count('[data-worktree]')) > 0)
  check('c.control_no_such_selector', (await count('[data-l561-no-such]')) === 0)
  await shot('c5c-sidebar')
  // ⓓ pane 1개 — 레포 본체 행. 워크스페이스가 닫혀 있으면 행 클릭이 워크스페이스 + pane 1개를 연다
  const targetRow = rowsAll.find((row) => row.path === repoRoot) ?? rowsAll[0]
  const target = targetRow.path
  console.log(`target worktree=${target} workspace=${targetRow.workspace ? 'open' : 'closed'}`)
  const before = new Set(tabsOf(s0, target))
  let tabId
  check('d.select_row_click', (await control({ cmd: 'click', selector: `[data-worktree="${target}"] [data-worktree-card-surface]` })).ok === true)
  if (targetRow.workspace === null) {
    tabId = await until(async () => tabsOf(await state(), target)[0] ?? null, '워크스페이스 열림', 30_000)
  } else {
    await pause(800)
    check('d.plus_click', (await control({ cmd: 'click', selector: '[data-main-tabbar-add]' })).ok === true)
    await until(async () => (await count('[data-tab-create-item="new-terminal"]')) > 0, '+ 메뉴', 5_000)
    check('d.new_terminal_click', (await control({ cmd: 'click', selector: '[data-tab-create-item="new-terminal"]' })).ok === true)
    tabId = await until(async () => tabsOf(await state(), target).find((id) => !before.has(id)) ?? null, '새 탭', 20_000)
  }
  console.log(`new tab=${tabId}`)
  await until(async () => { const r = await control({ cmd: 'term-read' }); return r.ok && JSON.stringify(r.term).length > 40 ? r : null }, '터미널 준비', 20_000)
  await pause(1500)
  await control({ cmd: 'type', text: 'echo o""k' })
  await control({ cmd: 'key', keyCode: 'Return' })
  // 입력 줄은 `echo o""k` 라 `ok` 만 있는 줄은 출력에서만 나온다
  const okLine = (r) => JSON.stringify(r.term).match(/(^|\\n|")ok\s*(\\n|")/)
  const term = await until(async () => { const r = await control({ cmd: 'term-read' }); return r.ok && okLine(r) ? r : null }, 'echo ok 출력', 15_000)
  fs.writeFileSync(path.join(out, 'c5d-term-read.json'), `${JSON.stringify(term.term, null, 1)}\n`)
  check('d.echo_ok_seen', okLine(term) !== null)
  await shot('c5d-pane')
  const close = await control({ cmd: 'click', selector: `[data-main-tab-close="${tabId}"]` })
  check('d.close_click', close.ok === true)
  await pause(600)
  if ((await count('[data-close-confirm-ok]')) > 0) {
    console.log('close confirm modal=true')
    await control({ cmd: 'click', selector: '[data-close-confirm-ok]' })
  }
  await until(async () => !tabsOf(await state(), target).includes(tabId), '탭 닫힘', 15_000)
  check('d.tab_closed', !tabsOf(await state(), target).includes(tabId))
  check('d.no_install_card_after', (await count('[data-backend-install]')) === 0)
  const end = await state()
  console.log(`state_end=${JSON.stringify(brief(end))}`)
  check('e.selected_default_end', end.selectedSession === 'default')
} catch (error) {
  console.log(`ERROR ${error instanceof Error ? error.message : String(error)}`)
  fails += 1
}
console.log(`fails=${fails}`)
process.exit(fails)
