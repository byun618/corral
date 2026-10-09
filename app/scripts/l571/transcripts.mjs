// LIFE-571 C2ⓐ·C3ⓑ — 세션 기록 오라클(읽기만). 이 cwd 에서 since 뒤에 쓰인 세션 기록의 "제출된 user 메시지" 수를 센다.
//   claude: ~/.claude/projects/<cwd slug>/*.jsonl 의 `type:"user"` 중 글자 내용(문자열·text 조각)인 것 — tool_result·isMeta 제외
//   codex : ~/.codex/sessions/**/rollout-*.jsonl 중 session_meta.cwd 가 이 cwd 인 파일의 `event_msg task_started` 수(제출 1회 = 턴 1개)
// 같은 cwd 에서 도는 워커 자신의 Claude 세션은 exclude 로 뺀다. provider 설정·기록은 읽기만 한다(02-kickoff 격리 3).
// 사용(모듈): countUserMessages({ agent, cwd, since, exclude }) / (CLI) node transcripts.mjs <claude|codex> <cwd> <sinceMs> [exclude]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})

function claudeFiles(cwd, since, exclude) {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl') && !(exclude && name.startsWith(exclude)))
    .map((name) => path.join(dir, name)).filter((file) => fs.statSync(file).mtimeMs >= since)
}

function claudeCount(file) {
  return lines(file).filter((entry) => {
    if (entry.type !== 'user' || entry.isMeta) return false
    const content = entry.message?.content
    if (typeof content === 'string') return true
    return Array.isArray(content) && content.some((part) => part.type === 'text')
  }).length
}

function codexFiles(cwd, since) {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const out = []
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl') && fs.statSync(full).mtimeMs >= since) out.push(full)
    }
  }
  walk(root)
  return out.filter((file) => lines(file).some((entry) => entry.type === 'session_meta' && entry.payload?.cwd === cwd))
}

const codexCount = (file) => lines(file).filter((entry) => entry.type === 'event_msg' && entry.payload?.type === 'task_started').length

export function countUserMessages({ agent, cwd, since, exclude }) {
  const files = agent === 'claude' ? claudeFiles(cwd, since, exclude) : codexFiles(cwd, since)
  const records = files.map((file) => ({ file, count: agent === 'claude' ? claudeCount(file) : codexCount(file) }))
  return { agent, cwd, since, exclude: exclude ?? null, files: records, total: records.reduce((sum, record) => sum + record.count, 0) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [agent, cwd, since, exclude] = process.argv.slice(2)
  console.log(JSON.stringify(countUserMessages({ agent, cwd, since: Number(since), exclude }), null, 1))
}
