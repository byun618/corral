// LIFE-477 G7 — K10 비공개 원문(Full list 라벨·도구 입력·메시지·hover 카드 글, 6자 이상)이 raw 글 파일에 있는지 센다. 값은 출력하지 않는다(길이·해시 앞 16자).
// 제외: 프로젝트 이름(라벨 폴백 = 레포 이름)·워커가 쓴 프롬프트 명령 — 대화 텍스트가 아니다. (r1 에서 K10 때의 인라인 검사를 파일로 옮겼다)
// 라운드 2 (R2-02): 원문에 따옴표·개행·역슬래시가 있으면 raw JSON 에는 이스케이프된 꼴로 적혀 평문 대조가 놓친다. 그래서 파일마다
//   ⓐ 평문 그대로 ⓑ 직렬화 표현(`JSON.stringify(text).slice(1, -1)`) ⓒ `.json` 이면 파싱해 모든 문자열 값·키(디코딩된 꼴) — 셋 중 하나라도 맞으면 적중.
// 사용: node agent-text-audit.mjs <raw/claude> <비공개 원문 폴더> [--out <json>]
//       node agent-text-audit.mjs --self-check   (합성 원문을 평문·JSON·로그에 심은 실패 대조 + 깨끗한 대조 — 사용자 자료 무접촉)
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXCLUDE = { corral: '프로젝트 이름(라벨 폴백 = 레포 이름) — 대화 텍스트가 아니다', 'sleep 20': '워커가 쓴 프롬프트의 명령 — 코디 답(q3-answer.json)에 있다. 에이전트 출력이 아니다' }

/** JSON 값의 모든 문자열(값·키) — 디코딩된 꼴. */
const strings = (value) =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
        : []

/** raw 파일 하나를 대조 가능한 꼴로 — 원문 글 + (`.json` 이고 파싱되면) 디코딩된 문자열들. */
function load(file) {
  const text = fs.readFileSync(file, 'utf8')
  let decoded = []
  if (file.endsWith('.json')) {
    try {
      decoded = strings(JSON.parse(text))
    } catch {
      decoded = [] // 깨진 JSON 은 평문·직렬화 대조만
    }
  }
  return { text, decoded }
}

function contains(entry, needle) {
  if (entry.text.includes(needle)) return 'plain'
  if (entry.text.includes(JSON.stringify(needle).slice(1, -1))) return 'serialized'
  if (entry.decoded.some((value) => value.includes(needle))) return 'decoded'
  return null
}

function audit(input) {
  const texts = new Map()
  for (const name of fs.readdirSync(input.privateDir)) {
    const data = JSON.parse(fs.readFileSync(path.join(input.privateDir, name), 'utf8'))
    if (data.hoverCard) texts.set(data.hoverCard, 'hover')
    for (const row of data.rows ?? []) for (const kind of ['label', 'toolInput', 'message']) if (row[kind] && row[kind].length >= 6) texts.set(row[kind], kind)
  }
  const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((x) => walk(path.join(p, x))) : [p])
  const files = walk(input.raw).filter((f) => /\.(json|md|log|txt)$/.test(f))
  const entries = files.map(load)
  const rows = [...texts].map(([text, kind]) => {
    const how = entries.map((entry) => contains(entry, text)).filter((value) => value !== null)
    return {
      kind,
      length: text.length,
      sha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
      hitFiles: how.length,
      hitBy: { plain: how.filter((v) => v === 'plain').length, serialized: how.filter((v) => v === 'serialized').length, decoded: how.filter((v) => v === 'decoded').length },
      excluded: EXCLUDE[text] ?? null,
    }
  })
  const counted = rows.filter((r) => r.excluded === null)
  const hits = counted.reduce((a, r) => a + r.hitFiles, 0)
  return {
    note: 'K10 비공개 원문이 raw 글 파일에 있는지 — 평문·직렬화 표현·JSON 디코딩 셋 다 대조(r2 R2-02). 값은 적지 않는다(길이·해시 앞 16자만). 제외 2건은 사유 칸',
    files: files.length,
    jsonFiles: entries.filter((e, i) => files[i].endsWith('.json')).length,
    privateTexts: rows.length,
    countedTexts: counted.length,
    hits,
    verdict: hits === 0 ? '대화 텍스트 0건' : '적중 있음',
    rows,
  }
}

/** UTF-16 단위마다 \uXXXX — 원문이 평문으로도 JSON 직렬화 꼴로도 파일에 나타나지 않는 유효 JSON 문자열 본문. */
const unicodeEscape = (text) => Array.from({ length: text.length }, (_, index) => `\\u${text.charCodeAt(index).toString(16).padStart(4, '0')}`).join('')

function selfCheck() {
  const here = fileURLToPath(import.meta.url)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l477-textaudit-'))
  const secret = 'synthetic says "private phrase"\nline two \\ backslash'
  const privateDir = path.join(base, 'private')
  fs.mkdirSync(privateDir)
  fs.writeFileSync(path.join(privateDir, 'x.json'), JSON.stringify({ hoverCard: null, rows: [{ label: '', toolInput: null, message: secret }] }))
  const cases = [
    { name: '깨끗한 raw → 0건(exit 0)', files: { 'a.md': '아무 원문도 없다', 'b.json': JSON.stringify({ message: { length: 10 } }) }, want: 0 },
    { name: '평문(.md)에 원문 그대로 → 적중(exit 1)', files: { 'a.md': `앞 ${secret} 뒤` }, want: 1 },
    { name: 'JSON 값(.json)으로 저장 — 이스케이프된 꼴 → 적중(exit 1)', files: { 'b.json': JSON.stringify({ rows: [{ message: secret }] }, null, 2) }, want: 1 },
    { name: 'JSON 값 안에 원문이 일부로 — 직렬화 대조로 적중(exit 1, r3: 이름 정정 — 디코딩 분기는 [r3] 사례가 맡는다)', files: { 'c.json': JSON.stringify({ note: `prefix ${secret} suffix` }) }, want: 1 },
    { name: '로그(.log)에 JSON 한 줄로 — 직렬화 대조 → 적중(exit 1)', files: { 'd.log': `[x] ${JSON.stringify({ message: secret })}` }, want: 1 },
    { name: '깨진 JSON(.json)에 이스케이프된 꼴 → 직렬화 대조로 적중(exit 1)', files: { 'e.json': `{"message": ${JSON.stringify(secret)}, broken` }, want: 1 },
    // r3 (R3-02): 위 사례는 모두 평문·직렬화 부분 문자열로도 잡혀 디코딩 분기를 시험하지 못했다. 원문 전체를 \uXXXX 로 적은 유효 JSON 은
    // 디코딩해야만 보인다 — 결과 hitBy 가 decoded 로만 잡혔는지까지 본다(plain·serialized 0)
    { name: '[r3] 유효 JSON 값을 \\uXXXX 로만 적음 — 디코딩으로만 적중(exit 1, hitBy.decoded)', files: { 'f.json': `{"message": "${unicodeEscape(secret)}"}` }, want: 1, decodedOnly: true },
    { name: '[r3] 유효 JSON 키를 \\uXXXX 로만 적음 — 디코딩으로만 적중(exit 1, hitBy.decoded)', files: { 'g.json': `{"${unicodeEscape(secret)}": 1}` }, want: 1, decodedOnly: true },
  ]
  const results = cases.map((item, index) => {
    const raw = path.join(base, `raw${index}`)
    fs.mkdirSync(raw)
    for (const [name, content] of Object.entries(item.files)) fs.writeFileSync(path.join(raw, name), content)
    const out = path.join(base, `out${index}.json`)
    const res = spawnSync(process.execPath, [here, raw, privateDir, '--out', out], { encoding: 'utf8' })
    const hitBy = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')).rows[0]?.hitBy ?? null : null
    const decodedOk = !item.decodedOnly || (hitBy !== null && hitBy.decoded >= 1 && hitBy.plain === 0 && hitBy.serialized === 0)
    return { name: item.name, exit: res.status, hitBy, pass: res.status === item.want && decodedOk && !res.stdout.includes('private phrase') }
  })
  fs.rmSync(base, { recursive: true, force: true })
  console.log(JSON.stringify({ selfCheck: results.every((r) => r.pass) ? 'pass' : 'fail', results }, null, 1))
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

if (process.argv[2] === '--self-check') selfCheck()
else {
  const [raw, privateDir] = process.argv.slice(2)
  const outIndex = process.argv.indexOf('--out')
  const out = audit({ raw, privateDir })
  if (outIndex > 0) fs.writeFileSync(process.argv[outIndex + 1], JSON.stringify(out, null, 2) + '\n')
  console.log(out.verdict, out.hits, out.countedTexts)
  process.exit(out.hits === 0 ? 0 : 1)
}
