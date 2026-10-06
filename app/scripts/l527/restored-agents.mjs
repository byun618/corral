// LIFE-527 K9 — herdr default 서버 아래 복구로 뜬 provider 프로세스 목록(입력 없음 — 기록만). l526 native-footer.mjs 의 restoredAgents 그대로.
// 실행: node restored-agents.mjs <ROOT> <raw 폴더> → <raw>/restored-agents.txt (leftover-check.sh 가 읽는다)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const [root, rawd] = process.argv.slice(2)
const backendPid = Number(fs.readFileSync(path.join(root, 'backend.pid'), 'utf8'))
const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
const out = []
const walk = (parent) => { for (const row of rows.filter((r) => r.ppid === parent)) { out.push(row); walk(row.pid) } }
walk(backendPid)
const agents = out.filter((row) => /claude|grok|codex/.test(row.command)).map((row) => ({ pid: row.pid, ppid: row.ppid, command: row.command.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>').slice(0, 200) }))
fs.writeFileSync(path.join(rawd, 'restored-agents.txt'), `${agents.map((row) => `${row.pid} ${row.ppid} ${row.command}`).join('\n')}\n`)
console.log(`복구된 provider 프로세스 ${agents.length}개(입력 없음)`)
