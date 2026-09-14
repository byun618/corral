// C7 — data-* 계약 매핑표 재생성. 수정 1회차(07-fix-orca1.md M-2) DOM 변경(MainTabBar 에
// data-main-tab-close 신설)에 맞춰 갱신. baseline 은 여전히 957496a (01-criteria.md 고정).
//
// 1회차 원자료(raw/claude-orca/c7-data-attr-diff.json)를 재생성 과정에서 대조해보니, baseline
// 스캔이 App.tsx 하나만 grep 했었다 — 그러나 957496a 시점에도 TerminalPane.tsx 가 이미
// 별도 파일로 존재했고 거기 `data-term-pane` 이 있었다. 그 결과 1회차 표는 `data-term-pane`
// 을 "신설"로 잘못 분류했다(실제론 "유지"). 이번엔 baseline 도 App.tsx·TerminalPane.tsx·
// main.tsx 전부 스캔해 바로잡는다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { writeRaw } from './lib.mjs'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const BASELINE_SHA = '957496a'
const BASELINE_FILES = ['app/src/renderer/src/App.tsx', 'app/src/renderer/src/TerminalPane.tsx', 'app/src/renderer/src/main.tsx']

function attrsIn(text) {
  return new Set([...text.matchAll(/data-[a-zA-Z-]+/g)].map((m) => m[0]))
}

function baselineAttrs() {
  const all = new Set()
  for (const file of BASELINE_FILES) {
    let text
    try {
      text = execFileSync('git', ['show', `${BASELINE_SHA}:${file}`], { encoding: 'utf8' })
    } catch {
      continue // 파일이 baseline 시점에 없었을 수 있다
    }
    for (const a of attrsIn(text)) all.add(a)
  }
  return all
}

function currentAttrs() {
  const all = new Set()
  const dir = path.join(REPO_ROOT, 'app/src/renderer/src')
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(tsx|ts)$/.test(entry.name)) for (const a of attrsIn(fs.readFileSync(p, 'utf8'))) all.add(a)
    }
  }
  walk(dir)
  return all
}

function main() {
  const baseline = baselineAttrs()
  const current = currentAttrs()
  const kept = [...baseline].filter((a) => current.has(a)).sort()
  const added = [...current].filter((a) => !baseline.has(a)).sort()
  const disappeared = [...baseline].filter((a) => !current.has(a)).sort()

  const result = {
    baselineSha: BASELINE_SHA,
    baselineFiles: BASELINE_FILES,
    baselineCount: baseline.size,
    currentCount: current.size,
    kept,
    added,
    disappeared,
    keptCount: kept.length,
    addedCount: added.length,
    disappearedCount: disappeared.length,
    note: '1회차 대비: data-main-tab-close 신설(M-2). data-term-pane 은 baseline 스캔 파일에 TerminalPane.tsx 를 포함시켜 "신설→유지"로 재분류(1회차는 App.tsx 만 스캔해 놓친 파일 오류).',
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c7-data-attr-diff.json', result)
}

main()
