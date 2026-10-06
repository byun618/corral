// LIFE-515 fix1 R1-01 — g6-compare.mjs 자체 검사용 fixture. 사용자 HOME 을 읽지 않는다 — 가짜 snapshot·가짜 수집기만 만든다.
// 경우마다 <root>/<경우>/before.txt · collector.sh 를 쓰고, 기대 종료코드를 <root>/cases.json 에 남긴다.
// 실행은 경우마다 run.mjs 로 한 행씩(판정 회차): L515_G6_COLLECTOR=<root>/<경우>/collector.sh node app/scripts/l515/g6-compare.mjs <root>/<경우>/before.txt <root>/<경우>/after.txt
// 사용: node app/scripts/l515/g6-selftest-setup.mjs /tmp/l515g6st
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (root === undefined || !root.startsWith('/tmp/l515')) throw new Error('사용: g6-selftest-setup.mjs /tmp/l515…')
const hash = (seed) => seed.repeat(64).slice(0, 64)
const UD = '~/Library/Application Support/corral'
const base = [
  `${hash('a')}  399B  ~/.orca/keybindings.json`,
  `${hash('b')}  100B  ~/.claude/settings.json`,
  `${hash('c')}  200B  ~/.codex/config.toml`,
  `${hash('d')}  300B  ~/.grok/config.toml`,
  `${hash('e')}  400B  ~/.grok/trusted_folders.toml`,
  `${hash('f')}  431B  ${UD}/settings.json`,
  `absent  ${UD}/keybindings.json`,
  `${hash('1')}  10B  ~/.claude/hooks/herdr-agent-state.sh`,
  `${hash('2')}  20B  ~/.grok/hooks/herdr.json`,
]
const text = (lines) => `${lines.join('\n')}\n`
const without = (needle) => base.filter((line) => !line.includes(needle))
const cases = [
  { name: 'unchanged', expect: 0, before: base, now: base, note: '무변경' },
  { name: 'modified', expect: 1, before: base, now: base.map((line) => line.replace(hash('d'), hash('9'))), note: '~/.grok/config.toml 값 수정' },
  { name: 'deleted', expect: 1, before: base, now: without('/.grok/hooks/herdr.json'), note: 'hook 삭제(지금 쪽에 줄 없음)' },
  { name: 'added', expect: 1, before: base, now: [...base, `${hash('3')}  30B  ~/.grok/hooks/new.sh`], note: 'hook 추가' },
  { name: 'absent-to-present', expect: 1, before: base, now: base.map((line) => (line.startsWith('absent') ? `${hash('7')}  2B  ${UD}/keybindings.json` : line)), note: '고정 파일 부재 → 생김' },
  { name: 'empty-snapshot', expect: 1, before: base, now: [], note: '수집기 exit 0 + 빈 출력' },
  { name: 'collector-failure', expect: 1, before: base, now: base.slice(0, 3), exit: 7, note: '수집기 exit 7(앞 3줄만 출력)' },
  { name: 'corrupt-snapshot', expect: 1, before: base, now: [...base.slice(0, 8), 'garbage line'], note: '형식이 깨진 줄 + 고정 아님' },
  { name: 'missing-fixed', expect: 1, before: base, now: without('/.codex/config.toml'), note: '고정 파일 줄 누락(absent 도 없음)' },
  { name: 'q1-runtime-excluded', expect: 0, before: [...base, `${hash('8')}  222B  ~/.grok/active_sessions.json`], now: base, note: '시작에만 grok 런타임 줄(옛 넓은 범위) — q1 규칙으로 대조 제외' },
]
fs.rmSync(root, { recursive: true, force: true })
for (const item of cases) {
  const dir = path.join(root, item.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'before.txt'), text(item.before))
  fs.writeFileSync(path.join(dir, 'now.txt'), item.now.length === 0 ? '' : text(item.now))
  fs.writeFileSync(path.join(dir, 'collector.sh'), `#!/bin/sh\ncat "${path.join(dir, 'now.txt')}"\nexit ${item.exit ?? 0}\n`)
}
fs.writeFileSync(path.join(root, 'cases.json'), `${JSON.stringify(cases.map(({ name, expect, note }) => ({ name, expect, note })), null, 2)}\n`)
console.log(cases.map((item) => `${item.name} 기대 ${item.expect} — ${item.note}`).join('\n'))
