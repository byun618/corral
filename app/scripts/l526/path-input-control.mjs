// LIFE-526 fix5 R5-01 대조 — 지우는 대상 경로를 바깥 입력(argv·env)에서 받던 곳을 닫았는지 본다.
// iso-smoke: rm-trap 사전 로드로 **실제 프로세스**를 띄우되 rmSync 는 기록만 하고 막는다(/tmp/l526* 실제 삭제 없음).
//   ① --work 없음 → 기존 경로(가드 → rmSync /tmp/l526i 시도 — 함정이 막음) ② --work /tmp/l526i/../l526i-dry → exit 2 · 삭제 0 · mkdir 0
//   ③ --work /tmp/l526i → exit 2(재정의 자체 금지) ③' --work=/tmp/l526i → exit 2 ③" --out 빠짐 → exit 2
// native-down.sh·native-up.sh(점검 표에서 닫은 입력): ④ `..`·심링크로 허용 범위 밖을 가리키는 ROOT·L526_DOWN_UD 반례 → exit 2 · 표지 폴더 그대로,
//   양성: 정규형 실제 폴더 ROOT → 경로 검사 통과 후 다음 검사(app.pid 없음, exit 3)에서 멈춤. path-check.sh 함수는 값 목록으로 순수 대조.
// 이 대조가 만드는 폴더는 이름에 회차 꼬리표가 붙은 새 폴더뿐이고 끝에 지운다. 원출력: <raw>/path-input-control-<tag>.json
// 사용(저장소 루트): node app/scripts/l526/path-input-control.mjs <raw 폴더> <tag>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const out = path.resolve(process.argv[2])
const tag = process.argv[3]
if (!tag) throw new Error('<tag> 필요 — 회차마다 다른 파일명')
const file = path.join(out, `path-input-control-${tag}.json`)
if (fs.existsSync(file)) throw new Error(`이미 있다(덮어쓰지 않는다): ${file}`)
fs.mkdirSync(out, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname)
const work = path.join(out, `path-input-${tag}`)
fs.mkdirSync(work)
const rows = []
const add = (row) => { rows.push(row); console.log(`${row.pass ? '맞음' : '틀림'} ${row.name}: ${row.note}`) }

// ── iso-smoke ──
const iso = ({ name, extra, expect }) => {
  const trapLog = path.join(work, `trap-${rows.length}.ndjson`)
  fs.writeFileSync(trapLog, '')
  const isoOut = path.join(work, `iso-${rows.length}`)
  const argv = ['--import', path.join(here, 'rm-trap.mjs'), path.join(here, 'iso-smoke.mjs'), '--app', 'app', '--port', '9526', '--out', isoOut, ...extra].filter((value) => value !== null)
  const run = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, L526_TRAP_LOG: trapLog } })
  const calls = fs.readFileSync(trapLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const rms = calls.filter((call) => call.op === 'rmSync').map((call) => call.target)
  const pass = expect({ status: run.status, rms, calls, outMade: fs.existsSync(isoOut) })
  add({ name, argv: argv.slice(2), status: run.status, signal: run.signal, calls, stderr: (run.stderr ?? '').slice(0, 600), stdout: (run.stdout ?? '').slice(0, 600), pass, note: `exit ${run.status} · rmSync ${rms.length ? rms.join(',') : '0회'} · 기록 ${calls.length}` })
}
iso({ name: '①iso-work-없음-기존경로', extra: [], expect: ({ status, rms }) => (rms.length === 1 && rms[0] === '/tmp/l526i' && status !== 0) || (status === 3 && rms.length === 0) })
const W = '/tmp/l526i'
iso({ name: '②iso-work-dotdot', extra: ['--work', `${W}/../l526i-dry`], expect: ({ status, calls, outMade }) => status === 2 && calls.length === 0 && !outMade })
iso({ name: '③iso-work-고정값도-거절', extra: ['--work', W], expect: ({ status, calls, outMade }) => status === 2 && calls.length === 0 && !outMade })
iso({ name: '③b-iso-work=꼴', extra: [`--work=${W}`, 'x'], expect: ({ status, calls, outMade }) => status === 2 && calls.length === 0 && !outMade })
iso({ name: '③c-iso-out-빠짐', extra: ['--out'], expect: ({ status, calls }) => status === 2 && calls.length === 0 })

// ── path-check.sh 순수 대조 ──
const fn = ({ func, value, prefix }) => spawnSync('sh', ['-c', `. "$1"; ${func} "$2" "$3"`, 'sh', path.join(here, 'path-check.sh'), value, prefix], { encoding: 'utf8' }).status
const N = '/tmp/l526n'
for (const [value, want] of [[`${N}1`, 0], [`/private${N}1`, 0], [`${N}-dry`, 0], [`${N}1/../x`, 1], [`${N}1/..`, 1], [`${N}1/./x`, 1], [`${N}1//x`, 1], [`/${N}1`, 1], ['tmp/l526n1', 1], ['/tmp/l526x', 1], ['/tmp/l526', 1], ['', 1]]) {
  const status = fn({ func: 'l526_plain_path', value, prefix: N })
  add({ name: `path-check l526_plain_path ${JSON.stringify(value)}`, status, want, pass: status === want, note: `반환 ${status}(기대 ${want})` })
}

// ── native-down.sh·native-up.sh 반례 ──
// 표지 폴더는 허용 범위(/tmp/l526*) **밖**이어야 한다 — run1 은 /tmp/l526fix5-s-* 에 둬서 L526_DOWN_UD 허용 범위 안이라 ④d·④e 가 대조가 못 됐다(대조 결함)
const sentinel = `/tmp/fix5-r526-s-${tag}`
const goodRoot = `${N}-fix5ctl-${tag}`
const link = `${N}-fix5link-${tag}`
const udLink = `/tmp/l526-fix5udlink-${tag}`
const dangle = `${N}-fix5dangle-${tag}`
for (const made of [sentinel, goodRoot, link, udLink, dangle]) if (fs.existsSync(made) || fs.lstatSync(made, { throwIfNoEntry: false })) throw new Error(`이미 있다 — 대조 폴더 이름 겹침: ${made}`)
fs.mkdirSync(sentinel)
fs.writeFileSync(path.join(sentinel, 'marker.txt'), tag)
fs.mkdirSync(path.join(goodRoot, 'ud'), { recursive: true })
fs.mkdirSync(path.join(goodRoot, 'hcfg'))
fs.symlinkSync(sentinel, link)
fs.symlinkSync(sentinel, udLink)
fs.symlinkSync(`${sentinel}-없음`, dangle)
const listing = () => fs.readdirSync(sentinel).sort().join(',')
const before = listing()
const sh = ({ name, script, args, env = {}, want, wantOut }) => {
  const rawd = path.join(work, `sh-${rows.length}`)
  const run = spawnSync('sh', [path.join(here, script), ...args, rawd], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } })
  const text = `${run.stdout}${run.stderr}`
  const intact = listing() === before && fs.readFileSync(path.join(sentinel, 'marker.txt'), 'utf8') === tag
  const pass = run.status === want && text.includes(wantOut) && intact && !fs.existsSync(rawd)
  add({ name, script, args, env, status: run.status, want, output: text.slice(0, 600), sentinelIntact: intact, rawdMade: fs.existsSync(rawd), pass, note: `exit ${run.status}(기대 ${want}) · 표지 ${intact ? '그대로' : '바뀜'} · ${text.trim().split('\n')[0]}` })
}
const goodEnv = { L526_DOWN_UD: path.join(goodRoot, 'ud'), L526_DOWN_HCFG: path.join(goodRoot, 'hcfg') }
sh({ name: '④a-down-ROOT-dotdot', script: 'native-down.sh', args: [`${goodRoot}/..${sentinel.slice(4)}`], env: goodEnv, want: 2, wantOut: 'ROOT 는' })
sh({ name: '④b-down-ROOT-심링크', script: 'native-down.sh', args: [link], env: goodEnv, want: 2, wantOut: 'ROOT 는' })
sh({ name: '④c-down-UD-dotdot', script: 'native-down.sh', args: [goodRoot], env: { ...goodEnv, L526_DOWN_UD: `${goodRoot}/..${sentinel.slice(4)}` }, want: 2, wantOut: '자체 검사 경로' })
sh({ name: '④d-down-UD-심링크', script: 'native-down.sh', args: [goodRoot], env: { ...goodEnv, L526_DOWN_UD: udLink }, want: 2, wantOut: '자체 검사 경로' })
sh({ name: '④e-down-HCFG-밖', script: 'native-down.sh', args: [goodRoot], env: { ...goodEnv, L526_DOWN_HCFG: sentinel }, want: 2, wantOut: '자체 검사 경로' })
sh({ name: '④f-down-양성-정규형(경로 검사 통과 → app.pid 없음 3)', script: 'native-down.sh', args: [goodRoot], env: goodEnv, want: 3, wantOut: 'app.pid 없음' })
const upTarget = `/tmp/l526fix5-up-${tag}`
sh({ name: '④g-up-ROOT-dotdot', script: 'native-up.sh', args: [`${goodRoot}/..${upTarget.slice(4)}`, 'app'], want: 2, wantOut: 'ROOT 는 정규형' })
rows[rows.length - 1].upTargetMade = fs.existsSync(upTarget)
rows[rows.length - 1].pass &&= !fs.existsSync(upTarget)
sh({ name: '④h-up-ROOT-끊긴심링크', script: 'native-up.sh', args: [dangle, 'app'], want: 2, wantOut: '이미 있음(또는 심링크)' })
rows[rows.length - 1].danglingTargetMade = fs.existsSync(`${sentinel}-없음`)
rows[rows.length - 1].pass &&= !fs.existsSync(`${sentinel}-없음`)

for (const made of [link, udLink, dangle]) fs.unlinkSync(made)
for (const made of [sentinel, goodRoot]) fs.rmSync(made, { recursive: true, force: true })
const pass = rows.every((row) => row.pass)
fs.writeFileSync(file, `${JSON.stringify({ tag, at: new Date().toISOString(), made: { sentinel, goodRoot, link, udLink, dangle, removed: true }, rows, pass }, null, 1)}\n`)
console.log(`${pass ? '전부 맞음' : '틀림 있음'} ${rows.filter((row) => row.pass).length}/${rows.length}`)
process.exit(pass ? 0 : 1)
