// LIFE-470 수정 라운드 1 (R1-01) — raw 점검: 사용자 데이터가 남았는지 **개수만** 출력한다(값은 출력하지 않는다).
//   · 홈 경로(`$HOME`)·`/Users/` 접두 · 사용자 레포·워크트리 원래 path(비공개 대응표의 값)
//   · 사용자 ui-prefs 의 문자열 값(기준 파일 — 회차 전 백업 — 의 잎 문자열 중 6자 이상, 옵션 열거값 제외)
//   · 네이티브 폴더의 PNG(사용자 실제 화면)
// 하나라도 0 이 아니면 종료코드 1. 사용: node audit-raw.mjs <raw/claude 폴더> --base-prefs <백업 ui-prefs.json> [--self-check]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadMap } from './anon.mjs'

const raw = path.resolve(process.argv[2])
const baseIndex = process.argv.indexOf('--base-prefs')
const basePrefs = baseIndex > 0 ? JSON.parse(fs.readFileSync(process.argv[baseIndex + 1], 'utf8')) : null
const map = loadMap()
/** 옵션·레이아웃 열거값 — 사용자 데이터가 아니라 스키마 값이라 대조에서 뺀다. */
// LIFE-478: 카드 레이아웃·속성 열거값(shared/sidebar-view.ts SIDEBAR_CARD_LAYOUT·SIDEBAR_CARD_PROPERTIES·SIDEBAR_AGENT_ACTIVITY_LAYOUT) 추가 — 기본값이라 모든 fixture prefs 에 나온다.
const ENUMS = new Set(['none', 'repo', 'name', 'smart', 'recent', 'manual', 'row', 'column', 'detailed', 'compact', 'full', 'inline-agents'])

/** 잎 문자열 값 + 식별자 모양이 아닌 객체 키(경로·id 를 키로 쓰는 칸). `tabOrdinals` 같은 스키마 필드 이름은 데이터가 아니다. */
const leaves = (value) =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(leaves)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, item]) => [...(/^[A-Za-z]+$/.test(key) ? [] : [key]), ...leaves(item)])
        : []
const prefsStrings = basePrefs === null ? [] : [...new Set(leaves(basePrefs))].filter((text) => text.length >= 6 && !ENUMS.has(text) && !/^sidebar|^manual|^version$/.test(text))
const userPaths = [...Object.keys(map.repo), ...Object.keys(map.wt)]
const branchNames = Object.keys(map.br)

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))

function audit(files) {
  const counts = { files: files.length, textFiles: 0, home: 0, usersPrefix: 0, userPaths: 0, prefsValues: 0, nativePng: 0, hitFiles: [] }
  for (const file of files) {
    const rel = path.relative(raw, file)
    if (file.endsWith('.png')) {
      if (/^native[^/]*\//.test(rel)) {
        counts.nativePng++
        counts.hitFiles.push(rel)
      }
      continue
    }
    counts.textFiles++
    const text = fs.readFileSync(file, 'utf8')
    const hit = {
      home: text.split(os.homedir()).length - 1,
      usersPrefix: text.split('/Users/').length - 1,
      userPaths: userPaths.reduce((sum, value) => sum + (text.split(value).length - 1), 0),
      prefsValues: prefsStrings.reduce((sum, value) => sum + (text.includes(value) ? 1 : 0), 0),
    }
    for (const key of Object.keys(hit)) counts[key] += hit[key]
    if (Object.values(hit).some((n) => n > 0)) counts.hitFiles.push(rel)
  }
  return counts
}

if (process.argv.includes('--self-check')) {
  // 부정 입력 자기점검 — 일부러 심은 홈 경로·사용자 path·prefs 값을 잡는지(양성 대조). 값은 출력하지 않는다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l470-audit-'))
  const sample = [os.homedir() + '/x', userPaths[0] ?? '/Users/nobody/repo', prefsStrings[0] ?? 'zzzzzz'].join('\n')
  fs.writeFileSync(path.join(dir, 'planted.md'), sample)
  const counts = audit([path.join(dir, 'planted.md')])
  fs.rmSync(dir, { recursive: true, force: true })
  const ok = counts.home > 0 && counts.userPaths > 0 && (prefsStrings.length === 0 || counts.prefsValues > 0)
  console.log(JSON.stringify({ selfCheck: ok ? 'pass' : 'fail', home: counts.home, userPaths: counts.userPaths, prefsValues: counts.prefsValues, prefsStringsChecked: prefsStrings.length }))
  process.exit(ok ? 0 : 1)
}

const counts = audit(walk(raw))
console.log(
  JSON.stringify(
    { ...counts, checked: { userPathKeys: userPaths.length, branchNames: branchNames.length, prefsStrings: prefsStrings.length }, verdict: counts.hitFiles.length === 0 ? '홈 경로·사용자 path·ui-prefs 값·네이티브 캡처 0건' : '남음' },
    null,
    2,
  ),
)
process.exit(counts.hitFiles.length === 0 ? 0 : 1)
