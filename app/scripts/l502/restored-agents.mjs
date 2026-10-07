// LIFE-502 K4 — l490/restored-agents.mjs 복사(l490→l502·L490→L502·worktree 이름만 sed 로 바꿈, 그 밖 변경은 아래 「L502 변경」 줄). 아래는 원 주석.
// LIFE-490 K8 — l485/restored-agents.mjs 복사(코드 줄의 l485→l502 만 바꿈, 주석 줄은 원문). 아래는 원 주석.
// LIFE-485 K8ⓑ — corral 이 띄운 default 서버 아래 재개로 뜬 provider 프로세스 목록(입력 없음 — 기록만). l527 restored-agents.mjs 를 서버 pid 인자로 고쳤다.
// 실행: node restored-agents.mjs <서버 pid> <raw 폴더> → <raw>/restored-agents.txt
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const [serverPid, rawd] = process.argv.slice(2)
const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
const out = []
const walk = (parent) => { for (const row of rows.filter((r) => r.ppid === parent)) { out.push(row); walk(row.pid) } }
walk(Number(serverPid))
const agents = out.filter((row) => /claude|grok|codex/.test(row.command)).map((row) => ({ pid: row.pid, ppid: row.ppid, command: row.command.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').slice(0, 160) }))
fs.writeFileSync(path.join(rawd, 'restored-agents.txt'), `${agents.map((row) => `${row.pid} ${row.ppid} ${row.command}`).join('\n')}\n`)
console.log(`재개된 provider 프로세스 ${agents.length}개(입력 없음) — ${agents.map((row) => row.command.split(' ')[0].split('/').pop()).join(', ')}`)
