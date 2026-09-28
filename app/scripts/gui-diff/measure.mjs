#!/usr/bin/env node
// LIFE-443 — Orca ↔ corral GUI 동일성 측정 도구. **명령 하나**가 두 앱을 띄우고, 같은 fixture 를 물리고,
// 상태를 맞춘 뒤 영역별로 캡처·덤프·diff 해서 md + json 을 쓴다.
//
//   node app/scripts/gui-diff/measure.mjs --areas sidebar,tabbar --states default,agents-2
//
// 447~450 은 착수 전과 끝난 뒤에 **같은 명령**을 다시 돌려 "거의 같다" 를 판정한다.
// 자세한 사용법·전제는 README.md.
//
// 영역 정의(두 앱 요소 짝짓기)는 코드가 아니라 `areas/<영역>.json` 이다 (C1) — 영역을 늘리는 일은
// 파일 하나 더 두는 일이지 이 파일을 고치는 일이 아니다.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { pause, until } from './lib/cdp.mjs'
import { collectSnapshot, settlePage, PROP_SETS, EXCLUDED_PROPS } from './lib/probe.mjs'
import { diffSnapshots, selfDiff, compareMeta } from './lib/diff.mjs'
import { renderReport, writeJson } from './lib/report.mjs'
import { ensureFixtureRepo } from './lib/fixture.mjs'
import { launchOrca, seedOrcaRepo, setOrcaAgents, setWindowBounds as setOrcaBounds } from './lib/orca.mjs'
import { launchCorral, seedCorralRepo, setCorralAgents, setWindowBounds as setCorralBounds, backendRpc, rpc } from './lib/corral.mjs'
import { ensureLedger, appendRun, nextRunId } from './lib/runs.mjs'

// 이 도구는 전역 `WebSocket`(raw CDP) 을 쓴다 — node 20 에는 플래그 뒤에 있다.
// corral 자신도 node >= 22.12 를 요구한다(`app/package.json` engines). 조용히 죽는 대신 여기서 말한다.
const NODE_MAJOR = Number(process.versions.node.split('.')[0])
if (NODE_MAJOR < 22 || typeof globalThis.WebSocket !== 'function') {
  process.stderr.write(
    `[l443] node ${process.versions.node} 로는 못 돈다 — 전역 WebSocket 이 필요하다(raw CDP).\n` +
      '        node 22 이상으로 돌려라. 예: ~/.nvm/versions/node/v24.14.1/bin/node app/scripts/gui-diff/measure.mjs …\n'
  )
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const repoRoot = path.resolve(appRoot, '..')

// ---- 인자 ------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    areas: ['sidebar', 'tabbar'],
    states: ['default', 'agents-2'],
    work: process.env.L443_WORK ?? '/tmp/l443',
    orcaRepo: process.env.L443_ORCA_REPO ?? '/tmp/l443/orca-198',
    out: null,
    ledger: null,
    tolerance: Number(process.env.L443_TOLERANCE ?? 0.5),
    width: 1440,
    height: 900,
    keep: false,
    fresh: true,
    dumpDom: false,
    label: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => argv[++i]
    if (arg === '--areas') out.areas = value().split(',').filter(Boolean)
    else if (arg === '--states') out.states = value().split(',').filter(Boolean)
    else if (arg === '--out') out.out = path.resolve(value())
    else if (arg === '--ledger') out.ledger = path.resolve(value())
    else if (arg === '--work') out.work = path.resolve(value())
    else if (arg === '--orca-repo') out.orcaRepo = path.resolve(value())
    else if (arg === '--tolerance') out.tolerance = Number(value())
    else if (arg === '--width') out.width = Number(value())
    else if (arg === '--height') out.height = Number(value())
    else if (arg === '--label') out.label = value()
    else if (arg === '--keep') out.keep = true
    else if (arg === '--no-fresh') out.fresh = false
    else if (arg === '--dump-dom') out.dumpDom = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`알 수 없는 인자: ${arg}`)
  }
  out.out ??= path.join(repoRoot, 'specs/LIFE-443-gui-diff/raw/claude/measure')
  out.ledger ??= path.join(repoRoot, 'specs/LIFE-443-gui-diff/raw/claude/runs.md')
  return out
}

const USAGE = `사용법: node app/scripts/gui-diff/measure.mjs [옵션]

  --areas   <a,b>   측정 영역 (areas/*.json 의 이름). 기본 sidebar,tabbar
  --states  <a,b>   상태 (영역 정의의 states 키). 기본 default,agents-2
  --out     <경로>  결과·원자료를 쓸 폴더
  --ledger  <경로>  명시 실행 목록(runs.md)
  --work    <경로>  격리 userData·HOME·fixture 를 둘 폴더 (기본 /tmp/l443)
  --orca-repo <경로> Orca v1.4.198 체크아웃 (기본 /tmp/l443/orca-198)
  --tolerance <px>  박스 허용치. C5 잡음 바닥이 정한 값을 넣는다 (기본 0.5)
  --width/--height  두 창에 똑같이 줄 크기 (기본 1440x900)
  --label   <문자>  결과 폴더에 붙일 꼬리표 (회차 구분용)
  --keep            끝나고 앱을 닫지 않는다 (사람이 눈으로 볼 때)
  --no-fresh        격리 userData 를 지우지 않고 재사용한다 (기본은 매 회차 새로 만든다)
  --dump-dom        영역 루트의 DOM 윤곽을 덤프한다 (영역 정의를 쓸 때)
`

// ---- 영역 정의 --------------------------------------------------------------
function loadArea(name) {
  const file = path.join(here, 'areas', `${name}.json`)
  if (!fs.existsSync(file)) throw new Error(`영역 정의가 없다: ${file}`)
  const area = JSON.parse(fs.readFileSync(file, 'utf8'))
  area.name = name
  return area
}

// ---- 캡처 -------------------------------------------------------------------
/**
 * 한 앱·한 영역의 스냅샷 + 영역 크롭 PNG.
 *
 * 크롭하는 이유: 전체 화면 캡처는 커밋에 들어가기엔 크고, 사이드바 차이를 보는 사람에게
 * 나머지 화면은 잡음이다 (킥오프 원자료 규칙).
 */
async function capture(app, handle, area, { outDir, tag }) {
  await settlePage(handle.cdp)
  const spec = { root: area.root[app], units: area.units.map((u) => ({ id: u.id, selector: u[app], props: u.props, global: u.global })), props: PROP_SETS }
  // 짝짓기 파일이 그 앱에 선택자를 안 준 단위는 "이 앱에는 해당 요소가 없다" 는 선언이다.
  spec.units = spec.units.filter((unit) => typeof unit.selector === 'string')
  const snapshot = await handle.cdp.evaluate(collectSnapshot, spec)
  snapshot.app = app
  // 선택자를 안 준 단위는 명시적으로 부재로 채운다 — 빠뜨린 것과 없는 것을 구분한다.
  for (const unit of area.units) {
    if (typeof unit[app] !== 'string') snapshot.elements[unit.id] = { present: false, count: 0, countAll: 0, declaredAbsent: true }
  }

  // 실제로 렌더된 폰트 (C7 분류 규칙: 선언값 ≠ 렌더 폰트)
  try {
    await handle.cdp.send('DOM.enable')
    await handle.cdp.send('CSS.enable')
    const { root } = await handle.cdp.send('DOM.getDocument', { depth: 0 })
    for (const unit of area.units) {
      if (!unit.props?.includes('text') || typeof unit[app] !== 'string') continue
      const entry = snapshot.elements[unit.id]
      if (!entry?.present) continue
      const { nodeId } = await handle.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `${area.root[app]} ${unit[app]}` })
      if (!nodeId) continue
      const fonts = await handle.cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      entry.platformFonts = (fonts.fonts ?? []).map((font) => ({ family: font.familyName, glyphs: font.glyphCount }))
    }
  } catch (error) {
    snapshot.meta.platformFontsError = String(error?.message ?? error)
  }

  const shotPath = path.join(outDir, `${tag}-${app}.png`)
  const box = snapshot.meta.rootBox
  if (box) {
    const rect = await handle.cdp.evaluate((selector) => {
      const el = document.querySelector(selector)
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }, area.root[app])
    const shot = await handle.cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...rect, scale: 1 },
      captureBeyondViewport: false
    })
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    snapshot.meta.screenshot = path.relative(outDir, shotPath)
  }
  return snapshot
}

/** 영역 루트 아래 DOM 윤곽 — 영역 정의 파일을 쓸 때 선택자를 눈으로 고르는 용도. */
async function dumpDom(handle, rootSelector, depth = 6) {
  return handle.cdp.evaluate(
    ({ rootSelector, depth }) => {
      const root = document.querySelector(rootSelector)
      if (!root) return { error: `not found: ${rootSelector}` }
      const walk = (el, level) => {
        if (level > depth) return null
        const attrs = {}
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-') || ['class', 'role', 'aria-label', 'id'].includes(attr.name)) {
            attrs[attr.name] = attr.value.slice(0, 120)
          }
        }
        const rect = el.getBoundingClientRect()
        return {
          tag: el.tagName.toLowerCase(),
          attrs,
          box: { w: Math.round(rect.width), h: Math.round(rect.height) },
          text: level >= depth ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) : undefined,
          children: level < depth ? Array.from(el.children).map((child) => walk(child, level + 1)).filter(Boolean) : undefined
        }
      }
      return walk(root, 0)
    },
    { rootSelector, depth }
  )
}

// ---- 상태 --------------------------------------------------------------------
/**
 * 두 앱을 같은 상태로 맞춘다. 상태마다 "무엇을 맞췄나" 를 돌려주고, 못 맞춘 것은 사유와 함께 돌려준다 —
 * 재현 못 한 상태를 공백으로 적는 것이 C7 의 요구다.
 */
async function applyState(state, { orca, corral, orcaRepoId }) {
  switch (state) {
    case 'default':
      // 기준선(ensureBaseline)이 이미 두 앱에 워크스페이스·탭 하나씩을 열어 뒀다. 에이전트는 없다.
      return { reproduced: true, detail: 'fixture 레포 1개 + linked worktree + 열린 탭 1개, 에이전트 없음' }
    case 'agents-2': {
      const specs = [
        { state: 'working', prompt: 'L443 fixture agent one', agentType: 'claude' },
        { state: 'working', prompt: 'L443 fixture agent two', agentType: 'codex' }
      ]
      const o = await setOrcaAgents(orca, { repoId: orcaRepoId, count: 2, states: specs })
      const c = await setCorralAgents(corral, { count: 2, states: specs })
      await pause(900)
      return { reproduced: true, detail: '루트 에이전트 2개 (양성 대조 C6ⓐ 의 상태)', orca: o, corral: c }
    }
    case 'agents-5': {
      const specs = [
        { state: 'working', prompt: 'L443 agent 1', agentType: 'claude' },
        { state: 'idle', prompt: 'L443 agent 2', agentType: 'codex' },
        { state: 'blocked', prompt: 'L443 agent 3', agentType: 'claude' },
        { state: 'working', prompt: 'L443 agent 4', agentType: 'codex' },
        { state: 'idle', prompt: 'L443 agent 5', agentType: 'claude' }
      ]
      const o = await setOrcaAgents(orca, { repoId: orcaRepoId, count: 5, states: specs })
      const c = await setCorralAgents(corral, { count: 5, states: specs })
      await pause(900)
      return { reproduced: true, detail: '루트 에이전트 5개', orca: o, corral: c }
    }
    default:
      return { reproduced: false, reason: `상태 '${state}' 는 이 도구가 아직 재현하지 못한다` }
  }
}

/**
 * 기준선 — 두 앱에 **열린 워크스페이스/탭 하나씩**을 만든다.
 *
 * 왜 필요한가: 탭바 영역은 탭이 없으면 아예 그려지지 않고(실측), Orca 는 활성 worktree 가 없으면
 * 카드 안 에이전트 목록도 안 뜬다. 두 앱을 같은 출발선에 세우는 것이 짝짓기의 전제다.
 */
async function ensureBaseline({ orca, corral, fixtureRoot }) {
  const orcaBaseline = await orca.cdp.evaluate(() => {
    const store = window.__store
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) throw new Error('활성 worktree 가 없다')
    if (!state.worktreeCardProperties.includes('inline-agents')) state.toggleWorktreeCardProperty('inline-agents')
    while ((store.getState().tabsByWorktree[worktreeId] ?? []).length < 1) store.getState().createTab(worktreeId)
    return { worktreeId, tabs: (store.getState().tabsByWorktree[worktreeId] ?? []).length }
  })
  const created = await backendRpc(corral, 'workspace.create', { cwd: fixtureRoot, focus: true })
  await until(
    async () => ((await backendRpc(corral, 'pane.list')).panes ?? []).length >= 1,
    'corral 기준선 pane',
    30_000
  )
  await pause(1500)
  return { orca: orcaBaseline, corral: created }
}

// ---- 본체 --------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(args.out, args.label ? `${stamp}-${args.label}` : stamp)
  fs.mkdirSync(outDir, { recursive: true })
  ensureLedger(args.ledger)
  const runId = nextRunId(args.ledger)
  const command = `node app/scripts/gui-diff/measure.mjs ${process.argv.slice(2).join(' ')}`
  const rawRel = path.relative(repoRoot, outDir)

  const record = (result, extra = {}) =>
    appendRun(args.ledger, {
      id: runId,
      criterion: extra.criterion ?? `C1·C4·C5·C6·C7·C10 (areas=${args.areas.join('+')} states=${args.states.join('+')})`,
      command,
      expectedExit: 0,
      actualExit: extra.exit ?? (result === '통과' ? 0 : 1),
      raw: rawRel,
      result
    })

  let orca = null
  let corral = null
  const log = (message) => process.stderr.write(`[l443] ${message}\n`)

  try {
    fs.mkdirSync(args.work, { recursive: true })
    // 회차마다 격리 프로필을 **버리고 새로 만든다.** 남겨 두면 지난 회차의 탭·워크스페이스가
    // 살아남아 같은 명령이 다른 상태를 잰다 — C10(재현성)이 그 자리에서 깨진다
    // (실측: 두 번째 회차의 탭바 차이가 16→17 로 달라졌고, 원인은 남은 탭 1개였다).
    // fixture 레포는 지우지 않는다: 커밋 해시·브랜치 이름이 바뀌면 그것대로 흔들린다.
    if (args.fresh) {
      for (const name of ['orca-dev-userdata', 'orca-dev-home', 'corral-userdata', 'corral-herdr']) {
        fs.rmSync(path.join(args.work, name), { recursive: true, force: true })
      }
    }
    const fixture = ensureFixtureRepo(args.work)
    log(`fixture: ${fixture.root} (+worktree ${fixture.worktree})`)

    log('Orca 개발 인스턴스 기동…')
    orca = await launchOrca({
      repoRoot: args.orcaRepo,
      workDir: args.work,
      port: 9444,
      logPath: path.join(outDir, 'orca-dev.log')
    })
    const orcaRepoId = await seedOrcaRepo(orca, fixture.root)
    const orcaBounds = await setOrcaBounds(orca, { width: args.width, height: args.height })

    log('corral 격리 인스턴스 기동…')
    corral = await launchCorral({ appRoot, workDir: args.work, port: 9445, logDir: outDir })
    await seedCorralRepo(corral, fixture.root)
    const corralBounds = await setCorralBounds(corral, { width: args.width, height: args.height })
    await pause(1200)

    const areas = args.areas.map(loadArea)
    const baseline = await ensureBaseline({ orca, corral, fixtureRoot: fixture.root })
    log(`기준선: orca 탭 ${baseline.orca.tabs}개 / corral workspace ${baseline.corral?.workspace?.workspace_id ?? '?'}`)

    const byArea = new Map(areas.map((area) => [area.name, { area: area.name, description: area.description, states: [] }]))
    const noiseFloor = []
    const stateMatrix = []
    const warnings = []

    // **상태가 바깥 고리다.** 영역을 바깥에 두면 sidebar/agents-2 에서 꽂은 에이전트가
    // tabbar/default 까지 따라와 "기본 상태" 가 기본이 아니게 된다. 상태는 누적이므로
    // `--states` 에 준 순서대로 적용되고, 그 순서가 곧 의미다 (default 를 먼저 둔다).
    for (const state of args.states) {
      const applied = await applyState(state, { orca, corral, orcaRepoId })
      writeJson(path.join(outDir, `state-${state}.json`), applied)
      for (const area of areas) {
        stateMatrix.push({ area: area.name, state, reproduced: applied.reproduced, reason: applied.reason ?? applied.detail })
        if (!applied.reproduced) {
          byArea.get(area.name).states.push({ state, skipped: applied.reason })
          continue
        }
        const tag = `${area.name}-${state}`

        // C5 — 음성 대조를 **본 diff 와 같은 경로로**, 연달아 두 번 찍어서 낸다.
        const orcaA = await capture('orca', orca, area, { outDir, tag: `${tag}-orca-a` })
        const orcaB = await capture('orca', orca, area, { outDir, tag: `${tag}-orca-b` })
        const corralA = await capture('corral', corral, area, { outDir, tag: `${tag}-corral-a` })
        const corralB = await capture('corral', corral, area, { outDir, tag: `${tag}-corral-b` })
        for (const [app, first, second] of [['orca', orcaA, orcaB], ['corral', corralA, corralB]]) {
          const self = selfDiff(first, second, { units: area.units, tolerance: args.tolerance })
          writeJson(path.join(outDir, `${tag}-${app}-selfdiff.json`), self)
          noiseFloor.push({
            app: `${app} (${area.name}/${state})`,
            total: self.summary.total,
            tolerance: args.tolerance,
            verdict: self.summary.total === 0 ? '잡음 0 — 통과' : '잡음 있음 — 아래 차이는 그만큼 의심스럽다',
            raw: `${rawRel}/${tag}-${app}-selfdiff.json`,
            findings: self.findings
          })
        }

        const result = diffSnapshots(orcaA, corralA, { units: area.units, tolerance: args.tolerance })
        warnings.push(...compareMeta(orcaA, corralA).map((w) => ({ ...w, where: `${area.name}/${state}` })))
        writeJson(path.join(outDir, `${tag}-orca.json`), orcaA)
        writeJson(path.join(outDir, `${tag}-corral.json`), corralA)
        writeJson(path.join(outDir, `${tag}-diff.json`), result)
        // 분류 초안(C7)은 **영역 정의 파일**에 있다 — 도구가 의도를 추측하지 않는다.
        // 사유가 없는 단위는 `(초안 미정)` 으로 남아, 빈칸이 조용히 통과하지 않는다.
        const classifyById = new Map(
          area.units.map((unit) => [unit.id, unit.classify ? `${unit.classify} — ${unit.classifyWhy ?? '사유 미기재'}` : null])
        )
        byArea.get(area.name).states.push({
          state,
          findings: result.findings.map((finding) => {
            const classification = classifyById.get(finding.id)
            return classification ? { ...finding, classification } : finding
          }),
          summary: result.summary,
          raw: `${rawRel}/${tag}-diff.json`
        })
        log(`${area.name}/${state}: 차이 ${result.summary.total}건 (자기 diff 잡음 ${noiseFloor.slice(-2).map((n) => n.total).join('/')})`)
      }
    }
    const results = [...byArea.values()]

    // 양성 대조 (C6) — 도구 출력에서 **자동으로** 해당 행을 찾는다. 사람의 해석이 끼면 대조가 아니다.
    const positiveControls = evaluatePositiveControls(results)

    if (args.dumpDom) {
      for (const area of areas) {
        writeJson(path.join(outDir, `dom-${area.name}-orca.json`), await dumpDom(orca, area.root.orca))
        writeJson(path.join(outDir, `dom-${area.name}-corral.json`), await dumpDom(corral, area.root.corral))
      }
    }

    const conditions = [
      { label: '실행 모드', orca: 'electron-vite dev (소스 v1.4.198)', corral: 'electron-vite build 산출물 (out/)' },
      { label: '측정 채널', orca: 'raw CDP', corral: 'raw CDP' },
      { label: 'userData', orca: orca.paths.userData, corral: corral.paths.userData },
      { label: 'HOME', orca: orca.paths.home, corral: '(실제 HOME — corral 은 전역 provider 설정을 쓰지 않는다)' },
      { label: '뷰포트(요청)', orca: `${args.width}x${args.height}`, corral: `${args.width}x${args.height}` },
      { label: '뷰포트(관측, Emulation.setDeviceMetricsOverride 두 앱 동일 인자)', orca: `${orcaBounds.innerWidth}x${orcaBounds.innerHeight} @${orcaBounds.devicePixelRatio}x`, corral: `${corralBounds.innerWidth}x${corralBounds.innerHeight} @${corralBounds.devicePixelRatio}x` },
      { label: '박스 허용치', orca: `${args.tolerance}px`, corral: `${args.tolerance}px` },
      { label: 'dev 주입 style 태그 수', orca: '아래 각 스냅샷 meta.devStyleTags', corral: '아래 각 스냅샷 meta.devStyleTags' }
    ]

    const report = renderReport({
      date: new Date().toISOString().slice(0, 10),
      runs: path.relative(repoRoot, args.ledger),
      areas: results,
      notes: { conditions, warnings, noiseFloor, positiveControls, stateMatrix }
    })
    const reportPath = path.join(outDir, 'report.md')
    fs.writeFileSync(reportPath, report)
    writeJson(path.join(outDir, 'summary.json'), {
      runId,
      command,
      args,
      conditions,
      warnings,
      noiseFloor,
      positiveControls,
      stateMatrix,
      excludedProps: EXCLUDED_PROPS,
      propSets: PROP_SETS,
      areas: results.map((area) => ({ area: area.area, states: area.states.map((s) => ({ state: s.state, summary: s.summary ?? null, skipped: s.skipped ?? null })) }))
    })
    log(`결과: ${reportPath}`)

    // **관문은 종료코드다.** 잡음 바닥(C5)이 0 이 아니거나 양성 대조(C6)를 못 잡았으면
    // 그 회차의 차이 목록은 못 믿는다 — 그런데도 exit 0 이면 447~450 이 "같은 명령을 돌려
    // 통과했다" 고 읽는다. 실측: 잡음 1/1 인 회차가 종료코드 0 으로 통과 행에 남았다.
    const noisy = noiseFloor.filter((entry) => entry.total > 0)
    const missedControls = positiveControls.filter((entry) => !entry.verdict.includes('통과'))
    if (noisy.length > 0 || missedControls.length > 0) {
      const why = [
        ...noisy.map((entry) => `잡음 바닥 ${entry.app} ${entry.total}건`),
        ...missedControls.map((entry) => `양성 대조 ${entry.id} 못 잡음`)
      ].join(' / ')
      log(`관문 미달: ${why} — 이 회차의 차이 목록은 근거로 쓰지 않는다`)
      record(`실패 — 관문 미달: ${why}`, { exit: 1 })
      return 1
    }
    record('통과')
    return 0
  } catch (error) {
    fs.writeFileSync(path.join(outDir, 'error.txt'), `${String(error?.stack ?? error)}\n`)
    record(`실패 — ${String(error?.message ?? error).slice(0, 180)}`, { exit: 1 })
    process.stderr.write(`[l443] 실패: ${String(error?.stack ?? error)}\n`)
    return 1
  } finally {
    if (!args.keep) await shutdown({ orca, corral, outDir })
    else {
      // 앱은 남기되 **소켓은 닫는다** — 열린 WebSocket 이 이 프로세스의 이벤트 루프를 붙잡는다.
      await orca?.cdp.close().catch(() => {})
      await corral?.cdp.close().catch(() => {})
      log('--keep: 두 인스턴스를 남겨 둔다 (CDP 소켓만 닫았다)')
    }
  }
}

/** 양성 대조 판정 — 도구가 낸 차이 목록에서 해당 행이 실제로 있는지 본다 (C6). */
function evaluatePositiveControls(results) {
  const find = (areaName, stateName, unitId) => {
    const area = results.find((entry) => entry.area === areaName)
    const state = area?.states.find((entry) => entry.state === stateName)
    return state?.findings?.filter((finding) => finding.id === unitId) ?? []
  }
  const controls = [
    {
      id: 'C6ⓐ',
      area: 'sidebar',
      state: 'agents-2',
      unit: 'agent-group-pill',
      claim: '에이전트 2개에서 Orca 는 "N agents" 묶음이 있고 corral 은 없다 (임계 2 vs 3)'
    },
    {
      id: 'C6ⓑ',
      area: 'sidebar',
      state: 'default',
      unit: 'repo-header-icon',
      claim: '레포 헤더가 Orca 폴더 아이콘 vs corral 이니셜 사각형'
    }
  ]
  return controls.map((control) => {
    const hits = find(control.area, control.state, control.unit)
    const missing = hits.find((finding) => finding.kind === 'missing')
    const any = hits.length > 0
    return {
      ...control,
      evidence: any ? hits.map((h) => `${h.kind}: ${JSON.stringify(h.detail).slice(0, 90)}`).join(' / ') : '(행 없음)',
      // C6ⓐ 는 **존재/부재**로 잡혀야 한다 — 스타일만 다르게 잡히면 "묶음이 없다" 를 증명하지 못한다.
      verdict:
        control.id === 'C6ⓐ'
          ? missing
            ? '잡았다(존재/부재) — 통과'
            : any
              ? '차이는 잡았으나 존재/부재가 아니다 — 확인 필요'
              : '못 잡았다 — 실패'
          : any
            ? '잡았다 — 통과'
            : '못 잡았다 — 실패'
    }
  })
}

/**
 * C12 — 띄운 것을 닫는다. **닫혔는지 확인까지 하고** 기록한다.
 *
 * corral CLI 에는 종료 명령이 없고(`corral --help`: open·serve·status…) 제어 채널에도 `quit` 이 없다.
 * 그래서 `corral open --json` 이 돌려준 `runtime.pid` 를 그대로 끝낸다 — 그 pid 가 우리가 띄운
 * 데스크톱이다. 실측으로 이 자리를 고쳤다: 백엔드만 끄고 끝냈더니 Electron 이 계속 살아남아
 * 다음 회차까지 넘어갔다(회차 r14 의 `shutdown.json` survivors 참고).
 */
async function shutdown({ orca, corral, outDir }) {
  const closed = { at: new Date().toISOString(), orca: null, corral: null }
  const term = (pid, how = 'SIGTERM') => {
    if (!pid) return null
    try {
      process.kill(how === 'group' ? -pid : pid, 'SIGTERM')
      return 'SIGTERM'
    } catch (error) {
      return String(error?.code ?? error)
    }
  }
  try {
    if (corral) {
      const desktopPid = corral.status?.runtime?.pid ?? null
      closed.corral = { desktopPid, backendPid: corral.backend?.pid ?? null }
      await corral.cdp.close().catch(() => {})
      closed.corral.desktopSignal = term(desktopPid)
      closed.corral.backendSignal = term(corral.backend?.pid ?? null)
    }
    if (orca) {
      closed.orca = { devRunnerPid: orca.child?.pid ?? null }
      await orca.cdp.close().catch(() => {})
      // dev 러너는 자기 프로세스 그룹의 우두머리다(detached) — 그룹째 끝내야 electron-vite·Electron 이 같이 간다.
      closed.orca.signal = term(orca.child?.pid ?? null, 'group') ?? term(orca.child?.pid ?? null)
    }
    // 신호를 보낸 것과 죽은 것은 다르다. 기다렸다가 **직접 세어** 본다.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await pause(1000)
      const survivors = spawnSync('pgrep', ['-f', 'orca-dev-userdata|corral-userdata|run-electron-vite-dev|herdr --session l443'], {
        encoding: 'utf8'
      })
      closed.survivorPids = survivors.stdout.trim().split('\n').filter(Boolean)
      if (closed.survivorPids.length === 0) break
      if (attempt === 5) for (const pid of closed.survivorPids) term(Number(pid))
    }
    closed.clean = (closed.survivorPids ?? []).length === 0
    closed.survivors = closed.clean ? '(없음)' : spawnSync('pgrep', ['-fl', 'orca-dev-userdata|corral-userdata|run-electron-vite-dev|herdr --session l443'], { encoding: 'utf8' }).stdout.trim()
  } catch (error) {
    closed.error = String(error?.message ?? error)
  }
  try {
    writeJson(path.join(outDir, 'shutdown.json'), closed)
  } catch {
    /* outDir 이 없으면 기록할 곳도 없다 */
  }
  return closed
}

process.exitCode = await main()
