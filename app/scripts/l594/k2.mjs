// LIFE-594 K2 — 고정 장면 캡처 + computed 색 덤프 + 대비표. up.sh 로 띄운 개발 Electron(/tmp/l594e)에 CDP·제어 소켓으로 붙는다.
// 사용: node scripts/l594/k2.mjs <원자료 폴더>   (전제: 레포 1개 등록, pane 3개 — 그룹 분할 1·pane 분할 1)
// 장면마다 「어떻게 만들었나(method)」를 남긴다: natural-mouse = CDP Input.dispatchMouseEvent 실제 마우스 · natural-key = 제어 소켓 key ·
// dom-forced = 렌더러 DOM 에 실제 컴포넌트 마크업·클래스를 넣거나 바꿈(앱 스타일시트가 그대로 칠한다).
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { connect } from './cdp.mjs'

const OUT = path.resolve(process.argv[2])
fs.mkdirSync(OUT, { recursive: true })
const c = await connect()
const control = (req) => rpc('/tmp/l594e/ctl.sock', req, 20_000)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const scenes = []
const center = (sel) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height } })()`)
const css = (sel, props) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const s = getComputedStyle(e); return Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, s.getPropertyValue(p)])) })()`)
async function scene(id, method, how, read, expect) {
  const computed = {}
  for (const [sel, props] of read) computed[sel] = await css(sel, props)
  const file = await c.shot(path.join(OUT, `${id}.png`))
  scenes.push({ id, method, how, computed, expect, shot: path.basename(file) })
  console.log(id, JSON.stringify(computed))
}

// 토큰 해석값(computed) — 탐침 요소에 color: var(--x) 를 주고 읽는다
const tokens = await c.evaluate(`(() => {
  const names = ['--accent','--accent-hi','--fg-on-accent','--st-ok','--bg-surface','--bg-window','--bg-sidebar','--bg-accent','--dropzone-fill','--dropzone-fill-empty']
  const p = document.createElement('div'); document.body.appendChild(p)
  const out = {}
  for (const n of names) { p.style.color = 'var(' + n + ')'; out[n] = { declared: getComputedStyle(document.documentElement).getPropertyValue(n).trim(), computed: getComputedStyle(p).color } }
  p.remove(); return out
})()`)
fs.writeFileSync(path.join(OUT, 'tokens-computed.json'), JSON.stringify(tokens, null, 2) + '\n')

// S1·S2 — 워크트리 생성 모달: 입력 focus · 확정 버튼 기본/hover
{
  const row = await center('[data-repo-toggle]')
  await c.mouse('mouseMoved', row.x, row.y)
  await pause(200)
  const btn = await center('[data-create-worktree]')
  await c.mouse('mouseMoved', btn.x, btn.y); await c.mouse('mousePressed', btn.x, btn.y, { clickCount: 1 }); await c.mouse('mouseReleased', btn.x, btn.y, { clickCount: 1 })
  await pause(500)
  const input = await center('.field-input')
  await c.mouse('mouseMoved', input.x, input.y); await c.mouse('mousePressed', input.x, input.y, { clickCount: 1 }); await c.mouse('mouseReleased', input.x, input.y, { clickCount: 1 })
  await pause(200)
  const focused = await c.evaluate(`document.activeElement?.classList.contains('field-input') ?? false`)
  await scene('s1-input-focus', 'natural-mouse', `사이드바 워크트리 생성 버튼 클릭 → 모달 첫 .field-input 클릭(focus=${focused})`,
    [['.field-input:focus', ['border-color']]], { '.field-input:focus border-color': '--accent' })
  await scene('s2a-btn-accent-default', 'natural-mouse', '같은 모달, 확정 버튼 위에 마우스 없음',
    [['[data-worktree-create-submit]', ['background-color', 'color']]], { background: '--accent', color: '--fg-on-accent' })
  const sub = await center('[data-worktree-create-submit]')
  await c.mouse('mouseMoved', sub.x, sub.y)
  await pause(200)
  await scene('s2b-btn-accent-hover', 'natural-mouse', 'CDP 마우스를 확정 버튼 중앙으로 이동(hover, 누르지 않음)',
    [['[data-worktree-create-submit]', ['background-color', 'color']]], { background: '--accent-hi', color: '--fg-on-accent' })
  await control({ cmd: 'key', keyCode: 'Escape' })
  await pause(300)
}

// S3 — 사이드바 리사이저 hover
{
  const r = await center('.sidebar-resizer')
  await c.mouse('mouseMoved', r.x, r.y)
  await pause(250)
  await scene('s3-sidebar-resizer-hover', 'natural-mouse', 'CDP 마우스를 .sidebar-resizer 중앙으로 이동',
    [['.sidebar-resizer-line', ['background-color']]], { background: '--accent' })
  await c.mouse('mouseMoved', 700, 400)
}

// S4 — 분할선 드래그(그룹 분할선 · pane 분할선)
for (const [id, sel, line, ghost] of [['s4a-group-divider-drag', '.group-divider', '.group-divider.is-dragging .group-divider-line', '.group-divider-ghost'], ['s4b-pane-divider-drag', '.pane-divider', '.pane-divider.is-dragging .pane-divider-line', '.pane-divider-ghost']]) {
  const d = await center(sel)
  await c.mouse('mouseMoved', d.x, d.y); await c.mouse('mousePressed', d.x, d.y, { clickCount: 1 })
  await c.mouse('mouseMoved', d.x - 20, d.y, { buttons: 1 }); await c.mouse('mouseMoved', d.x - 40, d.y, { buttons: 1 })
  await pause(250)
  await scene(id, 'natural-mouse', `CDP 마우스로 ${sel} 를 누른 채 40px 왼쪽으로 끌고 있는 중(놓기 전)`,
    [[line, ['background-color']], [ghost, ['background-color', 'opacity']]], { line: '--accent', ghost: '--accent (opacity .4)' })
  await c.mouse('mouseMoved', d.x, d.y, { buttons: 1 }); await c.mouse('mouseReleased', d.x, d.y, { clickCount: 1 })
  await pause(300)
}

// S5 — 드롭존: 둘째 그룹의 탭을 첫 그룹 본문 위로 끌고 있는 중
{
  const tabs = await c.evaluate(`[...document.querySelectorAll('[data-main-tab]')].map((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })`)
  const t = tabs[tabs.length - 1]
  const body = await center('.term-host')
  await c.mouse('mouseMoved', t.x, t.y); await c.mouse('mousePressed', t.x, t.y, { clickCount: 1 })
  for (let i = 1; i <= 10; i++) { await c.mouse('mouseMoved', t.x + ((body.x - t.x) * i) / 10, t.y + ((body.y - t.y) * i) / 10, { buttons: 1 }); await pause(40) }
  await pause(300)
  const present = await c.evaluate(`document.querySelectorAll('[data-dropzone-fill]').length`)
  await scene('s5-dropzone', 'natural-mouse', `CDP 마우스로 둘째 그룹 탭을 눌러 첫 그룹 pane 중앙까지 10단계로 끈 중(놓기 전) — dropzone 요소 ${present}개`,
    [['[data-dropzone-fill]', ['background-color', 'border-top-color']]], { background: '--dropzone-fill(accent 12%) 또는 -empty(8%)', border: '--accent' })
  await control({ cmd: 'key', keyCode: 'Escape' })
  for (let i = 9; i >= 0; i--) { await c.mouse('mouseMoved', t.x + ((body.x - t.x) * i) / 10, t.y + ((body.y - t.y) * i) / 10, { buttons: 1 }); await pause(20) }
  await c.mouse('mouseReleased', t.x, t.y, { clickCount: 1 })
  await pause(400)
}

// S6 — MRU: Ctrl 누른 채 Tab 으로 실제 MRU 를 열고, 상태 칸 두 행을 완료(◉ tone-ok)·작업 중(⚡ tone-dirty)으로 바꾼다
{
  await control({ cmd: 'key', keyCode: 'Control', modifiers: ['control'], type: 'keyDown' })
  await control({ cmd: 'key', keyCode: 'Tab', modifiers: ['control'], type: 'keyDown' })
  await pause(400)
  const rows = await c.evaluate(`(() => { const s = [...document.querySelectorAll('[data-mru] .mru-row-status')]; const before = s.map((e) => e.className + ' ' + e.textContent);
    if (s[0]) { s[0].className = 'mru-row-status tone-ok'; s[0].textContent = '◉'; s[0].setAttribute('data-l594-forced', 'done') }
    if (s[1]) { s[1].className = 'mru-row-status tone-dirty'; s[1].textContent = '⚡'; s[1].setAttribute('data-l594-forced', 'working') }
    return { count: s.length, before } })()`)
  await scene('s6-mru', 'natural-key + dom-forced', `제어 소켓 Ctrl keyDown + Tab keyDown 으로 실제 MRU 를 연 뒤(행 ${rows.count}개, 원래 상태 ${JSON.stringify(rows.before)}), 1행 상태 span 을 GLYPH.done 의 마크업(class tone-ok · ◉)으로, 2행을 GLYPH.working(class tone-dirty · ⚡)으로 바꿨다 — 셸 pane 이라 herdr 상태가 done/working 이 아니다. GLYPH.done → tone-ok 연결 자체는 K1 판정기 GLYPH 검사`,
    [['[data-l594-forced="done"]', ['color']], ['[data-l594-forced="working"]', ['color']]], { done: '--st-ok', working: '--st-dirty' })
  await control({ cmd: 'key', keyCode: 'Escape', modifiers: ['control'] })
  await control({ cmd: 'key', keyCode: 'Control', type: 'keyUp' })
  await pause(300)
}

// S7 — InlineNotice 기본(info): 실제 InlineNotice 마크업을 첫 탭 그룹 맨 위에 넣는다
{
  const ok = await c.evaluate(`(() => { const g = document.querySelector('.tab-group'); if (!g) return false
    const d = document.createElement('div'); d.className = 'inline-notice tone-info'; d.setAttribute('data-l594-forced', 'notice')
    d.innerHTML = '<span class="inline-notice-dot"></span><span class="inline-notice-text">LIFE-594 K2 — 안내(info) 기본 점</span><div class="inline-notice-spacer"></div><button class="inline-notice-dismiss">해제</button>'
    g.insertBefore(d, g.children[1] ?? null); return true })()`)
  await scene('s7-inline-notice', 'dom-forced', `InlineNotice.tsx 의 tone-info 마크업을 첫 .tab-group 탭바 아래에 넣음(inserted=${ok}) — 라이프사이클 info 알림을 자연 경로로 만들 손잡이가 없다`,
    [['[data-l594-forced="notice"] .inline-notice-dot', ['background-color']]], { dot: '--st-ok' })
  await c.evaluate(`document.querySelector('[data-l594-forced="notice"]')?.remove()`)
}

// S8 — 설정 모바일: 설정을 실제로 열고 모바일 절로 스크롤, 기기 행에 「연결됨」 점을 넣는다
{
  const s = await center('[data-settings-open]')
  await c.mouse('mouseMoved', s.x, s.y); await c.mouse('mousePressed', s.x, s.y, { clickCount: 1 }); await c.mouse('mouseReleased', s.x, s.y, { clickCount: 1 })
  await pause(700)
  const where = await c.evaluate(`(() => {
    const cands = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /모바일/.test(e.textContent ?? '') && e.getBoundingClientRect().width > 0)
    const nav = cands.find((e) => e.closest('nav, [role=tablist], .settings-nav, [class*=settings-nav]'))
    if (nav) nav.click()
    return { navClicked: nav ? nav.className + ' ' + nav.textContent : null, sample: cands.slice(0, 5).map((e) => e.tagName + '.' + e.className + ':' + e.textContent.slice(0, 30)) }
  })()`)
  await pause(500)
  const injected = await c.evaluate(`(() => {
    const sec = document.querySelector('[data-mobile-section], .mobile-section, [class*=mobile-]')
    const host = sec ?? document.querySelector('.settings, [class*=settings]')
    if (!host) return 'no-host'
    host.scrollIntoView({ block: 'start' })
    const row = document.createElement('div'); row.setAttribute('data-l594-forced', 'mobile-row'); row.style.padding = '8px 0'
    row.innerHTML = '<span class="mobile-connected" aria-label="연결됨">●</span> Galaxy Z Flip7 (LIFE-594 K2 탐침 행)'
    host.prepend(row); return (sec ? 'section ' : 'fallback ') + host.className
  })()`)
  const natural = await c.evaluate(`[...document.querySelectorAll('.mobile-check-mark.is-ok, .mobile-connected:not([data-l594-forced] *)')].map((e) => e.className + ':' + getComputedStyle(e).color)`)
  await pause(300)
  await scene('s8-settings-mobile-connected', 'natural-mouse + dom-forced', `설정 버튼 실제 클릭 → 모바일 절(${JSON.stringify(where.navClicked)}) → 페어링된 기기가 없어 MobileSection.tsx:175 의 연결됨 마크업(span.mobile-connected ●)을 넣은 행을 추가(${injected}). 자연 렌더된 is-ok·연결됨 요소: ${JSON.stringify(natural)}`,
    [['[data-l594-forced="mobile-row"] .mobile-connected', ['color']]], { color: '--st-ok' })
  await c.evaluate(`document.querySelector('[data-l594-forced="mobile-row"]')?.remove()`)
  fs.writeFileSync(path.join(OUT, 's8-settings-probe.json'), JSON.stringify(where, null, 2) + '\n')
  await control({ cmd: 'key', keyCode: 'Escape' })
}

fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 2) + '\n')
c.close()
