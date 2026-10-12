// 선택자 중앙을 CDP 실제 마우스로 클릭(또는 hover 만): node click.mjs '<selector>' [hover]
import { connect } from './cdp.mjs'
const c = await connect(); const [sel, mode] = process.argv.slice(2)
const r = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
if (!r) { console.log('없음'); process.exit(1) }
await c.mouse('mouseMoved', r.x, r.y)
if (mode !== 'hover') { await c.mouse('mousePressed', r.x, r.y, { clickCount: 1 }); await c.mouse('mouseReleased', r.x, r.y, { clickCount: 1 }) }
console.log(JSON.stringify(r)); c.close()
