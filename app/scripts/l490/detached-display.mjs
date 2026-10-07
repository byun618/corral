// LIFE-491 K5ⓑ·K6 — detached HEAD 워크트리가 섞인 실제 git fixture 에서 카드·필터·정렬·검색·대화를 DOM 덤프 + 캡처로 남긴다.
//
// fixture `det-repo`(커밋 3개): 주 체크아웃(main) · 브랜치 링크 `wt/feat`(feat-x) · detached 링크 `wt/da`(c1)·`wt/db`(c2)·`wt/dn`(c3, 표시 이름
// `named-det` — CLI `worktree set --display-name`). 링크 폴더 이름(da·db·dn)이 레포 이름(det-repo)과 달라 「레포 이름 폴백」 과 「폴더 이름 폴백」 이 갈린다.
// 판정에 쓰는 값은 모두 원자료에 남긴다 — 기대값(git rev-parse HEAD, 198 문구)과 관측값을 같은 파일에.
// 기준 빌드로 같은 하네스를 돌리면 `(detached)` 가 화면에 나온다(양성 대조).
// 사용: node <이 파일> --app <앱 루트> --out <raw 폴더> [--work /tmp/l490d] [--port 9493]
// 결과: <out>/result.json · <out>/*.png. 종료코드 0 = 완주(판정은 값으로).

/* global document */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs, git, commit, buildIdentity, launchIsolated, rpc, until, pause, appState, clickAt } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const appRoot = path.resolve(String(args.app))
const work = path.resolve(String(args.work ?? '/tmp/l490d'))
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9493)
fs.mkdirSync(out, { recursive: true })
const log = (...parts) => console.log('[l490-detached]', ...parts)
const identity = buildIdentity(appRoot)
const result = { identity, steps: {} }
let handle = null
let alive = []

const shot = async (cdp, name, clip = null) => {
  const response = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip === null ? {} : { clip: { ...clip, scale: 1 } }) })
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(response.data, 'base64'))
  return `${name}.png`
}

/** 카드 하나의 표시 덤프 — 제목·메타 줄·브랜치 칸·detached 배지(문구·툴팁)·HTML 에 `(detached)` 가 있나. */
const dumpCards = (cdp) => cdp.evaluate(() => [...document.querySelectorAll('[data-worktree]')].map((row) => {
  const badge = row.querySelector('[data-worktree-detached-head]')
  const meta = row.querySelector('[data-worktree-card-meta-row]')
  const branch = row.querySelector('[data-worktree-meta-branch]')
  return {
    path: row.getAttribute('data-worktree'),
    title: row.querySelector('[data-worktree-title]')?.textContent ?? null,
    titleTooltip: row.querySelector('[data-worktree-title]')?.getAttribute('title') ?? null,
    layout: row.querySelector('[data-card-layout]')?.getAttribute('data-card-layout') ?? null,
    metaText: meta?.textContent ?? null,
    branchCell: branch === null ? null : { text: branch.textContent, title: branch.getAttribute('title') },
    badge: badge === null ? null : { shortHead: badge.getAttribute('data-worktree-detached-head'), text: badge.textContent, title: badge.getAttribute('title'), ariaLabel: badge.getAttribute('aria-label') },
    hasDetachedText: row.outerHTML.includes('(detached)'),
  }
}))

const rightClick = async (cdp, point) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
}
const centerOf = (cdp, selector) => cdp.evaluate((s) => {
  const el = document.querySelector(s)
  el?.scrollIntoView({ block: 'center' })
  const r = el?.getBoundingClientRect()
  return r ? { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 } : null
}, selector)
const clickSel = async (cdp, selector) => {
  const point = await until(() => centerOf(cdp, selector), `click ${selector}`, 5_000, 50)
  await clickAt(cdp, point)
}
const escape = async (cdp) => {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await pause(300)
}
const optionsDo = async (cdp, steps) => {
  await clickSel(cdp, '[data-sidebar-options]')
  await until(() => cdp.evaluate(() => document.querySelector('[data-sidebar-options-menu]') !== null), 'options menu', 5_000, 50)
  for (const selector of steps) {
    // 서브메뉴 트리거는 마우스가 올라가면 열리고, 열린 채 누르면 닫힌다(`SidebarOptionsMenu` subTrigger) — 올리기만 하고 열림을 기다린다.
    if (selector.includes('data-submenu-trigger')) {
      const point = await until(() => centerOf(cdp, selector), `hover ${selector}`, 5_000, 50)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
      await until(() => cdp.evaluate(() => document.querySelector('[data-options-submenu]') !== null), 'submenu', 5_000, 50)
    } else await clickSel(cdp, selector)
    await pause(250)
  }
  if (await cdp.evaluate(() => document.querySelector('[data-sidebar-options-menu]') !== null)) await escape(cdp)
  await pause(600)
}

async function main() {
  const fixtures = `${work}-repos`
  if (fs.existsSync(fixtures)) fs.rmSync(fixtures, { recursive: true, force: true })
  const root = path.join(fixtures, 'det-repo')
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  commit(root, 'c1')
  const c1 = git(root, 'rev-parse', 'HEAD')
  commit(root, 'c2')
  const c2 = git(root, 'rev-parse', 'HEAD')
  commit(root, 'c3')
  const c3 = git(root, 'rev-parse', 'HEAD')
  git(root, 'worktree', 'add', '-q', '-b', 'feat-x', path.join(fixtures, 'wt', 'feat'))
  git(root, 'worktree', 'add', '-q', '--detach', path.join(fixtures, 'wt', 'da'), c1)
  git(root, 'worktree', 'add', '-q', '--detach', path.join(fixtures, 'wt', 'db'), c2)
  git(root, 'worktree', 'add', '-q', '--detach', path.join(fixtures, 'wt', 'dn'), c3)
  const mainPath = fs.realpathSync(root)
  const wt = (name) => fs.realpathSync(path.join(fixtures, 'wt', name))
  const expected = Object.fromEntries(['feat', 'da', 'db', 'dn'].map((name) => [wt(name), { head: git(wt(name), 'rev-parse', 'HEAD'), branch: name === 'feat' ? 'feat-x' : null }]))
  expected[mainPath] = { head: git(mainPath, 'rev-parse', 'HEAD'), branch: 'main' }
  result.fixture = { root: mainPath, commits: { c1, c2, c3 }, expected, porcelain: git(root, 'worktree', 'list', '--porcelain') }

  handle = await launchIsolated({ appRoot, work, out, port, session: 'l490-detached' })
  const { cdp } = handle
  await rpc(handle.control, { cmd: 'add-repo', root: mainPath })
  await until(async () => {
    await rpc(handle.control, { cmd: 'rebuild-tree' }, 30_000)
    return (await cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length)) === 5 ? true : null
  }, 'rendered', 60_000, 500)

  // 표시 이름 — CLI `worktree set` (GUI 와 같은 레지스트리 칸, LIFE-478).
  const set = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'worktree', 'set', '--worktree', `path:${wt('dn')}`, '--display-name', 'named-det', '--json'], { env: handle.env, encoding: 'utf8', timeout: 60_000 })
  result.steps.setDisplayName = { status: set.status, stdout: set.stdout.slice(0, 2000), stderr: set.stderr.slice(0, 2000) }
  await until(async () => {
    await rpc(handle.control, { cmd: 'rebuild-tree' }, 30_000)
    return (await cdp.evaluate((p) => document.querySelector(`[data-worktree="${p}"] [data-worktree-title]`)?.textContent ?? null, wt('dn'))) === 'named-det' ? true : null
  }, 'display name', 20_000, 300).catch(() => null)
  await pause(500)

  // ⓑ 앱 state 덤프 — branch null · head = git rev-parse HEAD.
  const state = await appState(handle)
  const repo = state.repos.find((item) => item.root === mainPath)
  result.steps.state = { repoName: repo?.name ?? null, rows: repo?.worktrees.map((row) => ({ path: row.path, branch: row.branch, head: row.head ?? '(칸 없음)', repoName: row.repoName ?? '(칸 없음)', displayName: row.displayName })) ?? [] }

  // ⓐⓑⓒⓓ Detailed 카드 덤프 + 캡처.
  result.steps.detailed = await dumpCards(cdp)
  result.steps.detailedBodyHasDetached = await cdp.evaluate(() => document.body.innerHTML.includes('(detached)'))
  const sidebarRect = await cdp.evaluate(() => {
    const r = document.querySelector('.sidebar')?.getBoundingClientRect()
    return r ? { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, 900) } : null
  })
  result.steps.shots = [await shot(cdp, 'k6-detailed-sidebar', sidebarRect)]
  for (const name of ['da', 'db']) {
    const rect = await cdp.evaluate((p) => {
      const r = document.querySelector(`[data-worktree="${p}"]`)?.getBoundingClientRect()
      return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
    }, wt(name))
    if (rect !== null) result.steps.shots.push(await shot(cdp, `k6-card-${name}`, rect))
  }

  // ⓔ 「detached HEAD 숨기기」 켜기 → 끄기.
  await optionsDo(cdp, ['[data-options-filter="hide-detached-head"]'])
  result.steps.hideOn = await cdp.evaluate(() => [...document.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')))
  await optionsDo(cdp, ['[data-options-filter="hide-detached-head"]'])
  result.steps.hideOff = await cdp.evaluate(() => [...document.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')))

  // ⓕ 이름 정렬 — 화면 순서의 제목이 사전순인가(제목과 정렬 키가 같은 함수).
  await optionsDo(cdp, ['[data-submenu-trigger="sort"]', '[data-options-radio="sort-name"]'])
  result.steps.sortName = await cdp.evaluate(() => [...document.querySelectorAll('[data-worktree]')].map((row) => ({ path: row.getAttribute('data-worktree'), title: row.querySelector('[data-worktree-title]')?.textContent ?? null })))
  await optionsDo(cdp, ['[data-submenu-trigger="sort"]', '[data-options-radio="sort-manual"]'])

  // ⓕ 사이드바 검색(팔레트) — 레포 이름으로 찾으면 detached 워크트리가 나오나, 항목 제목은 무엇인가.
  await clickSel(cdp, '[data-sidebar-search]')
  await until(() => cdp.evaluate(() => document.activeElement?.tagName === 'INPUT'), 'palette input', 5_000, 50)
  await cdp.send('Input.insertText', { text: 'det-repo' })
  await pause(500)
  result.steps.palette = await cdp.evaluate(() => [...document.querySelectorAll('[data-palette-entry]')].map((el) => ({ id: el.getAttribute('data-palette-entry'), title: el.getAttribute('title') })))
  result.steps.shots.push(await shot(cdp, 'k6-palette'))
  await escape(cdp)

  // ⓖ 삭제 대화(da) — 브랜치 줄이 없고 `(detached)` 가 없다.
  const daCard = await centerOf(cdp, `[data-worktree="${wt('da')}"] [data-worktree-title]`)
  await rightClick(cdp, daCard)
  await until(() => cdp.evaluate(() => document.querySelector('[data-context-menu] [data-menu-action="delete"]') !== null), 'card menu', 5_000, 50)
  await clickSel(cdp, '[data-context-menu] [data-menu-action="delete"]')
  await until(() => cdp.evaluate(() => document.querySelector('[data-delete-facts], [data-delete-preview-error]') !== null), 'delete preview', 10_000, 100).catch(() => null)
  result.steps.deleteDialog = await cdp.evaluate(() => {
    const el = document.querySelector('[data-delete-worktree-dialog]')
    return el === null ? null : { text: el.textContent, hasBranchLine: el.querySelector('[data-delete-branch]') !== null, hasDetachedText: el.innerHTML.includes('(detached)') }
  })
  result.steps.shots.push(await shot(cdp, 'k6-delete-dialog'))
  await clickSel(cdp, '[data-delete-cancel]').catch(() => escape(cdp))
  await pause(400)

  // ⓖ 메타 편집 대화(da) — 제목 밖 더블클릭. 표시 이름 칸의 placeholder.
  const daSurface = await cdp.evaluate((p) => {
    const r = document.querySelector(`[data-worktree="${p}"] [data-worktree-card-meta-row]`)?.getBoundingClientRect()
    return r ? { x: r.right - 4, y: r.top + r.height / 2 } : null
  }, wt('da'))
  if (daSurface !== null)
    for (const clickCount of [1, 2])
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: daSurface.x, y: daSurface.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount })
  await until(() => cdp.evaluate(() => document.querySelector('[data-worktree-meta-dialog]') !== null), 'meta dialog', 5_000, 50).catch(() => null)
  result.steps.metaDialog = await cdp.evaluate(() => {
    const el = document.querySelector('[data-worktree-meta-dialog]')
    return el === null ? null : { placeholder: el.querySelector('[data-meta-display-name]')?.getAttribute('placeholder') ?? null, hint: el.querySelector('.field-hint')?.textContent ?? null, hasDetachedText: el.innerHTML.includes('(detached)'), text: el.textContent }
  })
  await escape(cdp)

  // ⓖ 부모 선택(feat 의 상위 지정) — 후보 목록에 detached 행의 이름·브랜치 칸.
  const featCard = await centerOf(cdp, `[data-worktree="${wt('feat')}"] [data-worktree-title]`)
  await rightClick(cdp, featCard)
  await until(() => cdp.evaluate(() => document.querySelector('[data-context-menu] [data-menu-action="set-parent"]') !== null), 'card menu', 5_000, 50)
  await clickSel(cdp, '[data-context-menu] [data-menu-action="set-parent"]')
  await until(() => cdp.evaluate(() => document.querySelector('[data-parent-picker]') !== null), 'parent picker', 5_000, 50).catch(() => null)
  result.steps.parentPicker = await cdp.evaluate(() => [...document.querySelectorAll('[data-parent-candidate]')].map((el) => ({ path: el.getAttribute('data-parent-candidate'), text: el.textContent, hasDetachedText: el.innerHTML.includes('(detached)') })))
  result.steps.shots.push(await shot(cdp, 'k6-parent-picker'))
  await escape(cdp)

  // ⓖ Compact — 198 처럼 메타 줄 배지 없음. 제목은 같은 함수.
  await optionsDo(cdp, ['[data-submenu-trigger="card-layout"]', '[data-options-radio="card-layout-compact"]'])
  result.steps.compact = await dumpCards(cdp)
  result.steps.compactBodyHasDetached = await cdp.evaluate(() => document.body.innerHTML.includes('(detached)'))
  result.steps.shots.push(await shot(cdp, 'k6-compact-sidebar', sidebarRect))
  await optionsDo(cdp, ['[data-submenu-trigger="card-layout"]', '[data-options-radio="card-layout-detailed"]'])
  result.steps.detailedAgain = (await dumpCards(cdp)).map((card) => ({ path: card.path, layout: card.layout }))
  // fix1 F3 (r1 L2·G-5) — 상태바: detached 워크트리(da)를 카드 클릭으로 열어 활성 → 상태바 라벨(절대경로·`(detached)` 가 아니어야).
  await clickAt(cdp, await centerOf(cdp, `[data-worktree="${wt('da')}"] [data-worktree-title]`))
  const statusText = await until(async () => {
    const text = await cdp.evaluate(() => document.querySelector('[data-statusbar] .statusbar-repo')?.textContent ?? null)
    return text !== null && text !== 'corral' ? text : null
  }, 'statusbar label', 20_000, 200).catch(() => null)
  result.steps.statusbar = {
    text: statusText,
    activeMark: await cdp.evaluate(() => document.querySelector('[data-worktree-card-active="primary"]')?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null),
    hasDetachedText: statusText?.includes('(detached)') ?? null,
    hasAbsolutePath: statusText?.includes(fixtures) ?? null,
  }
  const statusRect = await cdp.evaluate(() => {
    const r = document.querySelector('[data-statusbar]')?.getBoundingClientRect()
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
  })
  if (statusRect !== null) result.steps.shots.push(await shot(cdp, 'k6-statusbar-da', statusRect))
  result.expectedRepoName = repo?.name ?? null
}

let exitCode = 0
try {
  await main()
} catch (error) {
  exitCode = 2
  result.error = String(error?.stack ?? error)
  handle ??= error.handle ?? null
} finally {
  if (handle !== null) alive = await handle.stop()
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...result, spawned: handle?.spawned ?? [], alive }, null, 2))
  log(`done error=${result.error ? 'yes' : 'no'} alive=${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
