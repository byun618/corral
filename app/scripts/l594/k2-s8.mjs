// LIFE-594 K2 — S8 다시: 설정 → Mobile 절(실제 클릭)에서 기기 행에 연결됨 점, 점검 행 하나를 OK 로. k2.mjs run2 의 S8 은 설정 바깥(오버레이 머리)에 붙어 무효.
// 사용: node scripts/l594/k2-s8.mjs <원자료 폴더>  (설정이 닫혀 있어도 된다 — 연다)
import fs from 'node:fs'
import path from 'node:path'
import { connect } from './cdp.mjs'

const OUT = path.resolve(process.argv[2])
fs.mkdirSync(OUT, { recursive: true })
const c = await connect()
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const click = async (sel) => {
  const r = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  if (!r) return false
  await c.mouse('mouseMoved', r.x, r.y); await c.mouse('mousePressed', r.x, r.y, { clickCount: 1 }); await c.mouse('mouseReleased', r.x, r.y, { clickCount: 1 })
  return true
}
const opened = (await c.evaluate(`!!document.querySelector('[data-settings-nav-item="mobile"]')`)) || (await click('[data-settings-open]'))
await pause(600)
const nav = await click('[data-settings-nav-item="mobile"]')
await pause(600)
const forced = await c.evaluate(`(() => {
  const empty = document.querySelector('[data-mobile-devices-empty]')
  const rows = empty?.parentElement
  if (!rows) return { ok: false, why: 'no devices rows' }
  const row = document.createElement('div'); row.className = 'settings-row'; row.setAttribute('data-settings-row', 'true'); row.setAttribute('data-l594-forced', 'device')
  row.innerHTML = '<div class="settings-row-text"><div class="settings-row-label"><span class="mobile-connected" aria-label="연결됨">●</span> Galaxy Z Flip7 (LIFE-594 K2 탐침 행)</div></div><div class="settings-row-control"></div>'
  empty.style.display = 'none'; rows.prepend(row)
  const mark = document.querySelector('.mobile-check-mark'); const before = mark?.className
  if (mark) { mark.className = 'mobile-check-mark is-ok'; mark.textContent = '✓'; mark.setAttribute('data-l594-forced', 'check') }
  row.scrollIntoView({ block: 'center' })
  return { ok: true, checkBefore: before }
})()`)
await pause(300)
const computed = await c.evaluate(`(() => ({
  connected: getComputedStyle(document.querySelector('[data-l594-forced="device"] .mobile-connected')).color,
  checkOk: getComputedStyle(document.querySelector('[data-l594-forced="check"]')).color,
  section: document.querySelector('[data-settings-nav-item="mobile"]')?.className,
}))()`)
await c.shot(path.join(OUT, 's8-settings-mobile-connected.png'))
const scene = { id: 's8-settings-mobile-connected', method: 'natural-mouse + dom-forced',
  how: `설정 열기(${opened}) → 사이드 「Mobile」 항목 실제 클릭(${nav}) → 페어링 기기가 없어(「페어링된 기기가 없습니다.」 숨김) MobileSection.tsx:175 의 연결됨 마크업(span.mobile-connected ●)을 SettingsRow 마크업으로 기기 목록에 넣음 · 점검 첫 행 CheckMark 를 is-ok(✓)로 바꿈(원래 ${forced.checkBefore})`,
  computed, expect: { connected: '--st-ok', checkOk: '--st-ok' }, shot: 's8-settings-mobile-connected.png', forced }
fs.writeFileSync(path.join(OUT, 's8.json'), JSON.stringify(scene, null, 2) + '\n')
console.log(JSON.stringify(scene))
await c.evaluate(`(() => { document.querySelector('[data-l594-forced="device"]')?.remove(); const e = document.querySelector('[data-mobile-devices-empty]'); if (e) e.style.display = '' })()`)
c.close()
