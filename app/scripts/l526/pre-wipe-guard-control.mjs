// LIFE-526 fix2 R2-01 · fix3 R3-01 대조 ① — judgePreWipe 를 **가짜 프로세스(pid ppid 명령)·포트 목록**으로 돌린다(앱·프로세스 무접촉).
// fix3 필수 5종: ① 셸 명령문에만 경로가 든 조상 → 통과 ② herdr `--session l443-gui-diff` 서버가 조상 → 실패 ③ 격리 경로를 쓰는 Electron 이 조상 → 실패
//   ④ 비조상 점유 → 실패 ⑤ 비점유 → 통과. 그 밖에 fix2 의 9경우(경로 두 꼴·세션·포트·ps 실패·lsof 실패·비어 있음·경계 밖·자기 pid)를 새 꼴로 다시 둔다.
// 원출력은 회차 꼬리표 파일로 남긴다(덮어쓰기 금지 — fix3 명세): <raw>/pre-wipe-guard-control-<tag>.json
// 사용(저장소 루트): node app/scripts/l526/pre-wipe-guard-control.mjs <raw 폴더> <tag>
import fs from 'node:fs'
import path from 'node:path'
import { judgePreWipe } from './pre-wipe-guard.mjs'

const out = path.resolve(process.argv[2])
const tag = process.argv[3]
if (!tag) throw new Error('<tag> 필요 — 회차마다 다른 파일명')
const file = path.join(out, `pre-wipe-guard-control-${tag}.json`)
if (fs.existsSync(file)) throw new Error(`이미 있다(덮어쓰지 않는다): ${file}`)
fs.mkdirSync(out, { recursive: true })
const dirs = ['/tmp/l526i-dry', '/tmp/l526n-dry']
const ok = (lines) => ({ ok: true, lines, error: null })
const freePort = { port: 9527, ok: true, listeners: [], error: null }
// 공통 사슬: 500(이 스크립트) ← 400(셸) ← 300 ← 1
const SELF = '500 400 node native-footer-dry.mjs /review/output'
const cases = [
  // ── fix3 필수 5종 ──
  { name: '①조상-셸-명령문만', lines: [SELF, "400 300 /bin/zsh -c node native-footer-dry.mjs /x && ls /tmp/l526i-dry", '300 1 /usr/sbin/sshd'], expect: true },
  { name: '②조상-herdr-세션서버', lines: [SELF, '400 300 /bin/zsh', '300 1 /opt/homebrew/bin/herdr --session l443-gui-diff server'], expect: false },
  { name: '③조상-격리경로-Electron', lines: [SELF, '400 300 /bin/zsh', '300 1 /path/Electron.app/Contents/MacOS/Electron --user-data-dir=/private/tmp/l526i-dry/corral-userdata'], expect: false },
  { name: '④비조상-점유', lines: [SELF, '400 300 /bin/zsh', '300 1 /usr/sbin/sshd', '301 1 /opt/homebrew/bin/herdr --session l443-gui-diff server'], expect: false },
  { name: '⑤비점유', lines: [SELF, '400 300 /bin/zsh', '300 1 /usr/sbin/sshd', '302 1 node other.mjs /tmp/l526w'], expect: true },
  // ── 추가: 조상 셸이 세션 문자열만 담은 경우 · 로그인 셸 꼴 · 조상 node(셸 아님)가 경로를 든 경우 ──
  { name: '조상-셸-세션문자열만', lines: [SELF, "400 300 bash -c grep -- '--session l443-gui-diff'", '300 1 -zsh'], expect: true },
  { name: '조상-셸아님-node-경로', lines: [SELF, '400 300 node runner.mjs /tmp/l526n-dry/ctl.sock', '300 1 -zsh'], expect: false },
  // ── fix2 의 9경우(새 꼴) ──
  { name: '점유-경로-/private/tmp', lines: [SELF, '111 1 /path/Electron --user-data-dir=/private/tmp/l526i-dry/corral-userdata'], expect: false },
  { name: '점유-경로-/tmp', lines: [SELF, '112 1 node something /tmp/l526n-dry/ctl.sock'], expect: false },
  { name: '점유-세션', lines: [SELF, '113 1 herdr --session l443-gui-diff server'], expect: false },
  { name: '점유-포트', lines: [SELF], ports: [{ port: 9527, ok: true, listeners: ['Electron 114 byun 30u IPv4 TCP 127.0.0.1:9527 (LISTEN)'], error: null }], expect: false },
  { name: '확인실패-ps', ps: { ok: false, lines: [], error: 'ps: operation not permitted' }, expect: false },
  { name: '확인실패-lsof', lines: [SELF], ports: [{ port: 9527, ok: false, listeners: [], error: 'lsof status=2' }], expect: false },
  { name: '비어있음', lines: [SELF, '200 1 /bin/zsh', '201 1 node other.mjs /tmp/l526w'], expect: true },
  { name: '경계밖-경로', lines: [SELF, '202 1 node x /tmp/l526i-dry2/a'], expect: true },
  { name: '자기-pid', lines: ['500 400 node native-footer-dry.mjs /tmp/l526i-dry', '400 1 /bin/zsh'], expect: true },
]
const rows = cases.map(({ name, lines, ps, ports = [freePort], expect }) => {
  const verdict = judgePreWipe({ ps: ps ?? ok(lines), ports, dirs, session: 'l443-gui-diff', selfPid: 500 })
  return { name, expect, pass: verdict.pass, ok: verdict.pass === expect, reasons: verdict.reasons, hits: verdict.hits, skipped: verdict.skipped }
})
fs.writeFileSync(file, `${JSON.stringify({ tag, at: new Date().toISOString(), rows }, null, 1)}\n`)
for (const row of rows) console.log(`${row.ok ? '맞음' : '틀림'} ${row.name}: pass=${row.pass}(기대 ${row.expect}) ${row.reasons.join(' / ')}${row.skipped.length ? ` · 뺀 조상 셸 ${row.skipped.map((s) => s.pid).join(',')}` : ''}`)
process.exit(rows.every((row) => row.ok) ? 0 : 1)
