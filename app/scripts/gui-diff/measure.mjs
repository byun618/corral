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

/* global document -- CDP evaluate 로 페이지 안에서 도는 클로저가 쓴다 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { pause, until, assertPortFree, clickElement } from './lib/cdp.mjs'
import { collectSnapshot, settlePage, PROP_SETS, EXCLUDED_PROPS } from './lib/probe.mjs'
import { diffSnapshots, selfDiff, compareMeta, fontCaptureFailures } from './lib/diff.mjs'
import { renderReport, writeJson } from './lib/report.mjs'
import { ensureFixtureRepo } from './lib/fixture.mjs'
import { launchOrca, seedOrcaRepo, applyOrcaState, setWindowBounds as setOrcaBounds } from './lib/orca.mjs'
import { launchCorral, seedCorralRepo, applyCorralState, setWindowBounds as setCorralBounds, backendRpc, rpc } from './lib/corral.mjs'
import { ensureLedger, beginRun, finishRun } from './lib/runs.mjs'
import { evaluateControls, POSITIVE_CONTROLS } from './lib/controls.mjs'
import {
  selectOwnedByPath,
  planSignals,
  pathDiagnosis,
  cleanVerdict,
  parseProcessList,
  commandIncludesPath
} from './lib/own.mjs'

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

/**
 * 경로로 후보를 훑는다 — **진단 전용**이다 (H1). 이 목록으로 신호하지 않는다.
 *
 * 신호는 기동 때 받은 pid 와 그 자손(`descendantPids`)만 받는다. 경로를 신호 근거에서 내린 이유는
 * `lib/own.mjs` 머리말에 있다 — 평탄한 명령줄에서는 argv 경계를 복원할 수 없어, 공백이 든 경로에서
 * 남의 프로필 Electron 을 소유로 만들 수 있다(리뷰 R3-01). 대신 **살아남은 것을 보고**한다.
 *
 * **검색은 정규식이 아니라 문자열이다** (I1). `pgrep -f <경로>` 의 패턴은 확장 정규식이라
 * `--work '/tmp/l443[1]'` 같은 경로에서 우리 고아가 조용히 빠졌다(리뷰 R4-01). 그래서 `ps` 로
 * **전체 목록**을 받아 JS 에서 거르고, 목록 자체를 못 읽으면 「후보 없음」이 아니라 **진단 실패**다.
 */
function probeProcesses() {
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (out.error) return { ok: false, processes: [], error: `ps 실행 실패 — ${String(out.error.message ?? out.error)}` }
  if (out.status !== 0) return { ok: false, processes: [], error: `ps → 종료코드 ${out.status} ${String(out.stderr ?? '').slice(0, 160)}` }
  const parsed = parseProcessList(out.stdout).filter((entry) => entry.pid !== process.pid)
  // 이 프로세스 자신은 반드시 목록에 있다. 비었다면 읽은 것이 목록이 아니다.
  if (parsed.length === 0) return { ok: false, processes: [], error: 'ps 출력이 비었다 — 경로 진단을 못 했다' }
  return { ok: true, processes: parsed, error: null }
}

function candidatesUsingPath(target, probe = probeProcesses()) {
  if (probe.ok !== true) return []
  return probe.processes.filter((entry) => commandIncludesPath(entry.command, target))
}

/** pid 의 **자손 전부**. 소유의 1순위다 — 이름·경로 추측이 아니라 부모 관계로만 잇는다. */
function descendantPids(pid, seen = new Set()) {
  const out = []
  const kids = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value))
  for (const kid of kids) {
    if (seen.has(kid)) continue
    seen.add(kid)
    out.push(kid, ...descendantPids(kid, seen))
  }
  return out
}

/** 기록용 명령줄 한 줄. 없으면 null — 이미 죽은 pid 다. */
function commandOf(pid) {
  const out = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return out ? out.slice(0, 160) : null
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
    controls: false,
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
    // 양성 대조(C6)는 **명시할 때만** 돈다 (F8) — 일반 측정의 관문이 아니다.
    else if (arg === '--controls') out.controls = true
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
  // **부모 단위 짝짓기** (G2): 자식 단위는 `parent` 에 부모 단위 id 를 적고, 그 앱의 부모 선택자를
  // 여기서 풀어 넘긴다. 부모 선택자가 그 앱에 없으면 자식도 그 앱에서 못 재므로 `parentMissing` 이다.
  const byId = new Map(area.units.map((unit) => [unit.id, unit]))
  const spec = {
    root: area.root[app],
    units: area.units.map((unit) => ({
      id: unit.id,
      selector: unit[app],
      props: unit.props,
      global: unit.global,
      parentSelector: unit.parent ? byId.get(unit.parent)?.[app] : undefined
    })),
    props: PROP_SETS
  }
  // 짝짓기 파일이 그 앱에 선택자를 안 준 단위는 "이 앱에는 해당 요소가 없다" 는 선언이다.
  spec.units = spec.units.filter((unit) => typeof unit.selector === 'string')
  const snapshot = await handle.cdp.evaluate(collectSnapshot, spec)
  snapshot.app = app
  // 영역 루트를 못 찾았으면 **그 자리에서 멈춘다** (L2). 이전 판은 `meta.rootFound` 와
  // `error` 를 아무도 읽지 않아 캡처가 조용히 이어졌고, 막아 준 것은 잡음 관문의 부수효과였다.
  if (snapshot.meta?.rootFound === false || snapshot.error) {
    throw new Error(`[l443] ${app} 영역 루트를 못 찾았다: ${snapshot.error ?? area.root[app]}`)
  }
  // 선택자를 안 준 단위는 명시적으로 부재로 채운다 — 빠뜨린 것과 없는 것을 구분한다.
  for (const unit of area.units) {
    if (typeof unit[app] !== 'string') snapshot.elements[unit.id] = { present: false, count: 0, countAll: 0, declaredAbsent: true }
  }

  // 실제로 렌더된 폰트 (C7 분류 규칙: 선언값 ≠ 렌더 폰트). **잰 요소 전부**에 대해 받는다 (G7) —
  // 이전 판은 `DOM.querySelector` 로 첫 노드만 집어서, 탭 5개의 둘째 이후 fallback 변화가
  // 본 diff·자기 diff 모두에서 0 이었다. 수집에 실패한 자리는 **공백(사유)** 로 남긴다.
  snapshot.meta.fontsCollected = false
  // **요소별 실패도 관문으로 보낸다** (H2). 이전 판은 개별 요청이 전부 실패해도 바깥 try 가 정상
  // 종료하면 `fontsCollected:true` 였다 — 특히 자기 대조의 B 캡처에서만 실패하면 본 보고서에도
  // 자기 diff 총계에도 흔적이 없어, 「폰트가 같다」가 아니라 「폰트를 못 쟀다」가 통과로 샜다.
  snapshot.meta.fontErrors = []
  snapshot.meta.fontsRequested = 0
  snapshot.meta.fontsMeasured = 0
  try {
    await handle.cdp.send('DOM.enable')
    await handle.cdp.send('CSS.enable')
    const { root } = await handle.cdp.send('DOM.getDocument', { depth: 0 })
    for (const unit of area.units) {
      if (!unit.props?.includes('text') || typeof unit[app] !== 'string') continue
      const entry = snapshot.elements[unit.id]
      if (!Array.isArray(entry?.items)) continue
      for (const item of entry.items) {
        if (!item.present) continue
        const key = Number.isFinite(item.childIndex) ? `${unit.id}#${item.parentIndex}.${item.childIndex}` : `${unit.id}#${item.parentIndex ?? item.index ?? 0}`
        snapshot.meta.fontsRequested += 1
        try {
          const { nodeId } = await handle.cdp.send('DOM.querySelector', {
            nodeId: root.nodeId,
            // `~=` : 한 요소에 여러 단위 표시가 공백으로 붙는다 (`search-row#0 nav-buttons#0`)
            selector: `[data-l443-node~="${key}"]`
          })
          if (!nodeId) {
            item.fontsError = '표시한 노드를 CDP 에서 다시 못 찾았다'
            snapshot.meta.fontErrors.push({ unit: unit.id, key, error: item.fontsError })
            continue
          }
          const fonts = await handle.cdp.send('CSS.getPlatformFontsForNode', { nodeId })
          // 빈 배열은 **정상**이다 — 글리프가 없는 노드(아이콘·빈 칸)다. 오류로 세지 않는다.
          item.platformFonts = (fonts.fonts ?? []).map((font) => ({ family: font.familyName, glyphs: font.glyphCount }))
          snapshot.meta.fontsMeasured += 1
        } catch (error) {
          item.fontsError = String(error?.message ?? error)
          snapshot.meta.fontErrors.push({ unit: unit.id, key, error: item.fontsError })
        }
      }
      const first = entry.items.find((item) => item.present)
      if (first?.platformFonts) entry.platformFonts = first.platformFonts
      if (first?.fontsError) entry.platformFontsError = first.fontsError
    }
    snapshot.meta.fontsCollected = true
  } catch (error) {
    snapshot.meta.platformFontsError = String(error?.message ?? error)
  }
  // 표시는 지운다 — 측정 대상 DOM 에 우리 흔적을 남기지 않는다(두 앱에 같은 처리이고, 캡처 전에
  // 되돌린다). 못 지워도 값 비교 대상이 아닌 속성이라 차이가 되지 않는다.
  await handle.cdp
    .evaluate(() => {
      for (const el of document.querySelectorAll('[data-l443-node]')) el.removeAttribute('data-l443-node')
      return true
    })
    .catch(() => {})

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
const STATE_TARGETS = {
  default: { tabCount: 1, agents: [], detail: 'fixture 레포 1개 + linked worktree + 열린 탭 1개, 에이전트 없음' },
  'agents-1': {
    tabCount: 1,
    agents: [{ state: 'working', prompt: 'L443 agent 1', agentType: 'claude' }],
    detail: '루트 에이전트 1개 (Orca 묶음 임계 아래)'
  },
  'agents-2': {
    tabCount: 2,
    agents: [
      { state: 'working', prompt: 'L443 fixture agent one', agentType: 'claude' },
      { state: 'working', prompt: 'L443 fixture agent two', agentType: 'codex' }
    ],
    detail: '루트 에이전트 2개 (양성 대조 C6ⓐ 의 상태)'
  },
  'agents-5': {
    tabCount: 5,
    agents: [
      { state: 'working', prompt: 'L443 agent 1', agentType: 'claude' },
      { state: 'idle', prompt: 'L443 agent 2', agentType: 'codex' },
      { state: 'blocked', prompt: 'L443 agent 3', agentType: 'claude' },
      { state: 'working', prompt: 'L443 agent 4', agentType: 'codex' },
      { state: 'idle', prompt: 'L443 agent 5', agentType: 'claude' }
    ],
    detail: '루트 에이전트 5개 (탭 5개, 탭마다 하나)'
  },
  // ---- LIFE-467 K8ⓑ — S1(에이전트 행·묶음) 상태 ----
  expanded: {
    tabCount: 3,
    expand: true,
    agents: [
      { state: 'working', prompt: 'L467 expanded 1', agentType: 'claude' },
      { state: 'idle', prompt: 'L467 expanded 2', agentType: 'codex' },
      { state: 'blocked', prompt: 'L467 expanded 3', agentType: 'claude' }
    ],
    detail: '루트 에이전트 3개, 알약을 **펼친** 상태 — 펼친 행↔펼친 행 짝 (두 앱 다 알약을 눌러 연다)'
  },
  // R4 — 펼친 뒤 다시 접은 무리. Orca 는 한 번 펼친 행을 접은 뒤에도 `[inert]` 로 DOM 에 남긴다 —
  // 측정기가 그 숨은 행을 present 로 세는지 보는 자리다. **`expanded` 바로 뒤에** 둔다(같은 에이전트, 접힘만 다름).
  collapsed: {
    tabCount: 3,
    agents: [
      { state: 'working', prompt: 'L467 expanded 1', agentType: 'claude' },
      { state: 'idle', prompt: 'L467 expanded 2', agentType: 'codex' },
      { state: 'blocked', prompt: 'L467 expanded 3', agentType: 'claude' }
    ],
    detail: '`expanded` 와 같은 에이전트 3개를 **다시 접은** 상태 — 접힌 무리 안의 숨은(inert) 행이 부재로 잡혀야 한다 (R4)'
  },
  done: {
    tabCount: 2,
    agents: [{ state: 'done', prompt: 'L467 finished agent', agentType: 'claude' }],
    // 첫 탭은 포커스된 탭이라 corral(herdr)에서 done 이 곧장 idle 로 내려간다. 그래서 **빈 첫 탭** 뒤에 둔다.
    leadingEmptyTabs: 1,
    detail:
      '끝났는데 아직 안 본(done) 에이전트 1개 — 포커스 안 된 둘째 탭. corral 은 굵게(B1, 1.4.217 기준), Orca 198 compact 는 안 굵다. ' +
      '**`--states` 의 맨 끝에 둔다**: 다음 상태가 이 탭을 닫으면 corral 은 done 에이전트를 보존 행(retained)으로 남겨 루트가 하나 늘어난다 ' +
      '(제품 동작 — 실측 R013 `wait` 불일치)'
  },
  wait: {
    tabCount: 1,
    agents: [{ state: 'blocked', prompt: 'L467 waiting for approval', agentType: 'claude' }],
    detail:
      '입력 대기(blocked) 에이전트 1개. **질문 아이콘 변형(Orca `waiting` ↔ corral `waiting` 점)은 corral 에 주입 못 한다** — ' +
      'corral 의 질문/권한 사유는 herdr `agent.explain` 규칙 id 나 세션 파일의 pendingQuestions 에서만 오고 RPC 보고로는 안 선다. 네이티브 관문(K11)이 맡는다'
  },
  'long-name': {
    tabCount: 1,
    agents: [
      {
        state: 'working',
        prompt: 'L467 long name',
        title: 'L467 a deliberately long agent title that must be truncated in a single line together with its secondary text so the row never wraps',
        agentType: 'codex'
      }
    ],
    detail: '긴 이름 에이전트 1개 — 한 줄 잘림(앞·뒤 같은 칸) 확인. 주입 원천이 두 앱에서 다르다: corral 은 터미널 제목(OSC 2 → 앞 칸), Orca 는 마지막 답 줄(hook → 뒤 칸). 두 앱 다 **같은 글 칸 하나**에서 잘리는지를 본다'
  }
}

/**
 * 측정 도구가 **주입 못 하는** S1 상태 (U3). 보고서에 보류 + 사유로 싣는다 — 「없다」가 아니라 「못 만든다」다.
 */
const UNINJECTABLE_STATES = [
  { state: '계보 자식 행', why: 'corral 계보는 orca orchestration 원장(orchestrationLineage)에서만 온다 — 격리 인스턴스에 원장을 만드는 제품 경로가 없다. K1 #19 네이티브 덤프가 원자료' },
  { state: '서브에이전트 자식 행', why: 'corral 서브에이전트는 claude 세션 파일(lifecycle.subagents)에서만 온다 — RPC 보고로 못 선다. 단위 테스트(sidebar-agents.test.ts)가 모양을 잠근다' },
  { state: '보존(retained) 행', why: '**만들 수는 있지만 독립 제어·초기화가 안 된다.** 보존은 corral main 이 herdr 에서 사라진 done pane 을 기록하는 것이라 RPC 보고 pane 으로도 선다(실측 R013 — `done` 뒤 탭을 닫자 보존 행이 생겨 다음 상태 `wait` 를 오염시켰다). 그러나 도구에 보존 목록을 비우는 경로가 없어 상태 사이에 끌려가고, Orca 에 대응 행도 없다. 모양은 단위 테스트, 실제 경로는 K1 #20·fix-r1 R1 네이티브 덤프가 원자료' },
  { state: '모델 칸', why: 'corral 모델은 세션 파일 digest.model 에서만 온다. Orca 는 hook 페이로드. K1 네이티브 덤프(claude-opus-5-5 · grok-4.7-build)가 원자료' },
  { state: '긴 이름 (corral 쪽)', why: 'corral 행 제목의 주입 가능한 원천은 터미널 제목(OSC 2)뿐인데 기존 규칙(`truncatePathLeft`)이 15자로 왼쪽을 자른다 — 긴 글은 세션 파일의 provider 제목·첫 프롬프트에서만 선다. 상태 `long-name` 은 Orca 쪽 긴 글만 재고, corral 한 줄 잘림은 단위 테스트(C8)와 네이티브 관문(K11 실제 프롬프트)이 맡는다' },
  { state: '질문/권한 아이콘(waiting)', why: 'blockedReason 은 herdr agent.explain 규칙 id·pendingQuestions 에서만 온다 — 상태 `wait` 은 blocked 점으로 잰다. K1 R010 네이티브 덤프가 원자료' }
]

/**
 * 묶음 알약의 펼침을 **요청대로** 맞추고 화면 표현을 읽는다 (LIFE-467 K8).
 *
 * 상태는 누적이라 앞 상태가 펼쳐 둔 알약이 다음 상태로 따라온다 — 그래서 모든 상태가 원하는 펼침을
 * 명시하고(기본 접힘) 여기서 다르면 **알약을 눌러** 맞춘다(두 앱 다 제품 클릭 경로).
 * 표현(shape)은 두 앱을 같은 어휘로 읽는다: 알약이 있으면 summary, 행만 있으면 row, 없으면 none.
 * 행 수는 **보이는 행**만 센다 — Orca 는 한 번 펼친 내용을 접은 뒤에도 inert 로 남겨 둔다.
 */
async function applyExpansion({ orca, corral, want, roots }) {
  const read = (handle, selectors) =>
    handle.cdp.evaluate(({ pill, row }) => {
      const button = document.querySelector(pill)
      const rows = [...document.querySelectorAll(row)].filter((el) => el.closest('[inert]') === null && el.getClientRects().length > 0)
      const expandedAttr = button?.getAttribute('aria-expanded') ?? null
      return {
        shape: button ? 'summary' : rows.length > 0 ? 'row' : 'none',
        expanded: expandedAttr === null ? null : expandedAttr === 'true',
        rows: rows.length
      }
    }, selectors)
  const apps = [
    { name: 'orca', handle: orca, selectors: { pill: '.compact-agent-summary-button', row: '.compact-agent-row' } },
    { name: 'corral', handle: corral, selectors: { pill: '.agent-group-pill', row: '.session-row' } }
  ]
  const wantShape = roots === 0 ? 'none' : roots > 1 ? 'summary' : 'row'
  const wantRows = roots === 0 ? 0 : roots === 1 || want ? roots : 0
  const out = {}
  for (const app of apps) {
    let seen = await read(app.handle, app.selectors)
    const converged = await until(
      async () => {
        seen = await read(app.handle, app.selectors)
        if (seen.shape === 'summary' && seen.expanded !== want) {
          await clickElement(app.handle.cdp, app.selectors.pill)
          // 포인터를 알약에서 치운다 — hover 칠이 캡처에 남지 않게.
          await app.handle.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 700, buttons: 0 })
          return false
        }
        return seen.shape === wantShape && seen.rows === wantRows
      },
      `${app.name} 알약 펼침=${want} · 표현 ${wantShape} · 보이는 행 ${wantRows}`,
      20_000
    ).then(
      () => true,
      () => false
    )
    out[app.name] = { ...seen, converged }
  }
  return { want, wantShape, wantRows, ...out }
}

/**
 * 두 앱을 같은 상태로 맞추고 **맞춰졌는지 검증한다** (F2·F4).
 *
 * 이전 판은 두 호출이 예외 없이 끝나면 `reproduced: true` 였다. 그래서 Orca 에이전트가 7개(누적)이고
 * corral 탭이 1개(pane 분할)인 회차가 「에이전트 5개 상태」로 보고서에 실렸고, 그 비대칭이
 * LIFE-449 해소 대상 목록에 들어갔다. 지금은 축마다 요청값·관측값을 적고, **어긋난 축은 이름으로 남긴다** —
 * 그 축에 달린 차이 행은 보고서에서 「해소 대상」이 아니라 「보류(하네스가 만든 차이)」로 내려간다.
 */
async function applyState(state, { orca, corral, orcaRepoId }) {
  const target = STATE_TARGETS[state]
  if (!target) return { reproduced: false, reason: `상태 '${state}' 는 이 도구가 아직 재현하지 못한다`, mismatched: ['정의없음'] }

  const agentOffset = target.leadingEmptyTabs ?? 0
  const o = await applyOrcaState(orca, { repoId: orcaRepoId, tabCount: target.tabCount, agents: target.agents, agentOffset })
  const c = await applyCorralState(corral, { tabCount: target.tabCount, agents: target.agents, agentOffset })
  const expansion = await applyExpansion({ orca, corral, want: target.expand === true, roots: target.agents.length })

  const wantStatuses = target.agents.map((agent) => agent.state).slice().sort().join(',')
  const axes = [
    {
      axis: 'tabCount',
      label: '탭 수',
      requested: target.tabCount,
      orca: o.domTabs ?? o.tabIds?.length ?? null,
      corral: c.domTabs ?? c.tabIds?.length ?? null
    },
    {
      axis: 'agentCount',
      label: '에이전트 수',
      requested: target.agents.length,
      // Orca 는 **스토어 전체**를 센다 — 넣은 것만 세면 누적을 못 잡는다.
      orca: o.liveAgents ?? null,
      corral: c.applied?.length ?? null
    },
    {
      axis: 'agentStatuses',
      label: '상태 분포',
      requested: wantStatuses,
      orca: (o.statuses ?? []).filter(Boolean).slice().sort().join(','),
      corral: (c.agentStatuses ?? []).slice().sort().join(',')
    },
    {
      axis: 'activeTab',
      label: '활성 탭 순번',
      requested: 0,
      orca: o.activeTabIndex ?? null,
      corral: c.activeTabIndex ?? null
    },
    {
      // LIFE-467 — 두 앱이 **같은 표현**을 쓴다 (루트 2개 이상 → 알약, 1개 → 행). 전에는 corral 이 pane 행을
      // 그대로 그려서 「각자 자기 기대」만 봤다. 이제 표현·펼침·보이는 행 수를 같은 기대에 견준다.
      axis: 'renderedShape',
      label: '화면 표현 (알약/행 · 펼침 · 보이는 행 수)',
      requested: `${expansion.wantShape} · 펼침=${expansion.want} · 행 ${expansion.wantRows}`,
      orca: `${expansion.orca.shape} · 펼침=${expansion.orca.expanded} · 행 ${expansion.orca.rows}`,
      corral: `${expansion.corral.shape} · 펼침=${expansion.corral.expanded} · 행 ${expansion.corral.rows}`,
      ok: expansion.orca.converged && expansion.corral.converged
    },
    {
      // **화면이 낡은 집계를 그리고 있으면 재현이 아니다** (G4). 이전 판은 수렴 대기가 타임아웃되면
      // `dotsConverged:false` 를 관측값으로만 남기고 아무도 읽지 않았다 — 탭 수·상태·활성 탭이 맞고
      // **점만 낡은** 회차가 C9 통과로 들어갔다. 대기 실패를 그대로 축 불일치로 올린다.
      axis: 'tabDots',
      label: '탭 점이 backend 집계에 탭마다 수렴 (corral)',
      requested: 'true',
      orca: '해당 없음 — Orca 는 탭 집계 점이 없다',
      corral: String(c.dotsConverged === true),
      expectCorral: 'true',
      corralOnly: true
    }
  ]
  const compare = (axis) => {
    if (typeof axis.ok === 'boolean') return axis.ok
    if (axis.corralOnly === true) return String(axis.corral) === String(axis.expectCorral)
    if (axis.axis === 'renderedShape') {
      return String(axis.orca) === String(axis.expectOrca) && String(axis.corral) === String(axis.expectCorral)
    }
    if (axis.axis === 'agentStatuses') {
      return axis.orca === axis.requested && axis.corral === axis.requested
    }
    return String(axis.orca) === String(axis.requested) && String(axis.corral) === String(axis.requested)
  }
  for (const axis of axes) axis.ok = compare(axis)
  const mismatched = axes.filter((axis) => !axis.ok).map((axis) => axis.axis)

  return {
    // **축 하나라도 어긋나면 「재현했다」고 적지 않는다.** 그 상태의 차이 목록은 남기지만
    // 분류는 보류로 내려가고, 판정표에서 C9 는 그 회차를 실패로 센다.
    reproduced: mismatched.length === 0,
    reason: mismatched.length === 0 ? null : `축 불일치: ${mismatched.join(', ')}`,
    detail: target.detail,
    target,
    axes,
    mismatched,
    orca: o,
    corral: c,
    expansion
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
  const command = `node app/scripts/gui-diff/measure.mjs ${process.argv.slice(2).join(' ')}`
  const rawRel = path.relative(repoRoot, outDir)

  /**
   * 이 회차가 **실제로 거는 기준**을 도구가 스스로 적는다 (M8·F5).
   * 이전 판은 짧은 고정 템플릿만 쓰고 사람이 나중에 칸을 고쳤다 — 그래서 원장의 출처 보증이 깨졌고
   * 정리하지 않은 `--keep` 회차에까지 C12 가 붙었다. 여기서 조건을 코드로 적는다.
   */
  // **그 회차가 실제로 시험한 기준만 적는다** (G3). 여기 적힌 기준이 곧 판정표의 분모다 —
  // 시험하지 않은 기준을 적으면 그 회차가 그 기준의 분모·분자로 들어간다.
  // C10(재현성)은 **한 회차로 시험할 수 없다**: 회차 둘 이상을 견주는 `compare-runs` 만 그 기준을
  // 시험한다. 이전 판은 측정 회차마다 C10 을 붙여 단일 회차를 재현성 통과로 셌다.
  const criterionOf = () => {
    const parts = ['C1', 'C4', 'C5', 'C7', 'C8']
    if (args.states.some((state) => state !== 'default')) parts.push('C9')
    if (args.controls) parts.push('C6')
    parts.push(args.keep ? 'C12 해당 없음 — --keep (정리를 돌지 않는다)' : 'C12')
    return `${parts.join('·')} (areas=${args.areas.join('+')} states=${args.states.join('+')}${args.controls ? ' +controls' : ''})`
  }
  const criterion = criterionOf()
  const runId = beginRun(args.ledger, { criterion, command, raw: rawRel })
  const record = (result, extra = {}) =>
    finishRun(args.ledger, runId, {
      criterion: extra.criterion ?? criterion,
      command,
      expectedExit: 0,
      actualExit: extra.exit ?? (result.startsWith('통과') ? 0 : 1),
      raw: rawRel,
      result
    })

  let orca = null
  let corral = null
  // **소유 목록** (F1): 이번 실행이 띄운 것만 적는다. 정리는 이 목록만 보고 한다 —
  // 이름으로 훑어 죽이던 이전 판은 사용자가 따로 띄운 Orca 개발 서버까지 잡을 수 있었다.
  const owned = { pids: [], paths: [], preexisting: [] }
  const own = (entry) => {
    if (entry?.pid) owned.pids.push(entry)
    return entry
  }
  const log = (message) => process.stderr.write(`[l443] ${message}\n`)

  try {
    fs.mkdirSync(args.work, { recursive: true })
    // 회차마다 격리 프로필을 **버리고 새로 만든다.** 남겨 두면 지난 회차의 탭·워크스페이스가
    // 살아남아 같은 명령이 다른 상태를 잰다 — C10(재현성)이 그 자리에서 깨진다
    // (실측: 두 번째 회차의 탭바 차이가 16→17 로 달라졌고, 원인은 남은 탭 1개였다).
    // fixture 레포는 지우지 않는다: 커밋 해시·브랜치 이름이 바뀌면 그것대로 흔들린다.
    if (args.fresh) {
      // **지우기 전에** 두 CDP 포트가 비었는지, 작업 폴더를 쓰는 프로세스가 없는지 본다 (F6).
      // 이전 판은 삭제가 먼저였고 포트 검사는 기동 직전이었다 — `--keep` 으로 사람이 보고 있던
      // 인스턴스나 앞선 회차의 프로필을 **먼저 없앤 뒤** "포트 사용 중" 으로 멈췄다.
      await assertPortFree(9444, 'orca-dev (프로필 삭제 전 확인)')
      await assertPortFree(9445, 'corral (프로필 삭제 전 확인)')
      const profiles = ['orca-dev-userdata', 'orca-dev-home', 'corral-userdata', 'corral-herdr'].map((name) =>
        path.join(args.work, name)
      )
      // 진단 실패(목록을 못 읽음)를 「쓰는 프로세스 없음」으로 읽지 않는다 — 지우기 전이라 더 그렇다 (I1).
      const precheckProbe = probeProcesses()
      if (precheckProbe.ok !== true) {
        throw new Error(`[l443] 프로세스 목록을 읽지 못해 격리 프로필 사용 여부를 확인할 수 없다 — 지우지 않고 멈춘다: ${precheckProbe.error}`)
      }
      const inUse = profiles.flatMap(
        (target) =>
          selectOwnedByPath({
            processes: candidatesUsingPath(target, precheckProbe),
            targets: [target],
            selfPid: process.pid
          }).owned
      )
      if (inUse.length > 0) {
        throw new Error(
          `[l443] 격리 프로필을 쓰는 앱 프로세스가 있다 — 프로필을 지우지 않고 멈춘다:\n${inUse
            .map((entry) => `  ${entry.pid} ${entry.command.slice(0, 120)}`)
            .join('\n')}`
        )
      }
      for (const name of ['orca-dev-userdata', 'orca-dev-home', 'corral-userdata', 'corral-herdr']) {
        fs.rmSync(path.join(args.work, name), { recursive: true, force: true })
      }
    }
    if (!args.fresh) {
      // **재사용과 소유를 가른다** (G1). `--no-fresh` 는 격리 프로필을 남겨 두므로, 이번 실행이
      // 띄우지 않은 인스턴스가 그 프로필을 쓰고 있을 수 있다. 시작 시점의 그 pid 들을 적어 두고
      // 정리에서 **건드리지 않는다** — 소유는 이번 실행이 만든 것에 한한다.
      const profiles = ['orca-dev-userdata', 'orca-dev-home', 'corral-userdata', 'corral-herdr'].map((name) =>
        path.join(args.work, name)
      )
      const reuseProbe = probeProcesses()
      if (reuseProbe.ok !== true) {
        throw new Error(`[l443] 프로세스 목록을 읽지 못해 --no-fresh 의 기존 pid 를 가를 수 없다 — 멈춘다: ${reuseProbe.error}`)
      }
      owned.preexisting = [
        ...new Set(profiles.flatMap((target) => candidatesUsingPath(target, reuseProbe).map((entry) => entry.pid)))
      ]
      if (owned.preexisting.length > 0) {
        log(`--no-fresh: 이번 실행 전부터 격리 경로를 쓰는 pid ${owned.preexisting.join(', ')} — 소유에서 뺀다`)
      }
    }
    const fixture = ensureFixtureRepo(args.work)
    log(`fixture: ${fixture.root} (+worktree ${fixture.worktree})`)

    log('Orca 개발 인스턴스 기동…')
    // **기동이 중간에 실패해도 이미 띄운 것은 소유다** (G5). 그래서 등록은 `launchOrca` 가
    // 성공 handle 을 돌려준 뒤가 아니라, **spawn 직후 콜백**에서 한다. 이전 판은 CDP 대기가
    // 타임아웃되면 Electron 이 떠 있는데 정리 목록이 비었다.
    orca = await launchOrca({
      repoRoot: args.orcaRepo,
      workDir: args.work,
      port: 9444,
      logPath: path.join(outDir, 'orca-dev.log'),
      onSpawn: (entry) => {
        if (entry.pid) own({ pid: entry.pid, label: entry.label ?? 'orca dev 런너(프로세스 그룹)', group: entry.group === true })
        for (const item of entry.paths ?? []) owned.paths.push(item)
      }
    })
    const orcaRepoId = await seedOrcaRepo(orca, fixture.root)
    const orcaBounds = await setOrcaBounds(orca, { width: args.width, height: args.height })

    log('corral 격리 인스턴스 기동…')
    corral = await launchCorral({
      appRoot,
      workDir: args.work,
      port: 9445,
      logDir: outDir,
      onSpawn: (entry) => {
        if (entry.pid) own({ pid: entry.pid, label: entry.label ?? 'corral', group: entry.group === true })
        for (const item of entry.paths ?? []) owned.paths.push(item)
      }
    })
    corral.workspaceId = null
    await seedCorralRepo(corral, fixture.root)
    const corralBounds = await setCorralBounds(corral, { width: args.width, height: args.height })
    await pause(1200)

    const areas = args.areas.map(loadArea)
    const baseline = await ensureBaseline({ orca, corral, fixtureRoot: fixture.root })
    corral.workspaceId = baseline.corral?.workspace?.workspace_id ?? 'w1'
    log(`기준선: orca 탭 ${baseline.orca.tabs}개 / corral workspace ${baseline.corral?.workspace?.workspace_id ?? '?'}`)

    const byArea = new Map(areas.map((area) => [area.name, { area: area.name, description: area.description, states: [] }]))
    // 캡처가 **폰트를 못 받은** 자리를 모은다 (G7). 「차이 0」과 「못 쟀다」를 관문에서도 가른다.
    const captureFailures = []
    // 네 캡처(A·B × 두 앱) 전부를 본다 — 본 diff 에 쓰지 않는 B 캡처의 실패도 여기서 걸린다 (H2).
    // 판단은 `lib/diff.mjs` 의 순수 함수에 있다 — 반례를 단위 테스트로 세우려고 뺐다.
    const noteCapture = (label, snapshot) => {
      captureFailures.push(...fontCaptureFailures(label, snapshot?.meta))
      return snapshot
    }
    const noiseFloor = []
    const stateMatrix = []
    const warnings = []

    // **상태가 바깥 고리다.** 영역을 바깥에 두면 sidebar/agents-2 에서 꽂은 에이전트가
    // tabbar/default 까지 따라와 "기본 상태" 가 기본이 아니게 된다. 상태는 누적이므로
    // `--states` 에 준 순서대로 적용되고, 그 순서가 곧 의미다 (default 를 먼저 둔다).
    const prerequisites = {}
    const stateAxes = []
    for (const state of args.states) {
      const applied = await applyState(state, { orca, corral, orcaRepoId })
      // 양성 대조(C6ⓐ)의 전제는 **이 프로필의 실제 값**이다 — 코드 기본값으로 미루지 않는다.
      if (applied.orca) {
        prerequisites.orcaCompact = applied.orca.agentActivityDisplayMode === 'compact'
        prerequisites.orcaNotSendTarget = applied.orca.isAgentSendTargetModeActive === false
      }
      stateAxes.push({ state, reproduced: applied.reproduced, axes: applied.axes ?? [], mismatched: applied.mismatched ?? [] })
      if (!applied.reproduced) log(`상태 ${state}: 재현 불일치 — ${applied.reason}`)
      writeJson(path.join(outDir, `state-${state}.json`), applied)
      for (const area of areas) {
        stateMatrix.push({
          area: area.name,
          state,
          reproduced: applied.reproduced,
          reason: applied.reason ?? applied.detail,
          mismatched: applied.mismatched ?? []
        })
        // **재현 실패라도 측정은 한다.** 다만 그 회차의 차이 행은 분류에서 「보류(하네스가 만든 차이)」로
        // 내려간다 — 공백으로 비우면 무엇이 어긋났는지 다음 사람이 못 본다. 상태 정의 자체가 없으면
        // 잴 것이 없으니 그때만 건너뛴다.
        if ((applied.mismatched ?? []).includes('정의없음')) {
          byArea.get(area.name).states.push({ state, skipped: applied.reason })
          continue
        }
        const tag = `${area.name}-${state}`

        // C5 — 음성 대조를 **본 diff 와 같은 경로로**, 연달아 두 번 찍어서 낸다.
        const orcaA = noteCapture(`${tag}-orca-a`, await capture('orca', orca, area, { outDir, tag: `${tag}-orca-a` }))
        const orcaB = noteCapture(`${tag}-orca-b`, await capture('orca', orca, area, { outDir, tag: `${tag}-orca-b` }))
        const corralA = noteCapture(`${tag}-corral-a`, await capture('corral', corral, area, { outDir, tag: `${tag}-corral-a` }))
        const corralB = noteCapture(`${tag}-corral-b`, await capture('corral', corral, area, { outDir, tag: `${tag}-corral-b` }))
        for (const [app, first, second] of [['orca', orcaA, orcaB], ['corral', corralA, corralB]]) {
          const self = selfDiff(first, second, { units: area.units, tolerance: args.tolerance })
          // **허용치 0 에서도 같이 낸다** (F12). 0.5px 의 근거는 「0.5 를 적용한 뒤 0건」이 아니라
          // 「허용치 없이 재도 흔들림이 얼마였나」다 — 그 숫자를 회차마다 원자료로 남긴다.
          const selfZero = selfDiff(first, second, { units: area.units, tolerance: 0 })
          writeJson(path.join(outDir, `${tag}-${app}-selfdiff.json`), { atTolerance: self, atZero: selfZero })
          noiseFloor.push({
            app: `${app} (${area.name}/${state})`,
            total: self.summary.total,
            totalAtZero: selfZero.summary.total,
            maxDeltaAtZero: Math.max(
              0,
              ...selfZero.findings.flatMap((finding) =>
                finding.kind === 'box' ? finding.detail.map((entry) => Math.abs(entry.delta ?? 0)) : [0]
              )
            ),
            tolerance: args.tolerance,
            verdict:
              self.summary.total === 0
                ? selfZero.summary.total === 0
                  ? '잡음 0 — 통과 (허용치 없이도 0)'
                  : '잡음 0 — 통과 (허용치가 가린 흔들림은 아래 숫자)'
                : '잡음 있음 — 이 회차의 차이는 그만큼 의심스럽다',
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
        // 상태 재현이 어긋난 축(F2·F4)에 달린 단위는 **해소 대상으로 내보내지 않는다.**
        // 그 행의 차이는 제품 차이가 아니라 하네스가 만든 차이일 수 있다.
        const axisById = new Map(area.units.filter((unit) => unit.axis).map((unit) => [unit.id, unit.axis]))
        const demoted = new Set(applied.mismatched ?? [])
        byArea.get(area.name).states.push({
          state,
          findings: result.findings.map((finding) => {
            const axis = axisById.get(finding.id)
            if (axis && demoted.has(axis)) {
              return {
                ...finding,
                classification: `보류 — 상태 재현 불일치(축 ${axis})에 달린 행이다. 제품 차이인지 하네스가 만든 차이인지 이 회차로는 못 가른다`
              }
            }
            const classification = classifyById.get(finding.id)
            return classification ? { ...finding, classification } : finding
          }),
          summary: result.summary,
          // **보고서까지 넘긴다** (G8). 이전 판은 diff 가 만든 이 두 배열을 `states.push()` 가
          // 버려서, 보고서의 두 보조 표가 아예 그려지지 않았다 — raw JSON 을 따로 열지 않는
          // 다음 작업자에게는 「허용치가 가린 것」과 「못 잰 폰트」가 없는 것으로 보였다.
          belowTolerance: result.belowTolerance,
          fontUnmeasured: result.fontUnmeasured,
          raw: `${rawRel}/${tag}-diff.json`
        })
        log(`${area.name}/${state}: 차이 ${result.summary.total}건 (자기 diff 잡음 ${noiseFloor.slice(-2).map((n) => n.total).join('/')})`)
      }
    }
    // LIFE-467 U3 — 도구가 **주입 못 하는** S1 상태를 보류 + 사유로 싣는다 (관문 축이 아니다 — 재지 않은 것을
    // 재현 실패로 세지 않고, 빈칸으로도 두지 않는다).
    if (areas.some((area) => area.name === 'sidebar')) {
      for (const entry of UNINJECTABLE_STATES) {
        stateMatrix.push({ area: 'sidebar', state: entry.state, reproduced: false, reason: `보류 — 도구가 주입 못 함: ${entry.why}`, mismatched: [] })
      }
    }
    const results = [...byArea.values()]

    // 양성 대조 (C6) — **명시 모드에서만** 돈다 (F8). 방향·종류·전제까지 보는 판정은
    // `lib/controls.mjs` 에 있고 단위 테스트가 판별력을 잠근다 (F9).
    const positiveControls = args.controls ? evaluateControls({ results, prerequisites }) : []

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

    // 이 회차를 돌린 **코드의 지문** — 어느 판으로 쟀는지 원자료 안에서 되짚을 수 있게 남긴다.
    //
    // **working tree 를 해시한다** (`git hash-object`). 이전 판은 `git ls-files -s`(인덱스 해시)를 적어서,
    // 커밋 전에 돈 회차의 `blobs` 가 **앞 커밋의 내용**이었다 — 수정은 `uncommitted` 목록으로만 남고
    // 정작 돌린 코드의 지문이 없었다(리뷰 「최종 코드 실행 정체 — 미확인 범위」). 파일 mtime 주장은
    // 실행 지문을 대신하지 못한다. 추적되지 않는 새 파일(`-o`)도 함께 해시한다.
    const codeManifest = (() => {
      const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'app/scripts/gui-diff'], {
        cwd: repoRoot,
        encoding: 'utf8'
      })
      const dirty = spawnSync('git', ['status', '--porcelain', '--', 'app/scripts/gui-diff'], { cwd: repoRoot, encoding: 'utf8' })
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
      const list = files.stdout.trim().split('\n').filter(Boolean)
      const hashed = spawnSync('git', ['hash-object', ...list], { cwd: repoRoot, encoding: 'utf8' })
      const hashes = hashed.stdout.trim().split('\n').filter(Boolean)
      return {
        head: head.stdout.trim() || null,
        // 커밋 안 된 수정이 있으면 그 사실도 적는다 — "커밋된 코드로 쟀다" 를 조용히 주장하지 않는다.
        uncommitted: dirty.stdout.trim().split('\n').filter(Boolean),
        hashedWith: 'git hash-object (working tree)',
        blobs: list.map((file, index) => ({ file, blob: hashes[index] ?? null }))
      }
    })()

    const report = renderReport({
      date: new Date().toISOString().slice(0, 10),
      runs: path.relative(repoRoot, args.ledger),
      areas: results,
      notes: { conditions, warnings, noiseFloor, positiveControls, stateMatrix, stateAxes, controlsMode: args.controls }
    })
    const reportPath = path.join(outDir, 'report.md')
    fs.writeFileSync(reportPath, report)
    // **관문**: 이 회차의 차이 목록을 근거로 쓸 수 있는가. 종료코드와 원장 행이 이 판정을 따른다.
    const noisy = noiseFloor.filter((entry) => entry.total > 0)
    const selectorMiss = results.flatMap((area) =>
      area.states.flatMap((state) =>
        (state.findings ?? [])
          .filter((finding) => finding.kind === 'selector-miss')
          .map((finding) => `${area.area}/${state.state}:${finding.id}`)
      )
    )
    const unreproduced = stateAxes.filter((entry) => !entry.reproduced)
    const missedControls = positiveControls.filter((entry) => !entry.pass)
    // 폰트 **수집 자체**가 깨진 회차는 그 회차의 폰트 차이 0 을 근거로 쓸 수 없다 (G7).
    // 글리프 없는 노드(정상)와 구분해서, 수집 오류만 관문으로 본다.
    const fontCollectionFailures = captureFailures.filter(Boolean)
    const gateWhy = [
      ...fontCollectionFailures.map((entry) => `렌더 폰트 수집 실패 ${entry}`),
      ...noisy.map((entry) => `잡음 바닥 ${entry.app} ${entry.total}건`),
      // 선택자가 0개를 찾은 자리는 **측정 실패**다 (F11) — 「없음」이라는 거짓 차이로 나가면 안 된다.
      ...(selectorMiss.length > 0 ? [`선택자 0개: ${selectorMiss.join(', ')}`] : []),
      ...unreproduced.map((entry) => `상태 재현 불일치 ${entry.state}(${entry.mismatched.join(',')})`),
      ...missedControls.map((entry) => `양성 대조 ${entry.id}: ${entry.verdict}`)
    ]
    const gate = { pass: gateWhy.length === 0, why: gateWhy.join(' / ') || null, controlsMode: args.controls }

    writeJson(path.join(outDir, 'summary.json'), {
      runId,
      command,
      args,
      codeManifest,
      gate,
      conditions,
      warnings,
      noiseFloor,
      positiveControls,
      stateMatrix,
      stateAxes,
      excludedProps: EXCLUDED_PROPS,
      propSets: PROP_SETS,
      areas: results.map((area) => ({
        area: area.area,
        states: area.states.map((s) => ({
          state: s.state,
          summary: s.summary ?? null,
          skipped: s.skipped ?? null,
          stateReproduced: s.stateReproduced ?? null,
          demotedAxes: s.demotedAxes ?? []
        }))
      }))
    })
    log(`결과: ${reportPath}`)

    if (!gate.pass) {
      log(`관문 미달: ${gate.why} — 이 회차의 차이 목록은 근거로 쓰지 않는다`)
      record(`실패 — 관문 미달: ${gate.why}`, { exit: 1 })
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
    if (!args.keep) {
      const closed = await shutdown({ orca, corral, owned, outDir })
      // **정리 실패는 실행 결과다.** 이전 판은 `clean` 을 읽지도 않았다 — 고아를 남긴 회차가
      // 통과 행으로 남고 다음 회차가 그 고아에 붙었다.
      if (closed.clean === false) {
        const uncleaned = closed.survivorPids?.join(',') ?? '?'
        const orphans = (closed.pathSurvivors ?? []).map((entry) => entry.pid).join(',')
        log(`정리 실패: 미정리 pid ${uncleaned}${orphans ? ` (경로만 겹쳐 신호하지 않은 것: ${orphans})` : ''}`)
        record(`실패 — C12 정리 실패(미정리 pid: ${uncleaned}${orphans ? `; 경로 겹침 미신호: ${orphans}` : ''})`, { exit: 1 })
        process.exitCode = 1
      }
    } else {
      // 앱은 남기되 **소켓은 닫는다** — 열린 WebSocket 이 이 프로세스의 이벤트 루프를 붙잡는다.
      await orca?.cdp.close().catch(() => {})
      await corral?.cdp.close().catch(() => {})
      log('--keep: 두 인스턴스를 남겨 둔다 (CDP 소켓만 닫았다)')
    }
  }
}

/** 양성 대조 판정 — 도구가 낸 차이 목록에서 해당 행이 실제로 있는지 본다 (C6). */
/**
 * C12 — 띄운 것을 닫는다. **이번 실행이 소유한 것만** 닫고, 닫혔는지 확인까지 해서 기록한다.
 *
 * 왜 소유 목록인가 (F1): 이전 판은 `pgrep -f 'orca-dev-userdata|corral-userdata|…'` 에 걸린 pid 를
 * 6번째 시도에 전부 SIGTERM 했다. 사용자가 따로 띄운 Orca 개발 서버나 다른 측정 인스턴스도
 * 그 정규식에 걸린다 — 핸들이 하나도 없는 실행(`orca=null, corral=null`)에서도 돌았다.
 * 이름 검색은 **진단**으로만 남긴다: 무엇이 남아 있는지 적기만 하고 죽이지 않는다.
 *
 * **경로 검색도 같은 자리로 내렸다 (H1).** 평탄한 명령줄은 argv 경계의 증거가 아니라서, 공백이 든
 * 경로에서 남의 프로필 Electron 을 소유로 만들 수 있다(리뷰 R3-01). 그래서 신호는 spawn pid 와 그
 * 자손뿐이고, 경로가 겹치는 생존 프로세스는 **죽이지 않고 `pathSurvivors` 로 보고**한다 —
 * 그 회차는 `clean:false`, 곧 C12 실패다(fail closed). 놓친 고아를 조용한 통과로 덮지 않는다.
 *
 * corral CLI 에는 종료 명령이 없고 제어 채널에도 `quit` 이 없다. 그래서 `corral open --json` 이
 * 돌려준 `runtime.pid`(우리가 띄운 데스크톱)를 끝낸다. dev 러너는 detached 라 프로세스 그룹째 끝낸다.
 * 응답이 실패해 그 pid 를 못 받았고 자손으로도 못 잇는다면, 그 고아는 `pathSurvivors` 에 남는다.
 */
async function shutdown({ orca, corral, owned, outDir }) {
  const closed = { at: new Date().toISOString(), owned: [], diagnostics: null }
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }
  const signal = (pid, group) => {
    try {
      process.kill(group ? -pid : pid, 'SIGTERM')
      return 'SIGTERM'
    } catch (error) {
      return String(error?.code ?? error)
    }
  }
  try {
    // 소켓을 먼저 닫는다 — 열린 WebSocket 이 이 프로세스의 이벤트 루프를 붙잡는다.
    await orca?.cdp?.close().catch(() => {})
    await corral?.cdp?.close().catch(() => {})

    // **신호 대상은 이번 실행이 spawn 한 pid 와 그 자손(PPID 사슬)뿐이다** (H1). 죽이기 전에 자손을
    // 먼저 적어 둔다 — 부모를 먼저 끝내면 부모 관계가 끊겨 손자를 더 못 찾는다. 계획은
    // `lib/own.mjs` 의 순수 함수(`planSignals`)가 정하고, 이 고리는 그 목록 **밖으로 신호하지 않는다**.
    const planned = planSignals({ owned: owned.pids, descendantsOf: (pid) => descendantPids(pid) })
    for (const entry of planned) {
      const record = { ...entry }
      if (entry.via === 'descendant') record.command = commandOf(entry.pid)
      record.sent = signal(entry.pid, entry.group)
      closed.owned.push(record)
    }
    closed.signalRule = 'spawn pid 와 그 자손(PPID 사슬)만 신호한다. 경로 일치로는 신호하지 않는다 (H1)'
    // 신호를 보낸 것과 죽은 것은 다르다. **소유 pid 하나하나**를 확인한다.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await pause(1000)
      const survivors = closed.owned.filter((entry) => alive(entry.pid))
      if (survivors.length === 0) break
      // 한 번 더 보내 본다(그룹 우두머리가 자식을 늦게 정리할 수 있다). 그래도 남으면 그대로 적는다.
      if (attempt === 5) for (const entry of survivors) entry.sentAgain = signal(entry.pid, entry.group)
    }
    for (const entry of closed.owned) entry.alive = alive(entry.pid)
    // **경로는 진단이다 — 죽이지 않는다** (H1, fail closed). 소유 경로를 명령줄에 가진 프로세스가
    // 신호 목록 밖에서 살아 있으면, 그것은 죽일 근거가 아니라 **정리가 끝나지 않았다는 보고 사유**다:
    // 평탄한 명령줄에서 argv 경계를 복원할 수 없어(공백 든 경로) 남의 프로필을 우리 것으로 만들 수
    // 있기 때문이다(리뷰 R3-01). corral CLI 처럼 pid 를 응답으로만 받는 경로에서 응답이 실패해
    // 자손을 PPID 로 못 찾는 경우가 정확히 여기로 떨어진다 — 조용한 `clean:true` 대신 목록이 남는다.
    const ownedPaths = [...new Set(owned.paths.filter(Boolean))]
    const signalledPids = closed.owned.map((entry) => entry.pid)
    // 목록은 **한 번** 받는다(경로마다 다시 받으면 회차 안에서 서로 다른 순간을 본다). 목록을 못 받으면
    // 그 자체가 진단 실패다 — 「남은 게 없다」가 아니다 (I1).
    const probe = probeProcesses()
    const diagnosis = pathDiagnosis({
      probe,
      targets: ownedPaths,
      exclude: owned.preexisting ?? [],
      signalled: signalledPids,
      selfPid: process.pid,
      alive
    })
    const pathSurvivors = diagnosis.survivors.map((entry) => ({
      pid: entry.pid,
      path: entry.path,
      command: entry.command.slice(0, 120),
      signalled: false,
      why: entry.why
    }))
    const rejected = diagnosis.rejected.map((entry) => ({ ...entry, command: entry.command.slice(0, 120) }))
    closed.pathProbe = {
      ok: probe.ok,
      error: probe.error,
      listed: probe.processes.length,
      candidates: diagnosis.candidates ?? 0,
      method: 'ps -axo pid=,command= 전체 목록 + 문자열 포함 (정규식 아님, I1)'
    }
    // 죽이지는 않되 **기다려는 준다** — 부모를 끝내면 헬퍼가 몇 초 뒤에 따라 죽는 일이 있다.
    // 기다림은 규칙을 무르게 하지 않는다: 끝까지 살아 있는 것만 미정리로 적는다.
    for (let attempt = 0; attempt < 8 && pathSurvivors.length > 0; attempt += 1) {
      if (pathSurvivors.every((entry) => !alive(entry.pid))) break
      await pause(1000)
    }
    closed.pathSurvivors = pathSurvivors.filter((entry) => alive(entry.pid))
    closed.pathSurvivorsGone = pathSurvivors.filter((entry) => !alive(entry.pid)).map((entry) => entry.pid)
    // **판단은 순수 함수가 한다** — 「확인하지 못한 것은 통과가 아니다」를 단위 테스트로 세울 수 있게.
    const verdict = cleanVerdict({
      signalled: closed.owned.map((entry) => ({ pid: entry.pid, alive: entry.alive })),
      diagnosis: { ...diagnosis, survivors: closed.pathSurvivors }
    })
    closed.clean = verdict.clean
    closed.survivorPids = verdict.survivorPids
    closed.uncleanWhy = verdict.why
    // **진단**: 넓은 이름 패턴으로 훑은 결과. 죽이지 않는다 — 소유 밖이라 이 실행의 몫이 아니다.
    const nameProbe = spawnSync('pgrep', ['-fl', 'orca-dev-userdata|corral-userdata|run-electron-vite-dev|herdr --session l443'], {
      encoding: 'utf8'
    })
    closed.diagnostics = {
      note: '넓은 이름 검색 결과다. 신호는 spawn pid·자손만 받는다 — 이 목록과 경로 후보는 진단이고 건드리지 않는다 (F1·G1·H1).',
      matches: nameProbe.stdout.trim().split('\n').filter(Boolean),
      ownedPaths,
      // **거른 후보와 이유**를 남긴다 — 「왜 이 pid 는 안 죽였나」를 원자료에서 되짚을 수 있게.
      rejectedCandidates: rejected,
      preexisting: owned.preexisting ?? []
    }
  } catch (error) {
    closed.error = String(error?.message ?? error)
    closed.clean = false
  }
  try {
    writeJson(path.join(outDir, 'shutdown.json'), closed)
  } catch {
    /* outDir 이 없으면 기록할 곳도 없다 */
  }
  return closed
}

// `finally` 의 정리 실패도 종료코드에 남는다 — `main()` 의 반환값이 그것을 덮지 않게 합친다.
const code = await main()
process.exitCode = process.exitCode === 1 ? 1 : code
