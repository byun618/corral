#!/usr/bin/env node
// LIFE-582 최종 관문 — 격리 개발 Electron(/tmp/l582g-z*) 설정 › Mobile 켜기·끄기 · 기기 해지(580 `lib.mjs` 의 사람 경로 그대로). 출력은 JSON 한 줄(토큰·코드 없음).
//   node scripts/l582/final-ctl.mjs mobile on|off --root /tmp/l582g-z1 --fake /tmp/l582g-fz1
//   node scripts/l582/final-ctl.mjs revoke --root /tmp/l582g-z1
import { parseArgs } from 'node:util'
import { status } from '../l577/g-lib.mjs'
import { revokeAll, setMobile } from '../l580/lib.mjs'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' }, fake: { type: 'string' } } })
const root = values.root ?? ''
if (!/^\/tmp\/l582g-z[^/]*$/.test(root)) {
  console.error('--root 는 /tmp/l582g-z*')
  process.exit(2)
}
if (positionals[0] === 'mobile') {
  if (!/^\/tmp\/l582g-fz[^/]*$/.test(values.fake ?? '')) {
    console.error('--fake 는 /tmp/l582g-fz*')
    process.exit(2)
  }
  const s = await setMobile(root, values.fake, positionals[1] === 'on')
  console.log(JSON.stringify({ ok: true, mobile: positionals[1], enabled: s.enabled, serverPort: s.serverPort, exposure: s.exposure?.kind ?? null, devices: (s.devices ?? []).length }))
} else if (positionals[0] === 'revoke') {
  await revokeAll(root)
  console.log(JSON.stringify({ ok: true, devices: ((await status(root)).devices ?? []).length }))
} else {
  console.error('명령: mobile on|off · revoke')
  process.exit(2)
}
process.exit(0)
