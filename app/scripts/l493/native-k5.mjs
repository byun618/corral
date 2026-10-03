// LIFE-493 K5 네이티브 관문 드라이버 — 사용자 userData + 구현 브랜치 빌드 + herdr 정식 `default` 세션(LIFE-456 S9 B안).
// native-up.sh 가 띄운 앱에 제어 소켓(ROOT/ctl.sock)으로 붙는다. 입력은 제어 소켓의 `click`·`dblclick`·`raw-mouse`·`type`·`key`
// (Chromium `sendInputEvent` — 히트테스트·가림 판정을 크로미움이 한다)로, pane 안 명령은 herdr CLI(`pane run`)로 넣는다.
//
// **원자료 경계 (사용자 데이터 비공개)**: 캡처는 fixture 탭바 영역만(`[data-group-header=…]` 선택자 캡처) 찍고, 덤프는 fixture
// 워크스페이스의 탭만 적는다 — 사이드바·다른 워크스페이스·창 전체는 찍지도 적지도 않는다. 활성 워크스페이스가 fixture 가 아니면 멈춘다.
// provider 는 **한 줄 프롬프트**로 상태만 만든다(쿼터 보호). codex 는 기동만(프롬프트 없음, 업데이트 안내 끔). 어떤 신뢰·권한 화면에도
// 답하지 않는다 — 끝에 탭을 닫아 정리한다.
//
// 사용: node native-k5.mjs <ROOT> <raw 폴더> <fixture 경로(realpath)>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [root, rawd, fixture] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l493n')) throw new Error('ROOT 는 /tmp/l493n*')
const ctl = path.join(root, 'ctl.sock')
const HERDR = '/opt/homebrew/bin/herdr'
const shotsOut = path.join(rawd, 'shots')
fs.mkdirSync(shotsOut, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = []
const record = (step, ok, detail) => {
  const entry = { step, ok, at: new Date().toISOString(), ...detail }
  log.push(entry)
  console.log(`[k5] ${ok === null ? '…' : ok ? '✔' : '✘'} ${step}`, JSON.stringify(detail).slice(0, 300))
  fs.writeFileSync(path.join(rawd, 'k5-log.json'), `${JSON.stringify(log, null, 1)}\n`)
}
const control = async (request, timeout = 20_000) => rpc(ctl, request, timeout)
const herdr = (...args) => execFileSync(HERDR, ['--session', 'default', ...args], { encoding: 'utf8' })
async function until(fn, label, timeout = 30_000, every = 300) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}

/** fixture worktree 의 열린 워크스페이스 — main 상태(제어 소켓 `state`)에서. */
async function fixtureWorkspace() {
  const res = await control({ cmd: 'state' })
  for (const repo of res.state.repos) for (const row of repo.worktrees) if (row.path === fixture) return row.workspace ?? null
  return null
}

/** 화면 읽기 — fixture 워크스페이스의 탭만. 다른 탭이 탭바에 보이면 `foreign` 수만 센다(내용은 안 적는다). */
async function readTabbar() {
  const ws = await fixtureWorkspace()
  const mine = (ws?.tabs ?? []).map((tab) => tab.tabId)
  const res = await control({
    cmd: 'eval',
    code: `(() => {
      const mine = new Set(${JSON.stringify(mine)})
      return {
        attention: document.documentElement.dataset.windowAttention ?? null,
        groups: [...document.querySelectorAll('[data-main-tabbar]')].map((bar) => {
          const strip = bar.querySelector('[data-main-tab-strip]')
          const sr = strip.getBoundingClientRect()
          const all = [...bar.querySelectorAll('[data-main-tab]')]
          const tabs = all.filter((tab) => mine.has(tab.dataset.mainTab)).map((tab) => {
            const r = tab.getBoundingClientRect()
            const close = tab.querySelector('[data-tab-close-button]')
            return {
              id: tab.dataset.mainTab,
              active: tab.dataset.active === 'true',
              label: tab.querySelector('.main-tab-label')?.textContent ?? null,
              lead: tab.querySelector('[data-tab-unread-bell]') ? 'bell' : (tab.querySelector('[data-tab-activity]')?.dataset.tabActivity ?? (tab.querySelector('[data-agent-kind]') ? 'logo' : (tab.querySelector('[data-shell-icon]') ? 'shell' : 'none'))),
              agent: tab.querySelector('[data-agent-kind]')?.dataset.agentKind ?? null,
              wash: tab.querySelector('.main-tab-unread-wash') !== null,
              closeColor: close ? getComputedStyle(close).color : null,
              x: Math.round(r.left * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
              inView: r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5,
            }
          })
          return {
            group: bar.dataset.groupHeader,
            barHeight: Math.round(bar.getBoundingClientRect().height * 10) / 10,
            strip: { scrollLeft: Math.round(strip.scrollLeft), scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth },
            foreign: all.length - tabs.length,
            tabs,
          }
        }),
      }
    })()`,
  })
  return res.result
}

async function dump(tag) {
  const seen = await readTabbar()
  fs.writeFileSync(path.join(rawd, `state-${tag}.json`), `${JSON.stringify(seen, null, 1)}\n`)
  return seen
}

/** 탭바 영역만 캡처 — 영역마다 하나. */
async function shot(tag) {
  const seen = await readTabbar()
  const files = []
  for (const group of seen.groups) {
    if (group.foreign > 0) throw new Error(`탭바에 fixture 밖 탭이 있다 — 캡처하지 않는다 (${group.foreign})`)
    const res = await control({ cmd: 'shot', name: `l493-${tag}-${group.group}`, selector: `[data-group-header="${group.group}"]` })
    if (!res.ok) throw new Error(`shot 실패: ${JSON.stringify(res).slice(0, 200)}`)
    const target = path.join(shotsOut, `${tag}-${group.group}.png`)
    fs.copyFileSync(res.file, target)
    files.push(path.relative(rawd, target))
  }
  return files
}

const tabSel = (tabId) => `[data-main-tab="${tabId}"]`
async function tabRect(tabId) {
  const res = await control({ cmd: 'rect', selector: tabSel(tabId) })
  return res.rect ?? res.result ?? res
}
async function paneOf(tabId) {
  const ws = await fixtureWorkspace()
  return ws?.tabs.find((tab) => tab.tabId === tabId)?.panes[0]?.paneId ?? null
}
async function newTab() {
  const before = new Set(((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId))
  const click = await control({ cmd: 'click', selector: '[data-main-tabbar-add]' })
  if (!click.ok) throw new Error(`+ 클릭 실패 ${JSON.stringify(click).slice(0, 200)}`)
  return until(async () => ((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId).find((id) => !before.has(id)) ?? null, '새 탭', 20_000)
}
async function paneStatus(tabId) {
  const ws = await fixtureWorkspace()
  const pane = ws?.tabs.find((tab) => tab.tabId === tabId)?.panes[0]
  return pane === undefined ? null : { agent: pane.agent, status: pane.agentStatus, reason: pane.agentState.blockedReason }
}
async function leadOf(tabId) {
  for (const group of (await readTabbar()).groups) {
    const tab = group.tabs.find((row) => row.id === tabId)
    if (tab) return tab
  }
  return null
}

async function main() {
  // ① fixture 레포를 사이드바에 더하고 그 카드를 눌러 연다 (제품 경로 — add-repo 는 등록 핸들러, 카드는 실제 클릭).
  const added = await control({ cmd: 'add-repo', root: fixture })
  await control({ cmd: 'rebuild-tree' })
  await until(async () => ((await control({ cmd: 'query', selector: `[data-worktree="${fixture}"]` })).found ?? []).length > 0, 'fixture 카드', 30_000)
  // 카드 바깥 상자 가운데는 카드 표면이 아닐 수 있다(1회차: 워크스페이스는 열렸지만 선택이 안 넘어왔다) — 표면을 누른다.
  const card = await control({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
  const ws = await until(async () => ((await fixtureWorkspace())?.tabs.length ?? 0) > 0 && (await fixtureWorkspace()), 'fixture 워크스페이스 열림', 30_000)
  const fixtureIds = new Set(ws.tabs.map((tab) => tab.tabId))
  // 처음 여는 카드는 첫 클릭에 워크스페이스만 생기고 화면이 안 넘어온 일이 두 번 있었다(attempt1·3) — 넘어올 때까지 다시 누르고 횟수를 남긴다.
  const showsFixture = async () => {
    const dom = (await control({ cmd: 'eval', code: `[...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab)` })).result
    return dom.length > 0 && dom.every((id) => fixtureIds.has(id))
  }
  let cardClicks = 1
  for (;;) {
    if (await until(showsFixture, '탭바가 fixture 워크스페이스', 5_000).then(() => true, () => false)) break
    if (cardClicks >= 4) throw new Error(`카드 ${cardClicks}번 눌러도 fixture 화면이 아니다`)
    await control({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
    cardClicks += 1
  }
  await pause(1500)
  record('open-fixture', true, { added: added.ok ?? null, cardClick: card.ok, cardClicks, workspace: ws.workspaceId, tabs: ws.tabs.length })
  const shellTab = ws.tabs[0].tabId
  await dump('01-one-shell-tab')
  record('one-tab', true, { shots: await shot('01-one-shell-tab') })

  // ② claude 작업 중 → 완료(다른 탭을 보는 동안 끝나 안 읽음 벨)
  const claudeDone = await newTab()
  herdr('pane', 'run', await paneOf(claudeDone), 'claude "Write a numbered list of 40 short fruit names, one per line. No tools."')
  await until(async () => (await paneStatus(claudeDone))?.status === 'working', 'claude working', 60_000)
  await until(async () => (await leadOf(claudeDone))?.lead === 'working', '탭 선두 스피너', 15_000)
  await dump('02-claude-working')
  record('claude-working', true, { pane: await paneStatus(claudeDone), lead: await leadOf(claudeDone), shots: await shot('02-claude-working') })
  // 셸 탭을 눌러 다른 탭을 본다 — 완료가 안 본 채로 나야 벨이 선다.
  await control({ cmd: 'click', selector: tabSel(shellTab) })
  await until(async () => ['idle', 'done'].includes((await paneStatus(claudeDone))?.status ?? ''), 'claude 턴 끝', 180_000, 1000)
  const bell = await until(async () => { const tab = await leadOf(claudeDone); return tab?.lead === 'bell' ? tab : null }, '탭 벨', 15_000).catch(() => null)
  await dump('03-claude-done-unread')
  record('claude-done-unread-bell', bell !== null, { pane: await paneStatus(claudeDone), lead: await leadOf(claudeDone), shots: await shot('03-claude-done-unread') })

  // ③ claude 대기(blocked·question) — 질문 도구를 쓰게 한다. 답하지 않는다.
  // (r2: `touch` 는 사용자 권한 설정에서 허용돼 막히지 않고 끝났다 — k5/r2/k5-log.json claude-permission)
  const claudePerm = await newTab()
  herdr('pane', 'run', await paneOf(claudePerm), 'claude "Use the AskUserQuestion tool to ask me whether I prefer apples or pears. Do nothing else."')
  const blocked = await until(async () => { const s = await paneStatus(claudePerm); return s?.status === 'blocked' ? s : null }, 'claude blocked', 120_000, 1000).catch(() => null)
  const permLead = await until(async () => { const tab = await leadOf(claudePerm); return tab && ['waiting', 'blocked'].includes(tab.lead) ? tab : null }, '탭 선두 질문/막힘', 15_000).catch(() => null)
  await dump('04-claude-permission')
  record('claude-permission', blocked !== null && permLead !== null, { pane: await paneStatus(claudePerm), lead: await leadOf(claudePerm), shots: await shot('04-claude-permission') })

  // ④ grok·codex 로고 — 기동만. codex 는 업데이트 안내 끔·프롬프트 없음. 어떤 화면에도 답하지 않는다.
  const grokTab = await newTab()
  herdr('pane', 'run', await paneOf(grokTab), 'grok')
  const grokSeen = await until(async () => { const tab = await leadOf(grokTab); return tab?.agent === 'grok' ? tab : null }, 'grok 로고', 60_000, 1000).catch(() => null)
  const codexTab = await newTab()
  herdr('pane', 'run', await paneOf(codexTab), 'codex -c check_for_update_on_startup=false')
  const codexSeen = await until(async () => { const tab = await leadOf(codexTab); return tab?.agent === 'codex' ? tab : null }, 'codex 로고', 60_000, 1000).catch(() => null)
  await pause(2000)
  await dump('05-grok-codex')
  record('grok-codex-logo', grokSeen !== null && codexSeen !== null, { grok: { pane: await paneStatus(grokTab), lead: await leadOf(grokTab) }, codex: { pane: await paneStatus(codexTab), lead: await leadOf(codexTab) }, shots: await shot('05-grok-codex') })

  // ⑤ 닫기 노출 — 활성 상시·비활성 hover. 비활성 탭 위로 커서만 옮겨 글자색을 잰다.
  await control({ cmd: 'click', selector: tabSel(shellTab) })
  await pause(400)
  const rest = await readTabbar()
  const inactive = rest.groups[0].tabs.find((tab) => !tab.active)
  const r = await tabRect(inactive.id)
  const cx = Math.round((r.x ?? r.left) + (r.width ?? r.w) / 2)
  const cy = Math.round((r.y ?? r.top) + (r.height ?? r.h) / 2)
  await control({ cmd: 'raw-mouse', type: 'mouseMove', x: cx, y: cy })
  await pause(300)
  const hovered = await leadOf(inactive.id)
  const activeTab = (await readTabbar()).groups[0].tabs.find((tab) => tab.active)
  await control({ cmd: 'raw-mouse', type: 'mouseMove', x: 5, y: 5 })
  record('close-visibility', activeTab.closeColor !== 'rgba(0, 0, 0, 0)' && inactive.closeColor === 'rgba(0, 0, 0, 0)', {
    activeClose: activeTab.closeColor, inactiveClose: inactive.closeColor,
  })
  // hover 노출은 주입 불가 — sendInputEvent mouseMove 는 :hover 를 세우지 않는다(r2 탐침: 그 점의 요소는 라벨인데 matches(':hover') false).
  // 측정 도구도 hover 를 UNINJECTABLE 로 둔다. 판정 보류, 사용자 확인(K6)으로 넘긴다.
  record('close-hover', null, { inactiveHoveredClose: hovered.closeColor, note: '주입 불가 — 보류' })

  // ⑥ 다중 영역 — 셸 탭 우클릭 → 「오른쪽 영역」 (실제 우클릭 → 메뉴 항목 클릭)
  const sr = await tabRect(shellTab)
  const sx = Math.round((sr.x ?? sr.left) + 20)
  const sy = Math.round((sr.y ?? sr.top) + 10)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: sx, y: sy, button: 'right' })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: sx, y: sy, button: 'right' })
  await pause(300)
  const moved = await control({ cmd: 'click', selector: '[data-tab-menu-move-right]' })
  const two = await until(async () => { const seen = await readTabbar(); return seen.groups.length === 2 ? seen : null }, '영역 2개', 15_000).catch(() => null)
  await dump('06-two-areas')
  record('two-areas', two !== null, { menuClick: moved.ok, groups: two?.groups.map((group) => ({ group: group.group, tabs: group.tabs.length, widths: group.tabs.map((tab) => tab.w) })), shots: await shot('06-two-areas') })

  // ⑦ 넘침 — 둘째 영역(셸 탭이 옮겨 간 곳)에 탭을 20개 더 만든다. 새 탭은 매번 활성 = 마지막 탭이 보여야 한다.
  const groupB = two?.groups[1]?.group ?? null
  const extra = []
  for (let index = 0; index < 20; index += 1) {
    const before = new Set(((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId))
    await control({ cmd: 'click', selector: groupB ? `[data-main-tabbar-add="${groupB}"]` : '[data-main-tabbar-add]' })
    extra.push(await until(async () => ((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId).find((id) => !before.has(id)) ?? null, '넘침 탭', 20_000))
  }
  await pause(800)
  const over = await readTabbar()
  const overGroup = over.groups.find((group) => group.tabs.some((tab) => tab.id === extra.at(-1)))
  const last = overGroup?.tabs.find((tab) => tab.id === extra.at(-1))
  const unreachable = overGroup?.tabs.filter((tab) => tab.w < 72 - 0.5) ?? []
  await dump('07-overflow-last-active')
  record('overflow-last-active', Boolean(overGroup && overGroup.strip.scrollWidth > overGroup.strip.clientWidth && last?.active && last?.inView && unreachable.length === 0), {
    strip: overGroup?.strip, last, minWidth: Math.min(...(overGroup?.tabs.map((tab) => tab.w) ?? [0])), shots: await shot('07-overflow-last-active'),
  })
  // 첫 탭을 고르면 스트립이 처음으로 돌아온다(활성 탭 끌어오기) — 첫 탭은 스크롤 밖이라 휠로 먼저 데려간다.
  const stripSel = `[data-main-tab-strip="${overGroup.group}"]`
  const wheel = await control({ cmd: 'eval', code: `(() => { const s = document.querySelector('${stripSel}'); const before = s.scrollLeft; for (let i = 0; i < 40; i += 1) s.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })); return { before, after: s.scrollLeft } })()` })
  record('wheel-vertical-to-horizontal', wheel.result.after < wheel.result.before, { ...wheel.result, method: 'WheelEvent dispatch (deltaY only)' })
  const firstInGroup = overGroup.tabs[0].id
  await control({ cmd: 'click', selector: tabSel(firstInGroup) })
  await pause(400)
  const backToFirst = await leadOf(firstInGroup)
  // 마지막 탭을 다시 활성화(⌘ 없이 — 탭 클릭은 화면에 보여야 한다): 마지막 탭은 스크롤 밖이라 직접 못 누른다 → 새 탭 하나 더 = 활성·보임.
  record('first-tab-after-wheel', backToFirst?.active === true && backToFirst?.inView === true, { tab: backToFirst })

  // ⑧ 스모크 (K3ⓑ) — 더블클릭 이름 바꾸기 · 중클릭 닫기 · × 닫기 · 실행 중 닫기 확인 모달 · 드래그 재정렬
  const renameTarget = extra[0]
  await control({ cmd: 'click', selector: tabSel(renameTarget) }).catch(() => null)
  await control({ cmd: 'eval', code: `document.querySelector('${tabSel(renameTarget)}')?.scrollIntoView({inline:'nearest'})` })
  await control({ cmd: 'dblclick', selector: `${tabSel(renameTarget)} .main-tab-label` })
  await pause(300)
  await control({ cmd: 'key', keyCode: 'a', modifiers: ['meta'] })
  await control({ cmd: 'type', text: 'l493-renamed' })
  await control({ cmd: 'key', keyCode: 'Enter' })
  const renamed = await until(async () => { const tab = await leadOf(renameTarget); return tab?.label === 'l493-renamed' ? tab : null }, '이름 바꾸기', 10_000).catch(() => null)
  record('smoke-rename-dblclick', renamed !== null, { label: (await leadOf(renameTarget))?.label })

  const midTarget = extra[1]
  await control({ cmd: 'eval', code: `document.querySelector('${tabSel(midTarget)}')?.scrollIntoView({inline:'nearest'})` })
  await pause(200)
  const mr = await tabRect(midTarget)
  const mx = Math.round((mr.x ?? mr.left) + (mr.width ?? mr.w) / 2)
  const my = Math.round((mr.y ?? mr.top) + (mr.height ?? mr.h) / 2)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: mx, y: my, button: 'middle' })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: mx, y: my, button: 'middle' })
  const midClosed = await until(async () => !((await fixtureWorkspace())?.tabs ?? []).some((tab) => tab.tabId === midTarget), '중클릭 닫기', 15_000).then(() => true, () => false)
  record('smoke-middle-click-close', midClosed, { tab: midTarget })

  const xTarget = extra[2]
  await control({ cmd: 'eval', code: `document.querySelector('${tabSel(xTarget)}')?.scrollIntoView({inline:'nearest'})` })
  const xr = await tabRect(xTarget)
  await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round((xr.x ?? xr.left) + 30), y: Math.round((xr.y ?? xr.top) + 10) })
  await pause(200)
  const xClick = await control({ cmd: 'click', selector: `[data-main-tab-close="${xTarget}"]` })
  const xClosed = await until(async () => !((await fixtureWorkspace())?.tabs ?? []).some((tab) => tab.tabId === xTarget), '× 닫기', 15_000).then(() => true, () => false)
  // 수정 r1 F1: 옛 이름 smoke-x-close-hover — 투명한 × 를 선택자로 직접 누르므로 hover 증거가 아니다(r2~r4 원자료는 옛 이름).
  record('smoke-x-close', xClosed, { click: xClick.ok })

  // 드래그 재정렬 — 첫 영역의 claude 완료 탭을 그 영역 맨 끝 탭 오른쪽으로 끈다(실제 마우스: 누름 → 6px 넘게 이동 → 뗌).
  const groupA = (await readTabbar()).groups.find((group) => group.tabs.some((tab) => tab.id === claudeDone))
  const orderBefore = groupA.tabs.map((tab) => tab.id)
  const fromR = await tabRect(claudeDone)
  const toR = await tabRect(orderBefore.at(-1))
  const fx = Math.round((fromR.x ?? fromR.left) + 30)
  const fy = Math.round((fromR.y ?? fromR.top) + 12)
  const tx = Math.round((toR.x ?? toR.left) + (toR.width ?? toR.w) - 8)
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: fx, y: fy })
  for (let step = 1; step <= 10; step += 1) await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(fx + ((tx - fx) * step) / 10), y: fy })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: tx, y: fy })
  await pause(600)
  const orderAfter = (await readTabbar()).groups.find((group) => group.group === groupA.group)?.tabs.map((tab) => tab.id) ?? []
  record('smoke-drag-reorder', orderAfter.at(-1) === claudeDone && orderBefore.join() !== orderAfter.join(), { orderBefore, orderAfter })
  // 끌어 옮긴 활성 탭이 보이는 자리에 있어야 한다 (r2 에서 스트립 밖으로 밀려났다 → 탭 목록이 바뀔 때도 끌어오기로 수정)
  const draggedTab = await leadOf(claudeDone)
  record('dragged-active-in-view', draggedTab?.active === true && draggedTab?.inView === true, { tab: draggedTab })
  await dump('08-after-smoke')
  record('after-smoke', true, { shots: await shot('08-after-smoke') })

  // 실행 중 닫기 확인 모달 — 권한 대기 claude 탭 × → 모달이 떠야 한다(main 종료 게이트). 확인으로 닫는다(정리 겸).
  await control({ cmd: 'eval', code: `document.querySelector('${tabSel(claudePerm)}')?.scrollIntoView({inline:'nearest'})` })
  const pr = await tabRect(claudePerm)
  await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round((pr.x ?? pr.left) + 30), y: Math.round((pr.y ?? pr.top) + 10) })
  await pause(200)
  await control({ cmd: 'click', selector: `[data-main-tab-close="${claudePerm}"]` })
  const modal = await until(async () => (await control({ cmd: 'eval', code: `(() => { const m = document.querySelector('[data-confirm-close-modal]'); return m ? (m.dataset.confirmCloseKind ?? 'unknown') : null })()` })).result, '닫기 확인 모달', 10_000).catch(() => null)
  const modalShots = []
  if (modal !== null) {
    const res = await control({ cmd: 'shot', name: 'l493-09-close-confirm', selector: '[data-confirm-close-modal]' })
    const target = path.join(shotsOut, '09-close-confirm-modal.png')
    fs.copyFileSync(res.file, target)
    modalShots.push(path.relative(rawd, target))
    await control({ cmd: 'click', selector: '[data-close-confirm-cancel]' })
  }
  const stillThere = ((await fixtureWorkspace())?.tabs ?? []).some((tab) => tab.tabId === claudePerm)
  record('smoke-close-confirm-modal', modal !== null && stillThere, { modal, cancelledTabStays: stillThere, shots: modalShots })
  fs.writeFileSync(path.join(rawd, 'k5-tabs.json'), `${JSON.stringify({ shellTab, claudeDone, claudePerm, grokTab, codexTab, extra }, null, 1)}\n`)
}

main().then(
  () => {
    const failed = log.filter((entry) => entry.ok === false).map((entry) => entry.step)
    record('end', failed.length === 0, { failed })
    process.exit(failed.length === 0 ? 0 : 1)
  },
  (error) => {
    record('error', false, { message: String(error?.message ?? error).slice(0, 400) })
    process.exit(2)
  },
)
