// LIFE-688 C4 오라클 판별력 자기점검용 가짜 입력 생성 — `node scripts/l688/make-fixtures.mjs <out-dir>`.
// 이 입력으로 c4.mjs 를 돌린 결과는 판별력 점검일 뿐 C4 통과가 아니다.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('사용법: make-fixtures.mjs <out-dir>')
fs.mkdirSync(dir, { recursive: true })
const HERDR = 2761
// ps: pid ppid tpgid ucomm(뒤 공백 패딩 포함 — 실제 ps 모양)
const PS = [
  ` 2761     1     0 herdr           `,
  `  300  2761   301 zsh             `,
  `  301   300   301 2.1.296         `,
  `  302   301   301 node            `,
  `  400  2761   400 zsh             `,
  `  500  2761   501 zsh             `,
  `  501   500   501 sleep           `,
  `  600  2761   601 zsh             `,
  `  601   600   601 grok-1.0.70-maco`,
  `  700  2761   999 zsh             `,
  `  999     1   999 Notion Helper (R`,
].join('\n') + '\n'
const measured = (pids) => ({ state: 'measured', usage: { cpu: 1, memory: { state: 'measured', bytes: 1 } }, pids })
const pane = (paneId, title, agent, measure, main) => ({ paneId, title, agent, measure, main })
const panes = [
  pane('claude', 'claude 1', 'claude', measured([300, 301, 302]), { pid: 301, name: '2.1.296' }),
  pane('shell', 'zsh', null, measured([400]), { pid: 400, name: 'zsh' }),
  pane('sleep', 'sleep', null, measured([500, 501]), { pid: 501, name: 'sleep' }),
  pane('grok', 'grok 1', 'grok', measured([600, 601]), { pid: 601, name: 'grok-1.0.70-maco' }),
  // tpgid 999 는 귀속 밖(다른 앱) → 셸로 떨어져야 한다.
  pane('outside', 'zsh 2', null, measured([700]), { pid: 700, name: 'zsh' }),
  pane('gone', 'zsh 3', null, { state: 'unavailable', reason: '셸 프로세스(pid 9)가 없다' }, null),
]
const line = (main) => (main.name === null ? `주 프로세스 PID ${main.pid}` : `주 프로세스 ${main.name} · PID ${main.pid}`)
const titleOf = (p) => (p.measure.state === 'measured' ? `${p.title} — 이동\n${line(p.main)}` : `측정 불가 — ${p.measure.reason}\nCPU — 코어 하나 = 100%`)
const capture = (override = {}) => ({
  snapshot: { collectedAt: 1, panes },
  dom: panes.map((p) => ({ paneId: p.paneId, title: override[p.paneId] ?? titleOf(p) })),
  ps: PS,
})
const cases = {
  'match': [capture()],
  'pid-wrong': [capture({ claude: 'claude 1 — 이동\n주 프로세스 2.1.296 · PID 300' }), capture({ claude: 'claude 1 — 이동\n주 프로세스 2.1.296 · PID 300' })],
  'name-wrong': [capture({ claude: 'claude 1 — 이동\n주 프로세스 claude · PID 301' }), capture({ claude: 'claude 1 — 이동\n주 프로세스 claude · PID 301' })],
  'line-missing': [capture({ sleep: 'sleep — 이동' }), capture({ sleep: 'sleep — 이동' })],
  'line-on-unmeasured': [capture({ gone: '측정 불가 — x\n주 프로세스 zsh · PID 9' }), capture({ gone: '측정 불가 — x\n주 프로세스 zsh · PID 9' })],
  'transient-resolved': [capture({ claude: 'claude 1 — 이동\n주 프로세스 2.1.296 · PID 300' }), capture()],
  'unresolved-at-limit': [capture(), capture()].map((c, i) => (i === 0 ? capture({ shell: 'zsh — 이동' }) : capture({ grok: 'grok 1 — 이동' }))),
}
for (const [name, captures] of Object.entries(cases)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ herdrPid: HERDR, captures }, null, 1))
console.log(Object.keys(cases).join(' '))
