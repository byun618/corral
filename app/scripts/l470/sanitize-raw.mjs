// LIFE-470 수정 라운드 1 (R1-01) — 이미 커밋된 raw 를 `anon.mjs` 규칙으로 고쳐 쓴다(작업 트리만 — git 이력은 건드리지 않는다).
//   1. 네이티브 화면 읽기(state-*.json)에서 사용자 레포·워크트리 path 를 대응표에 올린다(키 부여)
//   2. `native2/ui-prefs-before-relaunch.json`(사용자 ui-prefs 전체 사본) → 요약(`*.summary.json`, 값 없음)으로 바꾸고 원본은 비공개 위치로
//   3. 네이티브 단계 JSON 의 `prefs` 는 옵션 6칸(관문이 바꾼 열거값)·수동 순서 칸(익명 키)만 남긴다
//   4. raw 의 모든 글 파일(json·md·log·txt)을 익명화
//   5. 네이티브 캡처(PNG — 사용자 실제 화면: 레포·워크트리·터미널 내용)는 비공개 위치로 옮기고 해시 목록·사유를 남긴다
// 사용: node sanitize-raw.mjs <raw/claude 폴더> [--base-prefs <회차 전 백업 ui-prefs.json>]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { anonymizeText, anonymizeValue, loadMap, prefsSummary, PRIVATE_DIR, registerRead, saveMap } from './anon.mjs'

const raw = path.resolve(process.argv[2])
const baseIndex = process.argv.indexOf('--base-prefs')
const basePrefsFile = baseIndex > 0 ? process.argv[baseIndex + 1] : null
const map = loadMap()
const log = []
const NATIVE_DIRS = fs.readdirSync(raw, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^native/.test(entry.name)).map((entry) => entry.name)
const VIEW_FIELDS = ['sidebarGroupBy', 'sidebarSortBy', 'sidebarProjectOrderBy', 'sidebarRepoFilter', 'sidebarHideDefaultBranch', 'sidebarHideDetachedHead', 'sidebarCardLayout', 'sidebarCardProperties', 'sidebarAgentActivityLayout'] // LIFE-477: 표시 옵션 3칸(열거값)

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const privateCopy = (file) => {
  const dest = path.join(PRIVATE_DIR, 'raw', path.relative(raw, file))
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
  fs.renameSync(file, dest)
  return dest
}

// 1. 대응표
for (const dir of NATIVE_DIRS)
  for (const file of walk(path.join(raw, dir)).filter((f) => /\/state-[^/]+\.json$/.test(f))) registerRead({ map, read: JSON.parse(fs.readFileSync(file, 'utf8')).read })

// 2. 사용자 ui-prefs 사본 → 요약
for (const dir of NATIVE_DIRS) {
  const file = path.join(raw, dir, 'ui-prefs-before-relaunch.json')
  if (!fs.existsSync(file)) continue
  const bytes = fs.readFileSync(file)
  const base = basePrefsFile !== null && fs.existsSync(basePrefsFile) ? JSON.parse(fs.readFileSync(basePrefsFile, 'utf8')) : undefined
  const summary = prefsSummary({ prefs: JSON.parse(bytes.toString('utf8')), base, fileSha256: sha256(bytes) })
  fs.writeFileSync(path.join(raw, dir, 'ui-prefs-before-relaunch.summary.json'), JSON.stringify({ note: '사용자 ui-prefs 값 없음 — 키·타입·개수·값 해시·회차 전 백업과 같음/다름(R1-01)', base: base === undefined ? null : 'native-up 백업(회차 전)', ...summary }, null, 2) + '\n')
  log.push(`prefs 요약: ${path.relative(raw, file)} → summary, 원본 → ${privateCopy(file)}`)
}

// 3·4. 글 파일 익명화(네이티브 단계 JSON 은 prefs 를 먼저 줄인다)
for (const file of walk(raw).filter((f) => /\.(json|md|log|txt|ndjson)$/.test(f))) {
  const before = fs.readFileSync(file, 'utf8')
  let after
  const nativeStep = NATIVE_DIRS.some((dir) => file.startsWith(path.join(raw, dir) + path.sep)) && file.endsWith('.json')
  if (nativeStep) {
    const value = JSON.parse(before)
    if (value !== null && typeof value === 'object' && value.prefs && typeof value.prefs === 'object')
      value.prefs = Object.fromEntries(Object.entries(value.prefs).filter(([key]) => VIEW_FIELDS.includes(key) || key.startsWith('manual')))
    after = JSON.stringify(anonymizeValue({ value, map }), null, 2) + '\n'
  } else {
    after = anonymizeText({ text: before, map })
  }
  if (after !== before) {
    fs.writeFileSync(file, after)
    log.push(`익명화: ${path.relative(raw, file)}`)
  }
}

// 5. 네이티브 캡처
for (const dir of NATIVE_DIRS) {
  const shots = path.join(raw, dir, 'shots')
  if (!fs.existsSync(shots)) continue
  const rows = []
  for (const file of walk(shots).filter((f) => f.endsWith('.png')).sort()) {
    rows.push(`| ${path.basename(file)} | ${sha256(fs.readFileSync(file))} |`)
    privateCopy(file)
  }
  fs.rmSync(shots, { recursive: true, force: true })
  fs.writeFileSync(
    path.join(raw, dir, 'shots-removed.md'),
    `# ${dir} 캡처 — 원자료에서 뺐다 (R1-01)\n\n사용자 네이티브 corral 화면 그대로라 레포·워크트리 이름과 열린 터미널 내용이 보인다. 커밋하지 않고 비공개 위치(\`${PRIVATE_DIR}/raw/${dir}/shots/\`)로 옮겼다 —\n아래 sha256 으로 그 파일과 대조할 수 있다. 판정은 같은 단계의 JSON(화면 읽기·도착 이벤트·prefs 요약)이 근거다.\n\n| 파일 | sha256 |\n| --- | --- |\n${rows.join('\n')}\n`,
  )
  log.push(`캡처 ${rows.length}장 → 비공개 위치, ${dir}/shots-removed.md`)
}

saveMap(map)
console.log(log.join('\n'))
console.log(`대응표 항목: repo ${Object.keys(map.repo).length} · wt ${Object.keys(map.wt).length} · br ${Object.keys(map.br).length} (비공개 ${PRIVATE_DIR}/anon-map.json)`)
