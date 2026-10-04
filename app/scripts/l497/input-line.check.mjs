// R1-04 자기 검사 — 커밋된 r1 화면 원문에 입력줄 매처를 걸어 음성·양성이 기대대로 갈리는지. 하나라도 어긋나면 exit 1.
// 사용: node input-line.check.mjs   (경로는 레포 루트 기준으로 푼다)
import fs from 'node:fs'
import path from 'node:path'
import { composerChips } from './input-line.mjs'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const r1 = path.join(repo, 'specs/LIFE-497-paste-drop/raw/claude/native/r1')
const cases = [
  // [cli, 파일, 기대 칩 수, 기대 입력줄 일부] — 음성은 화면 기록에 `[Image #1]` 이 있어도 입력줄엔 없다
  ['codex', 'codex-2/screen-codex-u3-paren-raw.txt', 0, '/Users/byun/l497nfx/files/download (1).png'],
  ['codex', 'codex-2/screen-codex-d-drop-two.txt', 2, '[Image #1] [Image #2]'],
  ['codex', 'codex-2/screen-codex-e-drop-notes.txt', 0, "'/Users/byun/l497nfx/files/my notes.txt'"],
  ['claude', 'claude-2/screen-claude-d-drop-two.txt', 2, '[Image #5] [Image #6]'],
  ['claude', 'claude-2/screen-claude-u3-paren-raw.txt', 1, '[Image #8]'],
  ['claude', 'claude-2/screen-claude-e-drop-notes.txt', 0, "'/Users/byun/l497nfx/files/my notes.txt'"],
]
const fakeOnly = process.argv.includes('--fake-fail')
if (fakeOnly) cases.push(['codex', 'codex-2/screen-codex-u3-paren-raw.txt', 1, 'X'])
let failed = 0
for (const [cli, file, chips, contains] of cases) {
  const screen = fs.readFileSync(path.join(r1, file), 'utf8')
  const got = composerChips(cli, screen)
  const ok = got !== null && got.chips.length === chips && got.text.includes(contains)
  const wholeScreen = (screen.match(/\[Image #\d+\]/g) ?? []).length
  console.log(`${ok ? 'PASS' : 'FAIL'} ${cli} ${file} 입력줄=${JSON.stringify(got?.text ?? null)} 칩=${got?.chips.length ?? 'null'}(기대 ${chips}) 화면전체칩=${wholeScreen}`)
  if (!ok) failed += 1
}
console.log(`${cases.length - failed}/${cases.length} 통과`)
process.exit(failed === 0 ? 0 : 1)
