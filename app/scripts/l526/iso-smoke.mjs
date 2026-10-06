/* global document -- cdp.evaluate 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-526 K3ⓐ **격리** 동작 스모크 — 하단 바 네 버튼을 실제 포인터(CDP Input.dispatchMouseEvent)로 누른다.
// 격리 = launchCorral: --work(/tmp/l526i*) 아래 userData·herdr 세션(l443-gui-diff)·제어 소켓. 사용자 userData·herdr default 무접촉, provider 0.
//   ⚙ → 설정 페이지 · ? → 메뉴가 버튼 위로 열림 · ? 다시 → 닫힘 · ? → 「단축키」 → 설정 › 단축키 · ↻ → 재조회(main 로그 tree.built 증가) · ⌖ → 활성 카드 번쩍
// 준비 걸음(판정 아님): fixture 레포 등록(seedCorralRepo — add-repo 제어 소켓) · 첫 카드 실제 클릭(활성 워크스페이스). 설정 닫기는 「앱으로 돌아가기」 실제 클릭.
// 사용(저장소 루트): node app/scripts/l526/iso-smoke.mjs --app app --work /tmp/l526i --port 9526 --out <raw>
import fs from 'node:fs'
import path from 'node:path'
import { launchCorral, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'
import { pause } from '../gui-diff/lib/cdp.mjs'
import { probePreWipe } from './pre-wipe-guard.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l526i')) throw new Error('--work 는 /tmp/l526i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })

// 504 가드 — 같은 격리 경로(/tmp·/private/tmp 꼴)·herdr 세션·CDP 포트를 쓰는 프로세스가 있거나 확인을 못 하면 지우지 않고 멈춘다.
// fix2 — 옛 꼴은 pgrep 실패(종료코드 1 외의 오류 포함)를 「없음」으로 읽었고 /private/tmp 꼴·포트를 안 봤다(pre-wipe-guard.mjs 로 바꿈).
const guard = probePreWipe({ dirs: [work], ports: [Number(args.port)], session: 'l443-gui-diff' })
fs.writeFileSync(path.join(out, 'guard-before.json'), `${JSON.stringify(guard, null, 1)}\n`)
if (!guard.pass) {
  console.log(`[l526] 504 가드: 지우지 않고 멈춘다 — ${guard.reasons.join(' / ')}`)
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })

const result = { app: path.resolve(args.app), work, startedAt: new Date().toISOString(), steps: {}, checks: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-smoke.json'), `${JSON.stringify(result, null, 1)}\n`)
const check = ({ id, label, pass, detail }) => {
  result.checks.push({ id, label, pass, detail })
  console.log(`[l526] ${pass ? '통과' : '실패'} ${id} — ${label}`)
}
const owned = []
let handle = null
let exitCode = 0

const killOwned = async () => {
  const pids = owned.filter((entry) => entry.pid).map((entry) => entry.pid)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(2500)
  const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  for (const pid of alive) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
  return { pids, forced: alive }
}

try {
  const fixture = ensureFixtureRepo(work)
  handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  await seedCorralRepo(handle, fixture.root)
  const { cdp } = handle
  const evaluate = ({ fn, arg = null }) => cdp.evaluate(fn, arg)
  const until = async ({ label, probe, timeout = 10_000 }) => {
    const t0 = Date.now()
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() - t0 > timeout) throw new Error(`시간초과: ${label}`)
      await pause(120)
    }
  }
  const rectOf = (selector) => evaluate({ fn: (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }, arg: selector })
  /** 실제 포인터: 요소 가운데로 이동 → 누름 → 뗌. 버튼 onClick 을 직접 부르지 않는다. */
  const click = async (selector) => {
    const r = await until({ label: `요소 ${selector}`, probe: () => rectOf(selector) })
    const x = r.x + r.w / 2
    const y = r.y + r.h / 2
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    await pause(250)
    return { x, y }
  }
  const snap = () => evaluate({ fn: () => {
    const q = (sel) => document.querySelector(sel)
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
    return {
      settingsOpen: q('[data-settings-page]') !== null,
      shortcutsActive: q('[data-settings-nav-item="shortcuts"]')?.getAttribute('aria-current') ?? null,
      helpMenu: box(q('[data-help-menu]')),
      helpButton: box(q('[data-help-menu-toggle]')),
      helpExpanded: q('[data-help-menu-toggle]')?.getAttribute('aria-expanded') ?? null,
      flash: document.querySelector('.card-reveal-flash') !== null,
      activeCard: document.querySelector('[data-worktree-card-active]')?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null,
      footer: [...document.querySelectorAll('[data-sidebar-footer] button')].map((b) => ({ label: b.getAttribute('aria-label'), attrs: b.getAttributeNames().filter((n) => n.startsWith('data-') || n.startsWith('aria-')), svg: b.querySelector('svg') !== null, text: b.textContent }))
    }
  } })
  // main 로그는 userData 의 corral.ndjson 에 쌓인다(run1 실측 — runtime/desktop.log 에는 tree.built 가 없다).
  const desktopLog = path.join(handle.paths.userData, 'corral.ndjson')
  const treeBuilt = () => (fs.existsSync(desktopLog) ? fs.readFileSync(desktopLog, 'utf8').split('\n').filter((line) => line.includes('tree.built')).length : 0)

  await until({ label: '하단 바', probe: () => rectOf('[data-sidebar-footer]') })
  await pause(1500)
  result.steps.initial = await snap()
  check({ id: 'K1d-wiring', label: '네 버튼 배선(data-·aria-) 유지, 전부 svg·글자 없음, aria-label 4개', pass: result.steps.initial.footer.length === 4 && result.steps.initial.footer.every((b) => b.svg && b.text === '' && b.label), detail: result.steps.initial.footer })

  // ⚙ → 설정 페이지
  await click('[data-settings-open]')
  await until({ label: '설정 열림', probe: async () => (await snap()).settingsOpen })
  result.steps.settings = await snap()
  check({ id: 'K3a-settings', label: '⚙ 클릭 → 설정 페이지', pass: result.steps.settings.settingsOpen, detail: { settingsOpen: result.steps.settings.settingsOpen } })
  await click('[data-settings-back]')
  await until({ label: '설정 닫힘', probe: async () => !(await snap()).settingsOpen })

  // ? → 메뉴가 버튼 위로 · 다시 → 닫힘
  await click('[data-help-menu-toggle]')
  await until({ label: '도움말 메뉴', probe: async () => (await snap()).helpMenu !== null })
  const opened = await snap()
  result.steps.helpOpen = opened
  check({ id: 'K3a-help-above', label: '? 클릭 → 메뉴 열림, 메뉴 아랫변 ≤ 버튼 윗변(위로 열림), aria-expanded=true', pass: opened.helpMenu !== null && opened.helpMenu.y + opened.helpMenu.h <= opened.helpButton.y + 0.5 && opened.helpExpanded === 'true', detail: { menu: opened.helpMenu, button: opened.helpButton, expanded: opened.helpExpanded } })
  await click('[data-help-menu-toggle]')
  await pause(300)
  const closed = await snap()
  result.steps.helpClosed = closed
  check({ id: 'K3a-help-toggle', label: '? 다시 클릭 → 메뉴 닫힘, aria-expanded=false', pass: closed.helpMenu === null && closed.helpExpanded === 'false', detail: { menu: closed.helpMenu, expanded: closed.helpExpanded } })

  // ? → 「단축키」 → 설정 › 단축키
  await click('[data-help-menu-toggle]')
  await until({ label: '도움말 메뉴(2)', probe: async () => (await snap()).helpMenu !== null })
  await click('[data-help-menu] [data-menu-action="shortcuts"]')
  await until({ label: '설정 › 단축키', probe: async () => (await snap()).settingsOpen })
  result.steps.shortcuts = await snap()
  check({ id: 'K3a-help-shortcuts', label: '? → 「단축키」 → 설정 › 단축키(내비 aria-current=page)', pass: result.steps.shortcuts.settingsOpen && result.steps.shortcuts.shortcutsActive === 'page', detail: { settingsOpen: result.steps.shortcuts.settingsOpen, shortcutsActive: result.steps.shortcuts.shortcutsActive } })
  await click('[data-settings-back]')
  await until({ label: '설정 닫힘(2)', probe: async () => !(await snap()).settingsOpen })

  // ↻ → 재조회: 조용한 3초(대조) 동안 tree.built 가 늘지 않고, 클릭 뒤 3초 안에 는다
  await pause(3000)
  const idle0 = treeBuilt()
  await pause(3000)
  const idle1 = treeBuilt()
  await click('[data-refresh-tree]')
  let after = idle1
  for (let i = 0; i < 25 && after === idle1; i += 1) { await pause(120); after = treeBuilt() }
  result.steps.refresh = { desktopLog, idleBefore: idle0, idleAfter3s: idle1, afterClick: after }
  check({ id: 'K3a-refresh', label: '↻ 클릭 → 재조회(main tree.built 로그 증가). 대조: 클릭 없는 3초 동안 증가 0', pass: idle1 === idle0 && after > idle1, detail: result.steps.refresh })

  // ⌖ → 활성 카드 번쩍. 준비: 첫 카드를 실제 클릭해 활성 워크스페이스를 만든다(run1 — 갓 띄운 격리 인스턴스는 활성이 없어 Reveal 이 할 일이 없다).
  await click('[data-worktree-card-surface]')
  await until({ label: '활성 카드', probe: async () => (await snap()).activeCard !== null, timeout: 20_000 })
  await pause(1500)
  const before = await snap()
  await click('[data-reveal-active]')
  let flashed = null
  for (let i = 0; i < 20 && !flashed; i += 1) { const now = await snap(); if (now.flash) flashed = now; else await pause(60) }
  result.steps.reveal = { activeCard: before.activeCard, flash: flashed !== null }
  check({ id: 'K3a-reveal', label: '⌖ 클릭 → 활성 카드 번쩍(.card-reveal-flash)', pass: before.activeCard !== null && flashed !== null, detail: result.steps.reveal })

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((shot) => fs.writeFileSync(path.join(out, 'final.png'), Buffer.from(shot.data, 'base64')))
  exitCode = result.checks.every((row) => row.pass) ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[l526] 오류', result.error)
  exitCode = 2
} finally {
  await handle?.cdp.close().catch(() => {})
  result.shutdown = await killOwned()
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
}
process.exit(exitCode)
