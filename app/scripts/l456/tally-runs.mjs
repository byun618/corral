#!/usr/bin/env node
// LIFE-456 R2-F5 — 판정표의 「실행 n/총 m」 을 **runs.md 의 칸을 세서** 만든다.
//
// 규칙 (라운드 2 에서 하나로 정했다):
//   ① 판정표가 근거로 인용하는 회차는 runs.md 에서 **그 기준 항목 태그를 가져야 한다.**
//      한 회차가 여러 항목을 판정하면 태그를 여럿 적는다(`S3·F2`). F→S 대응도 **칸에** 적는다 —
//      집계표 밖의 「+ R1 N회」 같은 부기는 없앤다. 부기는 세어지지 않기 때문이다.
//   ② n/m 은 **그 태그를 가진 행만** 센다.
//   ③ 원자료를 잃은 회차는 **분자에서도 갈라** 적는다: `확정통과 + 미확정 k / 총 m`.
//      「미확정」은 통과로도 실패로도 세지 않는다.
//
// **원자료를 패턴으로 훑지 않는다.** 입력은 runs.md 의 표 한 곳뿐이다 (LIFE-440 재발 방지).
//
// 사용: node app/scripts/l456/tally-runs.mjs <runs.md> [--json]
//       node app/scripts/l456/tally-runs.mjs <runs.md> --check <인용문서…>
//       node app/scripts/l456/tally-runs.mjs <runs.md> --compare <옛 runs.md>
//
// `--check` 는 R3-F2 의 교차검사다. 규칙 ①("인용한 회차는 그 항목 태그를 가져야 한다")은
// 라운드 2 까지 **사람 눈으로만** 지켜졌고, 그래서 S6 가 근거로 쓴 r109 에 `S6` 태그가 없는
// 채로 통과했다. 인용이 태그보다 넓으면 분모가 실제보다 작고, 그 분모로 만든 「n/총 m」 은
// 그 항목을 판정한 실행을 전부 세지 않은 수다. 이제 기계가 센다 — 어긋나면 종료코드 1.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROW = /^\| (r\d{3}) \|/
// 라운드 접두사는 **한 자리 라운드 전부**를 받는다. `(?:R2-)?` 였을 때 `R3-F2` 는
// 접두사를 놓치고 3번째 글자부터 `F2` 로 잡혀 **라운드 1 의 F2 행에 얹혔다** — 라운드 3 태그를
// 붙이는 순간 조용히 남의 분모를 불리는 모양이라, 태그를 달기 전에 먼저 고쳤다.
const TAG = /(?:R\d-)?[SHF]\d+(?:-②)?/g
/** 백틱 안의 경로꼴 토큰. 공백이 들어간 것(`git show … -- path`)은 명령이지 경로가 아니라 뺀다. */
const RAW_PATH = /`([^`\s]*\/[^`\s]*|[^`\s]+\.(?:md|txt|json|ndjson|log|ts|tsx|mjs|sh|patch))`/g
/** `raw/claude/` 접두사는 문서마다 붙기도 빠지기도 한다 — 한 모양으로 맞춘다. */
function normalizePath(value) {
  return value.replace(/^\.\//, '').replace(/^specs\/LIFE-456-agent-state\/raw\/claude\//, '').replace(/^raw\/claude\//, '')
}

/** 한 행을 칸으로 자른다. 칸 안에 `|` 가 섞이면 **집계가 조용히 어긋나므로** 즉시 실패한다. */
function cells(line, id) {
  const parts = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
  if (parts.length !== 9) {
    throw new Error(`${id}: 칸이 9개가 아니다 (${String(parts.length)}개). 칸 안에 파이프가 섞였는지 본다 — ` +
      `그대로 두면 판정 칸이 밀려 통과를 실패로, 실패를 통과로 센다.`)
  }
  return parts
}

export function tally(markdown) {
  const rows = []
  for (const line of markdown.split('\n')) {
    const match = ROW.exec(line)
    if (match === null) continue
    const id = match[1]
    const [, round, criteria, , , , , raw, verdict] = cells(line, id)
    // 원자료 칸의 경로는 **판정 문서가 회차 id 대신 파일명으로 인용할 때** 되짚는 다리다 (R4-F1).
    const rawPaths = [...new Set([...raw.matchAll(RAW_PATH)].map((match) => normalizePath(match[1])))]
    const tags = [...new Set(criteria.match(TAG) ?? [])]
    if (tags.length === 0) throw new Error(`${id}: 기준 항목 태그가 없다 — 판정표가 인용할 수 없는 행이다`)
    // 판정 칸은 **모르는 모양이면 실패시킨다.** `**미달(복원 실패)**` 처럼 강조·괄호가 섞인 칸을
    // 그냥 `startsWith('통과')` 로 재면 미달이 조용히 실패로, 강조된 통과가 실패로 세어진다 —
    // 조용한 오집계가 이 스크립트를 만든 이유다. 어휘는 통과·미달·실패·보류 넷뿐이다.
    const head = verdict.replace(/\*/g, '').trim().split(/[(（\s]/)[0]
    if (!['통과', '미달', '실패', '보류'].includes(head)) {
      throw new Error(`${id}: 판정 칸의 어휘가 통과·미달·실패·보류 가 아니다 (${JSON.stringify(verdict)})`)
    }
    rows.push({
      id, round: Number(round), tags, rawPaths,
      // 「보류」와 원자료를 잃은 회차는 통과로도 실패로도 세지 않는다 (③).
      unresolved: raw.includes('미확정') || head === '보류',
      passed: head === '통과',
    })
  }
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`${row.id}: 회차 id 가 두 번 나온다`)
    seen.add(row.id)
  }
  const byTag = new Map()
  for (const row of rows) {
    for (const tag of row.tags) {
      const bucket = byTag.get(tag) ?? { tag, total: 0, passed: 0, failed: 0, unresolved: 0, ids: [] }
      bucket.total += 1
      bucket.ids.push(row.id)
      if (row.unresolved) bucket.unresolved += 1
      else if (row.passed) bucket.passed += 1
      else bucket.failed += 1
      byTag.set(tag, bucket)
    }
  }
  return { rows, tags: [...byTag.values()].sort(order) }
}

/** S1·S2… → S9-② → F… → R2-F…·R3-F… → H… 순. 숫자는 사전순이 아니라 수로 센다. */
function order(a, b) {
  const rank = (tag) => (/^R\d-F/.test(tag) ? 3 : tag.startsWith('F') ? 2 : tag.startsWith('H') ? 4 : 1)
  if (rank(a.tag) !== rank(b.tag)) return rank(a.tag) - rank(b.tag)
  const num = (tag) => Number(/\d+/.exec(tag)?.[0] ?? '0')
  if (num(a.tag) !== num(b.tag)) return num(a.tag) - num(b.tag)
  return a.tag.localeCompare(b.tag)
}

/** 판정표 행의 첫 칸에 오는 기준 항목 이름. 비교표(6칸)·회차표(9칸)와 섞이지 않게 **7칸**만 본다. */
const VERDICT_CELLS = 7
const CRITERION = /^\*{0,2}(S\d+(?:-②)?)\*{0,2}$/
const CITED = /r\d{3}/g
/** 근거가 「판정 문서의 절」을 가리키는 꼴: `result.md` §4 · `DONE.md` §2 … */
const SECTION_REF = /`([\w.-]+\.md)`\s*§\s*(\d+(?:-[a-z])?)/g
/** 판정 문서 — 이 셋 안에서는 「절」이 기준의 근거 단위다. */
const JUDGMENT_DOCS = ['01-criteria-result.md', 'result.md', 'DONE.md']

/** 문서에서 `## N.` 또는 `### N.` 으로 시작하는 절 하나를 잘라 낸다. 다음 `## ` 에서 끊는다. */
export function section(markdown, number) {
  const lines = markdown.split('\n')
  const head = lines.findIndex((line) => new RegExp(`^#{2,3} *${number.replace('.', '\\.')}\\.`).test(line))
  if (head === -1) return null
  let tail = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { tail = i; break }
  }
  return { from: head + 1, text: lines.slice(head, tail).join('\n') }
}

/**
 * **인용 ↔ 태그 교차검사** (R3-F2 에서 시작, R4-F1 에서 넓혔다).
 *
 * 판정에 쓰는 근거와 원장 태그가 어긋나면 분모가 실제보다 작다. 라운드 3 판은 **7칸 판정표
 * 행의 회차 id 인용**만 봤고, 그래서 codex 가 r4 에서 든 누락을 통째로 통과시켰다 —
 * 판정표가 회차 id 대신 **원자료 파일명**으로 인용하거나, 근거가 **다른 문서의 절**에 있으면
 * 검사가 닿지 않았다. 세 갈래를 다 본다:
 *
 *   ① **회차 id 인용** — 판정표 행에 `rNNN` 이 있으면 그 행의 기준 태그를 가져야 한다
 *   ② **원자료 파일명 인용** — 행에 `\`s9-r1/05-blocked-matrix.md\`` 가 있으면, **그 파일을
 *      원자료 칸에 가진 회차**가 그 기준 태그를 가져야 한다. 디렉터리(`s9-r1/f2/`)는 접두사로 센다
 *   ③ **절 인용** — 근거가 `\`result.md\` §1` 처럼 **판정 문서의 절**을 가리키면, 그 절 안의
 *      ①·② 인용이 전부 그 기준의 근거다. S8 의 근거가 §1 하나이고 §1 이 `u1-result-r004-polled.json`
 *      을 드는 것이 실제 사례다 — r004 에 S8 이 없었다
 *
 * **자연어 추론은 하지 않는다.** 문서가 어느 기준을 말하는지 기계가 짐작하는 자리는 없고,
 * 오직 「판정표 행 → 그 행이 이름 댄 파일·절」이라는 **적힌 연결**만 따라간다.
 * 같은 행의 「실행 n/총 m」 칸도 집계와 대조한다 — 손으로 옮기는 칸이라 태그가 바뀌면 늙는다.
 *
 * 판정표 밖 산문의 인용은 여전히 실패로 세지 않고 목록으로만 낸다.
 */
export function crossCheck(runs, documents, roots = {}) {
  const byId = new Map(runs.rows.map((row) => [row.id, row]))
  const byTag = new Map(runs.tags.map((bucket) => [bucket.tag, bucket]))
  const byDocument = new Map(documents.map((item) => [item.path.split('/').pop(), item]))
  const failures = []
  const prose = []
  const unresolved = []
  // 좁혀진 인용 — **숨기지 않는다.** 회차 id 를 적으면 그 파일의 다른 회차는 요구에서 빠지므로,
  // 좁힌 자리는 전부 출력해 사람이 「왜 좁혔나」를 볼 수 있게 한다.
  const narrowings = []

  /**
   * 그 경로를 원자료로 가진 회차들.
   *   · 디렉터리 인용(`s9-r1/f2/`)은 **접두사**로 센다
   *   · 반대로 **원장 칸이 디렉터리**이고 문서가 그 안의 파일 하나를 부르면(`s9-r1/f2/codex-explain.json`)
   *     그 디렉터리를 가진 회차가 그 파일을 낸 회차다 — 이쪽 방향도 센다. R4 전에는 이 방향이
   *     비어 있어서 `f2/` 안의 화면 4건 인용이 전부 「원장에 안 걸린 경로」로 조용히 빠졌다
   *   · 폴더를 뺀 파일 이름만 쓴 인용(`04-f1-f2-native.md` — 앞의 `s9-r1/` 를 한 번 쓰고 생략하는
   *     문서 관례)은 **꼬리**로 센다. 이 관례 때문에 codex 가 든 S9 ← r072·r073 이 검사에
   *     안 걸렸다 — 관례를 금지하는 대신 검사가 관례를 알게 했다
   */
  const runsForPath = (cited) => runs.rows.filter((row) => row.rawPaths.some((own) =>
    own === cited
    || own.startsWith(cited.endsWith('/') ? cited : cited + '/')
    || (own.endsWith('/') && cited.startsWith(own))
    || (!cited.includes('/') && own.endsWith('/' + cited))))

  const require_ = (criterion, id, where, why) => {
    const row = byId.get(id)
    if (row === undefined) { failures.push({ ...where, criterion, id, why: 'runs.md 에 그 회차가 없다' }); return }
    if (!row.tags.includes(criterion)) {
      failures.push({ ...where, criterion, id, why: `${why} — runs.md 의 태그가 ${row.tags.join('·')} 라 ${criterion} 를 안 센다` })
    }
  }

  /**
   * 글 한 덩이에서 ①·② 를 뽑아 한 기준에 요구한다.
   *
   * **한 원자료 파일을 여러 회차가 나눠 쓰는 경우**(`u1/positive-control.txt` = r005·r006,
   * `s9-r1/09-cleanup-restore.txt` = r094~r102)가 있다. 그때 파일명만 인용하면 어느 회차를
   * 두고 하는 말인지 기계가 모른다. 규칙: **같은 글이 그 파일의 회차 중 일부를 id 로 직접
   * 부르면 그 회차만** 요구하고, 하나도 안 부르면 그 파일의 회차 **전부**를 요구한다.
   * 좁히고 싶으면 **회차 id 를 적으면 된다** — 검사를 피하는 표식이 아니라, 원장 규약이
   * 이미 요구하는 「한 파일 안에서 회차가 갈리면 절까지 적는다」와 같은 방향이다.
   */
  /**
   * 그 경로가 **이 저장소 안의 것**으로 읽히는데 실제로 없으면 실패다 (R4-F3 재발 방지).
   *
   * 판정 문서가 든 테스트 경로 하나가 라운드 1 상태로 굳어 있었다 —
   * `runtime/terminal/blocked-reason.test.ts` 는 r114 에서 어댑터 쪽으로 옮겨 **없는 경로**인데,
   * 사람이 읽으면 그럴듯해서 세 라운드를 지났다. 판정은 **첫 칸이 우리 디렉터리인가**로만 한다:
   * `app/src/runtime/` 이 있으니 그 아래를 가리킨 것으로 보고 찾는다. 첫 칸이 우리 것이 아니면
   * (herdr `src/workspace.rs`, Orca `dashboard/…`) 남의 저장소라 판정하지 않는다.
   */
  const missingRepoPath = (value) => {
    if (value.includes(':') || value.startsWith('~') || value.startsWith('/') || /[{}*]/.test(value)) return false
    const head = value.split('/')[0]
    for (const base of [roots.raw, roots.source].filter((item) => item !== undefined)) {
      if (!existsSync(path.join(base, head))) continue
      return !existsSync(path.join(base, value))
    }
    return false
  }

  const scan = (criterion, text, where, why) => {
    const named = new Set(text.match(CITED) ?? [])
    for (const id of named) require_(criterion, id, where, why)
    for (const match of text.matchAll(RAW_PATH)) {
      const cited = normalizePath(match[1])
      const hits = runsForPath(cited)
      if (hits.length === 0) {
        if (missingRepoPath(cited)) failures.push({ ...where, criterion, id: cited, why: '인용한 경로가 이 저장소에 없다' })
        else unresolved.push({ ...where, criterion, path: cited })
        continue
      }
      const narrowed = hits.filter((row) => named.has(row.id))
      if (narrowed.length > 0 && narrowed.length < hits.length) {
        narrowings.push({ ...where, criterion, path: cited, kept: narrowed.map((row) => row.id),
          dropped: hits.filter((row) => !named.has(row.id)).map((row) => row.id) })
      }
      for (const row of (narrowed.length > 0 ? narrowed : hits)) {
        require_(criterion, row.id, where, `원자료 \`${cited}\` 를 낸 회차`)
      }
    }
  }

  for (const { path, text } of documents) {
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim()
      const parts = trimmed.startsWith('|') && trimmed.endsWith('|')
        ? trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((part) => part.trim())
        : null
      const criterion = parts !== null && parts.length === VERDICT_CELLS ? CRITERION.exec(parts[0])?.[1] : undefined
      if (criterion === undefined) {
        for (const id of trimmed.match(CITED) ?? []) prose.push({ path, line: index + 1, id })
        continue
      }
      const where = { path, line: index + 1 }
      // 「실행 n/총 m」 칸 (7번째)
      const counted = byTag.get(criterion)
      const written = parts[6]
      const expected = counted === undefined ? null : cell(counted)
      if (expected !== null && written !== expected && !written.startsWith('해당 없음')) {
        failures.push({ ...where, criterion, id: '실행 n/총 m', why: `칸은 \`${written}\` 인데 집계는 \`${expected}\` 다` })
      }
      // ①·② — 판정표 행 자체
      scan(criterion, trimmed, where, '이 행이 인용한다')
      // ③ — 근거 칸이 가리킨 판정 문서의 절
      for (const match of parts[4].matchAll(SECTION_REF)) {
        const [, file, number] = match
        const target = byDocument.get(file)
        if (target === undefined || !JUDGMENT_DOCS.includes(file)) continue
        const picked = section(target.text, number)
        if (picked === null) {
          failures.push({ ...where, criterion, id: `${file} §${number}`, why: '근거가 가리킨 절을 그 문서에서 못 찾았다' })
          continue
        }
        scan(criterion, picked.text, { path: target.path, line: picked.from }, `${file} §${number} 가 인용한다`)
      }
    }
  }
  return { failures, prose, unresolved, narrowings }
}

/** 판정표에 그대로 붙일 「n/총 m」 문자열. 미확정은 분자·분모 양쪽에서 갈라 적는다(③). */
export function cell(bucket) {
  const denominator = bucket.unresolved > 0 ? `미확정(${String(bucket.total)})` : String(bucket.total)
  const numerator = bucket.unresolved > 0 ? `${String(bucket.passed)} + 미확정 ${String(bucket.unresolved)}` : String(bucket.passed)
  return `${numerator} / ${denominator}`
}

/**
 * 두 runs.md 를 태그별로 견준다 (R3-F2).
 *
 * 「라운드 N 표와 달라진 곳」을 **손으로 적으면 늙는다** — 라운드 2 에서 실제로 그 표가
 * 스무 줄 아래 판정표와 어긋난 채 남아 있었다(advisor 가 잡았다). 그래서 그 표도 만든다.
 */
export function compare(before, after) {
  const old = new Map(before.tags.map((bucket) => [bucket.tag, bucket]))
  const now = new Map(after.tags.map((bucket) => [bucket.tag, bucket]))
  const tags = [...new Set([...old.keys(), ...now.keys()])]
  const rows = []
  for (const tag of tags) {
    const a = old.get(tag)
    const b = now.get(tag)
    const from = a === undefined ? '—(없던 항목)' : cell(a)
    const to = b === undefined ? '—(사라진 항목)' : cell(b)
    if (from === to) continue
    const added = b === undefined ? [] : b.ids.filter((id) => !(a?.ids ?? []).includes(id))
    const removed = a === undefined ? [] : a.ids.filter((id) => !(b?.ids ?? []).includes(id))
    rows.push({ tag, from, to, added, removed })
  }
  return rows.sort((x, y) => order({ tag: x.tag }, { tag: y.tag }))
}

const [file, ...flags] = process.argv.slice(2)
if (file !== undefined && flags[0] === '--compare') {
  const [older] = flags.slice(1)
  if (older === undefined) { console.error('--compare 는 옛 runs.md 경로를 받는다'); process.exit(2) }
  const rows = compare(tally(readFileSync(older, 'utf8')), tally(readFileSync(file, 'utf8')))
  console.log(`# 태그별로 달라진 곳 — ${older} → ${file}`)
  console.log('')
  console.log('| 기준 항목 | 그때 | 지금 | 들어온 회차 | 나간 회차 |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const row of rows) {
    console.log(`| ${row.tag} | \`${row.from}\` | \`${row.to}\` | ${row.added.join(' ') || '—'} | ${row.removed.join(' ') || '—'} |`)
  }
  console.log('')
  console.log(`달라진 항목 ${String(rows.length)}개`)
} else if (file !== undefined && flags[0] === '--check') {
  const result = tally(readFileSync(file, 'utf8'))
  const documents = flags.slice(1).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  if (documents.length === 0) {
    console.error('--check 는 인용 문서를 하나 이상 받는다 — 0개면 아무것도 검사하지 않고 통과한다')
    process.exit(2)
  }
  // 경로 인용을 되짚을 두 뿌리. 원자료 폴더는 **넘겨받은 runs.md 옆**이고(대조로 옛 스냅샷을
  // 겨눌 수 있게), 제품 소스는 **이 스크립트 옆**이다 — 대조가 옛 문서를 볼 때도 소스는 지금
  // 것을 봐야 「지금 없는 경로」를 잡는다.
  const rawRoot = path.dirname(path.resolve(file))
  const roots = { raw: rawRoot, source: path.resolve(fileURLToPath(import.meta.url), '../../../src') }
  const { failures, prose, unresolved, narrowings } = crossCheck(result, documents, roots)
  console.log(`# 인용 ↔ 태그 교차검사 — 판정표 인용 ${String(failures.length)}건 불일치`)
  console.log(`# runs.md: ${file}`)
  for (const document of documents) console.log(`# 인용 문서: ${document.path}`)
  console.log('')
  if (failures.length > 0) {
    console.log('| 문서 | 줄 | 기준 항목 | 회차 | 왜 |')
    console.log('| --- | --- | --- | --- | --- |')
    for (const item of failures) console.log(`| ${item.path} | ${String(item.line)} | ${item.criterion} | ${item.id} | ${item.why} |`)
    console.log('')
  }
  if (narrowings.length > 0) {
    console.log('회차 id 로 좁혀진 파일 인용 (적힌 id 만 요구했다 — 나머지는 그 기준의 근거가 아니라는 뜻):')
    for (const item of narrowings) {
      console.log(`  ${item.criterion} → ${item.path}: ${item.kept.join(' ')} 만 요구 (뺀 것 ${item.dropped.join(' ')})`)
    }
    console.log('')
  }
  if (unresolved.length > 0) {
    // 원장의 어느 회차에도 안 걸린 경로 인용. 실패로 세지 않는다 — 원자료가 아닌 산출물
    // (코드·파생 문서)을 근거로 드는 칸이 정상적으로 있다. 다만 **숨기지는 않는다.**
    console.log('원장에 안 걸린 경로 인용 (코드·파생 문서이거나, 원장에 빠진 원자료):')
    const seen = new Set()
    for (const item of unresolved) {
      const key = `${item.criterion}\t${item.path}`
      if (seen.has(key)) continue
      seen.add(key)
      console.log(`  ${item.criterion} → ${item.path}`)
    }
    console.log('')
  }
  const byDocument = new Map()
  for (const item of prose) byDocument.set(item.path, (byDocument.get(item.path) ?? new Set()).add(item.id))
  console.log('표 밖 산문 인용 (실패로 세지 않는다 — 사람이 훑는다):')
  for (const [path, ids] of byDocument) console.log(`  ${path}: ${[...ids].sort().join(' ')}`)
  console.log('')
  console.log(failures.length === 0 ? '판정: 통과' : '판정: 미달')
  process.exit(failures.length === 0 ? 0 : 1)
} else if (file !== undefined) {
  const result = tally(readFileSync(file, 'utf8'))
  if (flags.includes('--json')) {
    console.log(JSON.stringify(result, null, 1))
  } else {
    console.log(`# runs.md 칸 집계 — 총 ${String(result.rows.length)} 회차`)
    console.log(`# 입력: ${file}`)
    console.log('')
    console.log('| 기준 항목 | 실행 n / 총 m | 통과 | 실패 | 미확정 | 회차 |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    for (const bucket of result.tags) {
      console.log(`| ${bucket.tag} | ${cell(bucket)} | ${String(bucket.passed)} | ${String(bucket.failed)} | ${String(bucket.unresolved)} | ${bucket.ids.join(' ')} |`)
    }
    // **라운드별 수와 미확정 수는 「행」을 센다.** 위 표의 미확정 칸은 태그별이라 한 회차가
    // 여러 항목에 잡히면 여러 번 세어진다 — 산문에 그 합계를 옮겨 적으면 틀린다
    // (실제로 「라운드 0 미확정 10회차」라고 적혀 있었고 행으로 세면 9다).
    const rounds = new Map()
    for (const row of result.rows) {
      const bucket = rounds.get(row.round) ?? { total: 0, unresolved: 0, ids: [] }
      bucket.total += 1
      if (row.unresolved) { bucket.unresolved += 1; bucket.ids.push(row.id) }
      rounds.set(row.round, bucket)
    }
    console.log('')
    for (const [round, bucket] of [...rounds].sort((a, b) => a[0] - b[0])) {
      const tail = bucket.unresolved === 0 ? '미확정 0' : `미확정 ${String(bucket.unresolved)} (${bucket.ids.join(' ')})`
      console.log(`라운드 ${String(round)}: ${String(bucket.total)} 회차 · ${tail}`)
    }
    console.log(`합계: ${String(result.rows.length)} 회차 · 미확정 ${String(result.rows.filter((row) => row.unresolved).length)} 회차`)
  }
}
