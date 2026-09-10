// 스키마에 없는 것(응답 실물 모양)을 확인하고 원자료로 남긴다.
import fs from 'node:fs'
import path from 'node:path'
import { withConn, RAW_DIR, nowIso } from '../lib/herdr.mjs'

const out = []
await withConn(async (c) => {
  for (const [method, params] of [
    ['ping', {}],
    ['session.snapshot', {}],
    ['server.agent_manifests', {}],
    ['pane.list', {}],
  ]) {
    const r = await c.request(method, params)
    out.push({ at: nowIso(), method, params, response: r })
  }
})
const f = path.join(RAW_DIR, '00-shapes.json')
fs.writeFileSync(f, JSON.stringify(out, null, 2))
console.log('wrote', f)
