// **R13-a 재실행** — 파이프라인 전환 **전후**의 요청 격자가 같은 창에서 같은가 (§10-R19-2·R20-3·R23-5).
//
// 대조 대상 두 빌드:
//   · **전**: 형제 worktree `.claude/worktrees/LIFE-373-r13a-before` — `cbe4e1b` **detached**
//     (전환 직전 커밋). 작업 브랜치도 이 브랜치도 건드리지 않는다
//   · **후**: 이 worktree 의 현재 빌드 (**결함 6 수정 이후** 파이프라인 — R20-3 조건 3)
//
// **어느 하네스가 어느 빌드를 모는가** (R23-5-ⓒ, 거짓 일치 메커니즘 규명):
//   같은 하네스가 둘 다 몬다. `s5-grid.mjs` 는 두 커밋에서 **바이트까지 같고**(`git diff` 0),
//   `l353/lib.mjs` 만 갈리는데(LIFE-357 셀렉터 수정 등) 형제 쪽에 **이 worktree 의 lib.mjs 를
//   복사해 넣었다**. 형제의 옛 lib 로는 사이드바 pane 행을 못 찾아 붙지도 못한다.
//
// **프로브는 어디 사는가** (R20-3 조건 2): **앱 안**이다. 양쪽 다 main 이 남기는
//   `vendor.debug` `resize request`/`surface` 로그를 센다 — 전은
//   `vendor/endpoint-terminal-session.ts`, 후는 `adapter/internal/group-session.ts`.
//   하네스는 창을 바꾸고 그 로그를 읽을 뿐이라, 하네스에 산 프로브가 양쪽을 같이 속이는
//   거짓 일치 경로가 없다.
//
// 격리: 세션은 **`life353-claude`** 다 — 비교 대상(C2 의 S5)이 거기서 났고 S5 하네스 자체가
//   LIFE-353 것이다(02-kickoff 의 문서화된 예외). prefs 는 M0-c 대로 격리한다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_DIR, RAW, m0End, m0Start, siblingAppPids, sleep, strayAppPids, writeRaw } from './lib.mjs'

const BEFORE_APP = process.env.R13A_BEFORE_APP ?? path.join(path.dirname(path.dirname(APP_DIR)), 'LIFE-373-r13a-before', 'app')
const L353_SESSION = process.env.LIFE353_SESSION ?? 'life353-claude'

if (!fs.existsSync(path.join(BEFORE_APP, 'src/main/adapter/internal/vendor/endpoint-terminal-session.ts'))) {
  throw new Error(`전 빌드가 아니다 (${BEFORE_APP}) — cbe4e1b detached worktree 를 먼저 만들어라`)
}
if (fs.existsSync(path.join(BEFORE_APP, 'src/main/adapter/internal/group-session.ts'))) {
  throw new Error('전 빌드에 group-session.ts 가 있다 — 전환 이후 커밋이다')
}

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-r13a-'))
const 결과 = {
  at: new Date().toISOString(),
  세션: L353_SESSION,
  전빌드: BEFORE_APP,
  후빌드: APP_DIR,
  전커밋: execFileSync('git', ['-C', BEFORE_APP, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  후커밋: execFileSync('git', ['-C', APP_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  하네스: '이 worktree 의 l353/lib.mjs + s5-grid.mjs 가 양쪽을 다 몬다',
  프로브: '앱 안 (vendor.debug resize request / surface)',
}

/** M0 — 내 것도 형제 것도 0 이어야 한다 (M0-d). 형제 앱을 띄우는 런이라 특히 중요하다. */
const m0 = (label) => {
  const row = { 라벨: label, ...m0Start() }
  console.log('M0', label, JSON.stringify(row))
  return row
}

/** l353 세션을 **pane 하나**로 (C2 전제 ⓐ). 스크립트는 l353 lib 의 가드를 그대로 쓴다. */
const resetPanes353 = () => {
  const out = execFileSync('node', ['scripts/l373impl/reset-l353-panes.mjs'], {
    cwd: APP_DIR,
    encoding: 'utf8',
    env: { ...process.env, LIFE353_SESSION: L353_SESSION },
  })
  console.log('초기화', out.trim())
  return JSON.parse(out.trim().split('\n').at(-1))
}

/** 한쪽 빌드에서 S5 를 돌린다. prefs 는 격리한다 (M0-c) — 안 하면 사용자 실제 prefs 에 쓴다. */
const runS5 = (label, appDir, subdir) => {
  const prefs = path.join(RUN_DIR, `${subdir}-ui-prefs.json`)
  const env = {
    ...process.env,
    LIFE353_SESSION: L353_SESSION,
    L353_RAW_SUBDIR: subdir,
    CORRAL_UI_PREFS: prefs,
    CORRAL_REGISTRY: path.join(RUN_DIR, `${subdir}-repos.json`),
  }
  let 종료코드 = 0
  let stdout = ''
  try {
    stdout = execFileSync('node', ['scripts/l353/s5-grid.mjs'], { cwd: appDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    종료코드 = error.status ?? -1
    stdout = String(error.stdout ?? '')
    console.error(`[${label}] S5 가 0 이 아닌 코드로 끝났다 (${종료코드}) — 값은 그대로 읽는다`)
  }
  const file = path.join(path.dirname(appDir), 'specs/LIFE-353-terminal-streaming/raw/claude', subdir, 's5-grid.json')
  const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  console.log(stdout.split('\n').filter((line) => line.includes('창 ')).join('\n'))
  return { 라벨: label, appDir, prefs, 종료코드, 원자료: file, s5: json }
}

결과.M0_시작 = m0('시작')
결과.초기화_전 = resetPanes353()
결과.전 = runS5('전 (cbe4e1b)', BEFORE_APP, 'r13a-before')
await sleep(1500)
결과.M0_중간 = m0('전 빌드 뒤')
결과.초기화_후 = resetPanes353()
결과.후 = runS5('후 (현재)', APP_DIR, 'r13a-after')
await sleep(1500)
결과.M0_끝 = { 내잔여: strayAppPids().length, 형제잔여: siblingAppPids().length, ...m0End() }

// 대조 — 같은 창 크기에서 **요청 격자**가 같은가. 다르면 미달이다(R20-3 조건 4).
const steps = (side) => side.s5?.steps ?? []
결과.대조 = steps(결과.전).map((before, i) => {
  const after = steps(결과.후)[i] ?? null
  return {
    창: `${before.window.width}x${before.window.height}`,
    전: { xterm: before.xtermSize, innerRect: before.innerRect, 요청수: before.resizeRequestCount },
    후: after === null ? null : { xterm: after.xtermSize, innerRect: after.innerRect, 요청수: after.resizeRequestCount },
    같나: after !== null && before.xtermSize === after.xtermSize,
  }
})
결과.판정 =
  결과.대조.length === 0 ? '못 쟀다' : 결과.대조.every((row) => row.같나) ? '통과 (전후 동일)' : '미달 (전후 불일치)'

// 형제 worktree 는 이 런이 끝나면 지운다 — 원자료는 여기로 복사해 둔다.
const 사본 = path.join(RAW, 'r13a-before-s5-grid.json')
if (결과.전.s5 !== null) fs.writeFileSync(사본, JSON.stringify(결과.전.s5, null, 2) + '\n')
결과.전사본 = 사본

console.log('\nR13-a 대조')
for (const row of 결과.대조) console.log(' ', row.창, '| 전', row.전.xterm, '| 후', row.후?.xterm ?? '—', '|', row.같나 ? '같다' : '**다르다**')
console.log('판정:', 결과.판정)
writeRaw('r13a-compare.json', 결과)
