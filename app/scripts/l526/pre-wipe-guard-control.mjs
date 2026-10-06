// LIFE-526 fix2 R2-01 대조 ① — judgePreWipe 를 **가짜 프로세스·포트 목록**으로 돌린다(앱·프로세스 무접촉).
// 음성: 경로(/tmp·/private/tmp 꼴)·세션·포트 점유·ps 실패·lsof 실패 → pass=false. 양성: 비어 있음 · 경계 밖 경로(/tmp/l526i-dry2) · 자기 pid → pass=true.
// 사용(저장소 루트): node app/scripts/l526/pre-wipe-guard-control.mjs <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { judgePreWipe } from './pre-wipe-guard.mjs'

const out = path.resolve(process.argv[2])
fs.mkdirSync(out, { recursive: true })
const dirs = ['/tmp/l526i-dry', '/tmp/l526n-dry']
const okPs = (lines) => ({ ok: true, lines, error: null })
const freePort = { port: 9527, ok: true, listeners: [], error: null }
const cases = [
  { name: '점유-경로-/private/tmp', ps: okPs(['111 1 /path/Electron --user-data-dir=/private/tmp/l526i-dry/corral-userdata']), ports: [freePort], expect: false },
  { name: '점유-경로-/tmp', ps: okPs(['112 1 node something /tmp/l526n-dry/ctl.sock']), ports: [freePort], expect: false },
  { name: '점유-세션', ps: okPs(['113 1 herdr --session l443-gui-diff server']), ports: [freePort], expect: false },
  { name: '점유-포트', ps: okPs([]), ports: [{ port: 9527, ok: true, listeners: ['Electron 114 byun 30u IPv4 TCP 127.0.0.1:9527 (LISTEN)'], error: null }], expect: false },
  { name: '확인실패-ps', ps: { ok: false, lines: [], error: 'ps: operation not permitted' }, ports: [freePort], expect: false },
  { name: '확인실패-lsof', ps: okPs([]), ports: [{ port: 9527, ok: false, listeners: [], error: 'lsof status=2' }], expect: false },
  { name: '비어있음', ps: okPs(['200 1 /bin/zsh', '201 1 node other.mjs /tmp/l526w']), ports: [freePort], expect: true },
  { name: '경계밖-경로', ps: okPs(['202 1 node x /tmp/l526i-dry2/a']), ports: [freePort], expect: true },
  { name: '자기-pid', ps: okPs(['300 1 node native-footer-dry.mjs /tmp/l526i-dry']), ports: [freePort], expect: true, self: [300] },
]
const rows = cases.map(({ name, ps, ports, expect, self = [] }) => {
  const verdict = judgePreWipe({ ps, ports, dirs, session: 'l443-gui-diff', self })
  return { name, expect, pass: verdict.pass, ok: verdict.pass === expect, reasons: verdict.reasons, hits: verdict.hits }
})
fs.writeFileSync(path.join(out, 'pre-wipe-guard-control.json'), `${JSON.stringify(rows, null, 1)}\n`)
for (const row of rows) console.log(`${row.ok ? '맞음' : '틀림'} ${row.name}: pass=${row.pass}(기대 ${row.expect}) ${row.reasons.join(' / ')}`)
process.exit(rows.every((row) => row.ok) ? 0 : 1)
