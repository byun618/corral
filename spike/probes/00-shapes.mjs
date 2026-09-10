// 스키마에 없는 것(응답 실물 모양)을 확인하고 원자료로 남긴다.
import fs from 'node:fs'
import path from 'node:path'
import { call, RAW_DIR, nowIso } from '../lib/herdr.mjs'

// 요청마다 커넥션을 새로 연다 — 서버가 응답 1건 뒤 닫기 때문이다 (a-socket.mjs A2-x1).
// 한 커넥션에 두 번째 요청을 쓰면 EPIPE 로 죽는다.
const out = []
for (const [method, params] of [
  ['ping', {}],
  ['session.snapshot', {}],
  ['server.agent_manifests', {}],
  ['pane.list', {}],
]) {
  const r = await call(method, params)
  out.push({ at: nowIso(), method, params, response: r })
}
const f = path.join(RAW_DIR, '00-shapes.json')
fs.writeFileSync(f, JSON.stringify(out, null, 2))
console.log('wrote', f)
