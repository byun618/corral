// LIFE-573 최종 관문 — rounds.ndjson(두 빌드)을 같은 규칙으로 다시 판정해 항목별 n/m 을 낸다(원자료의 칸 값만 센다).
// 사용: node summarize.mjs <gate 폴더> — 세션 폴더 base·base3(기준선)·impl·impl2(구현). INVALID-* 폴더·파일은 세지 않는다(무효 사유는 RESULT).
//   g2: node summarize.mjs --base <세션 폴더,…> --impl <세션 폴더,…> — 빌드마다 읽을 세션 폴더를 직접 준다(g1 기준선 ↔ g2 구현 나란히).
// 열림 규칙: main `window.open.external` 행 수 · 관측 서버 경로(/favicon.ico 제외)로 센다. 기대 URL 이 있으면 정확히 1회(main 은 200자 절단),
// 없으면(C3·수식키 없음) 0회. 회차 기록의 pass 칸은 쓰지 않는다(초기 회차의 favicon·절단 판정 오류를 같은 규칙으로 바로잡는다).
import fs from 'node:fs'
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1].split(',') }
const sessions = flag('--base') ? { base: flag('--base'), impl: flag('--impl') } : { base: ['base', 'base3'].map((s) => `${argv[0]}/${s}`), impl: ['impl', 'impl2'].map((s) => `${argv[0]}/${s}`) }
// L4-4: 가장자리(저장 좌표가 펼친 뒤 터미널 밖) → hover 없음 · 양성 대조(저장 좌표가 안) → 그 칸 URL hover. g1 회차는 pass 칸이 없어 같은 규칙으로 snaps 에서 다시 판정한다.
const judgeL44 = (r) => (r.item === 'L4-4-positive' ? r.pointerOutsideAfterLayout === false && r.snaps?.s3?.hasLink === true && r.linkText === r.expect : r.pointerOutsideAfterLayout === true && r.snaps?.s3?.hasLink === false)
const judge = (r) => {
  const ext = r.mainLog.filter((m) => m.tag === 'window.open.external')
  const http = r.http.filter((u) => u !== '/favicon.ico')
  if (r.expect === null) return ext.length === 0 && http.length === 0
  return ext.length === 1 && ext[0].url === r.expect.slice(0, 200) && http.length === 1 && http[0] === new URL(r.expect).pathname
}
const rows = {}
for (const build of ['base', 'impl']) {
  for (const line of sessions[build].flatMap((s) => fs.readFileSync(`${s}/rounds.ndjson`, 'utf8').trim().split('\n').map((x) => [s.split('/').slice(-2).join('/'), x]))) {
    const [session, raw] = line
    const r = { ...JSON.parse(raw), id: `${session}:${JSON.parse(raw).id}${JSON.parse(raw).rep ?? ''}` }
    const base = JSON.parse(raw).id
    const key = r.item === 'C4' || r.item === 'C4-claude' ? `${r.item}:${base}` : r.item
    rows[key] ??= { base: [], impl: [] }
    if (r.item === 'L4-4' || r.item === 'L4-4-positive') rows[key][build].push({ id: r.id, pass: judgeL44(r), outside: r.pointerOutsideAfterLayout, hasLink: r.snaps?.s3?.hasLink, linkText: r.linkText })
    else if ('mainLog' in r) rows[key][build].push({ id: r.id, pass: judge(r), opens: r.mainLog.filter((m) => m.tag === 'window.open.external').map((m) => m.url.replace(/^http:\/\/localhost:\d+/, '')) })
    else if ('sgr' in r) rows[key][build].push({ id: r.id, pass: r.pass, sgr: r.sgr.length, provide: r.provide })
    else rows[key][build].push({ id: r.id, info: r.arm ? { provide: r.provide, total: r.total, renders: r.renders, moves: r.moves, ms: r.ms } : (r.info ?? { hasLink: r.snaps?.s3?.hasLink, outside: r.pointerOutsideAfterLayout }) })
  }
}
for (const [key, v] of Object.entries(rows)) {
  const nm = (xs) => (xs.length === 0 ? '—' : xs.every((x) => 'pass' in x) ? `${xs.filter((x) => x.pass).length}/${xs.length}` : 'info')
  console.log(`${key.padEnd(48)} base ${nm(v.base).padEnd(5)} impl ${nm(v.impl).padEnd(5)}`)
  for (const b of ['base', 'impl']) for (const x of v[b]) console.log(`   ${b} ${x.id} ${JSON.stringify({ ...x, id: undefined })}`)
}
