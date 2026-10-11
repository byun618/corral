#!/usr/bin/env node
// LIFE-597 U8 — 폰 지시 1회가 provider 기록에 「사람이 친 줄」 로 정확히 1건 들어갔는지 센다(표지 글자가 든 사람 줄 수). 본문은 출력하지 않는다(G5).
//   node app/scripts/l597/u8-records.mjs --kind claude|codex|grok --cwd <그 탭의 작업 폴더> --marker <폰 지시에 넣은 표지, 예: u8-1>
// 출력 JSON 한 줄: kind · files(훑은 기록 파일 수) · count(표지가 든 사람 줄 수). 종료 0 = count 1, 1 = 그 밖.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { kind: { type: 'string' }, cwd: { type: 'string' }, marker: { type: 'string' } } })
const kind = values.kind, marker = values.marker ?? ''
if (!['claude', 'codex', 'grok'].includes(kind ?? '') || !values.cwd || marker.length < 3) { console.error('usage: --kind claude|codex|grok --cwd <dir> --marker <표지>'); process.exit(2) }
const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }
const repo = real(values.cwd)
const parse = (line) => { try { return JSON.parse(line) } catch { return null } }
let files = []
if (kind === 'claude') {
  const dir = path.join(os.homedir(), '.claude/projects', repo.replace(/[^A-Za-z0-9]/g, '-'))
  files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)) : []
} else if (kind === 'grok') {
  const dir = path.join(os.homedir(), '.grok/sessions', encodeURIComponent(repo))
  files = fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name, 'updates.jsonl')).filter((file) => fs.existsSync(file)) : []
} else {
  for (let back = 0; back < 2; back += 1) {
    const d = new Date(Date.now() - back * 86_400_000)
    const dir = path.join(os.homedir(), '.codex/sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.jsonl'))) {
      const meta = parse(fs.readFileSync(path.join(dir, name), 'utf8').split('\n')[0] ?? '')
      if (meta?.payload?.cwd && real(meta.payload.cwd) === repo) files.push(path.join(dir, name))
    }
  }
}
let count = 0
for (const file of files) {
  let grokUser = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const raw = parse(line)
    if (raw === null) continue
    if (kind === 'claude') {
      if (raw.type === 'user' && raw.origin?.kind === 'human' && typeof raw.message?.content === 'string' && raw.message.content.includes(marker)) count += 1
    } else if (kind === 'codex') {
      const p = raw.payload ?? {}
      if (raw.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content) && p.content.some((part) => part?.type === 'input_text' && String(part.text ?? '').includes(marker))) count += 1
    } else {
      // Grok: 이어진 user 조각은 한 줄로 합친다.
      const update = raw.params?.update ?? {}
      if (update.sessionUpdate === 'user_message_chunk') {
        const c = update.content
        grokUser = (grokUser ?? '') + (typeof c === 'string' ? c : c?.text ?? (Array.isArray(c) ? c.map((part) => part?.text ?? '').join('') : ''))
      } else if (grokUser !== null) {
        if (grokUser.includes(marker)) count += 1
        grokUser = null
      }
    }
  }
  if (grokUser !== null && grokUser.includes(marker)) count += 1
}
console.log(JSON.stringify({ kind, files: files.length, count }))
process.exit(count === 1 ? 0 : 1)
