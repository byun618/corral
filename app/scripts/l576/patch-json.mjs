// LIFE-576 — 앱 정지 중 격리 JSON(ui-prefs·repos.json)을 고친다. 사용: node patch-json.mjs <파일(/tmp/l576n/ud 아래만)> '<JSON 패치(얕은 병합)>' | --worktree-meta '<{"<worktree id>": {...}}>'
// 앱이 떠 있으면 거절한다(덮어쓰기 경쟁). 고치기 전·후 값을 표준출력에 남긴다.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const [file, mode, value] = process.argv.slice(2)
if (!file.startsWith('/tmp/l576n/ud/')) throw new Error('격리 userData 아래 파일만')
let running = ''
try { running = execFileSync('pgrep', ['-f', '--', '--user-data-dir=/tmp/l576n/ud'], { encoding: 'utf8' }).trim() } catch { running = '' }
if (running !== '') throw new Error(`앱이 떠 있다(${running}) — app-down.sh 먼저`)
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
if (mode === '--worktree-meta') {
  const patch = JSON.parse(value)
  for (const [id, meta] of Object.entries(patch)) {
    console.log('before', id, JSON.stringify(data.worktrees[id] ?? null))
    data.worktrees[id] = { ...(data.worktrees[id] ?? {}), ...meta }
    console.log('after ', id, JSON.stringify(data.worktrees[id]))
  }
} else {
  const patch = JSON.parse(mode)
  for (const key of Object.keys(patch)) console.log('before', key, JSON.stringify(data[key]))
  Object.assign(data, patch)
  for (const key of Object.keys(patch)) console.log('after ', key, JSON.stringify(data[key]))
}
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
