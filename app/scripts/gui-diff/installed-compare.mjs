#!/usr/bin/env node
// C3 — **설치본 Orca 와 개발 인스턴스의 외관 1회 대조.**
//
//   node app/scripts/gui-diff/installed-compare.mjs --phase installed   # 개발 인스턴스 기동 **전**
//   node app/scripts/gui-diff/installed-compare.mjs --phase dev          # 기동 **후**
//
// 왜 두 단계인가: macOS 는 가려진 창의 `screencapture -l <windowid>` 를 거절한다
// (실측: `could not create image from window`, 창 id 를 정확히 줘도). 그래서 설치본은 **우리 창을
// 띄우기 전에** 화면 좌표로 찍고, 개발본은 CDP 로 따로 찍어 두 장을 나란히 남긴다.
// 설치본을 앞으로 끌어내는 길(activate)은 사용자 포커스를 빼앗으므로 쓰지 않는다.
//
// 설치본은 **읽기 전용**으로만 본다: `screencapture` 로 화면을 뜨는 것이 전부다.
// 앱에 입력하지 않고, 재시작하지 않고, 설정도 건드리지 않는다 — 설치본(pid 682)은 이 하네스의
// 제어 런타임이다(00-analysis F15).
//
// **이 대조의 한계를 먼저 적는다**(C3 가 요구한다): 설치본 창에는 fixture 가 아니라 사용자의 실제
// 작업 상태가 떠 있다. 그러므로 이것은 **크롬·타이포·개발 표시 수준의 대조**이지 fixture 내용 비교가
// 아니다.
//
// 그 수준에서는 **픽셀을 실제로 겹친다** (H4): 상태와 무관하게 두 앱에 똑같이 떠 있는 왼쪽 정렬
// 크롬(검색 아이콘·「검색」 문구, 작업·자동화·Orca 모바일 행, Projects 라벨)을 같은 ROI 로 맞춰
// 비교하고 차이를 값으로 적는다. 배경 밴드만 보던 이전 판은 「배경색이 같다」까지밖에 말하지 못했다 —
// 글꼴·글자 위치·아이콘은 그 안에 없다(리뷰 R3-04). 오른쪽 정렬 요소와 본문은 폭·내용이 달라
// 여전히 비교 대상이 아니며, 그 목록을 `limits` 에 적는다.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, pickTarget } from './lib/cdp.mjs'
import { settlePage } from './lib/probe.mjs'
import { decodePng, encodePng, compareRoi, mutateColor, mutateShift, evaluateRoiControls } from './lib/png.mjs'
import { beginRun, finishRun } from './lib/runs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

const ROI = (value) => {
  const [x, y, w, h] = String(value).split(',').map(Number)
  return { x, y, w, h }
}

function parseArgs(argv) {
  const out = {
    out: null,
    crop: '0,30,470,1410',
    port: 9444,
    area: 'sidebar',
    work: process.env.L443_WORK ?? '/tmp/l443',
    phase: 'both',
    tag: null,
    ledger: null,
    // ---- 대조 모드 (G9): 앱을 건드리지 않고 **이미 찍어 둔 캡처의 사본**으로만 돈다 ----
    control: false,
    installedPng: null,
    devPng: null,
    // 두 캡처에서 **균일한 사이드바 배경 밴드**. 크롭 원점이 달라 좌표가 다르다(설치본은 창 y+30 부터).
    roiInstalled: { x: 4, y: 48, w: 40, h: 8 },
    roiDev: { x: 4, y: 40, w: 40, h: 8 },
    // 구조(글자·테두리)가 있는 ROI — 기하 변화 민감도는 여기서만 볼 수 있다.
    roiStructure: { x: 8, y: 8, w: 264, h: 32 },
    // **공통 크롬 ROI** (H4). 두 앱에 똑같이 떠 있는 **왼쪽 정렬** 크롬: 검색 아이콘·「검색」 문구,
    // 작업·자동화·Orca 모바일 행의 아이콘+문구, Projects 라벨. 좌표는 **개발본 기준**이고
    // 설치본 쪽은 `--align-scan` 이 찾은 정수 y 이동 하나를 그대로 더해 쓴다.
    // 오른쪽 정렬 요소(신규 배지·헤더 아이콘)는 사이드바 폭이 달라 자리가 다르므로 **뺀다**.
    roiChrome: { x: 4, y: 8, w: 186, h: 128 },
    alignScan: 12
  }
  for (let i = 0; i < argv.length; i += 1) {
    const value = () => argv[++i]
    if (argv[i] === '--out') out.out = path.resolve(value())
    else if (argv[i] === '--crop') out.crop = value()
    else if (argv[i] === '--port') out.port = Number(value())
    else if (argv[i] === '--area') out.area = value()
    else if (argv[i] === '--work') out.work = path.resolve(value())
    else if (argv[i] === '--phase') out.phase = value()
    else if (argv[i] === '--tag') out.tag = value()
    else if (argv[i] === '--screenshot') out.screenshot = path.resolve(value())
    else if (argv[i] === '--control') out.control = true
    else if (argv[i] === '--ledger') out.ledger = path.resolve(value())
    else if (argv[i] === '--installed') out.installedPng = path.resolve(value())
    else if (argv[i] === '--dev') out.devPng = path.resolve(value())
    else if (argv[i] === '--roi-installed') out.roiInstalled = ROI(value())
    else if (argv[i] === '--roi-dev') out.roiDev = ROI(value())
    else if (argv[i] === '--roi-structure') out.roiStructure = ROI(value())
    else if (argv[i] === '--roi-chrome') out.roiChrome = ROI(value())
    else if (argv[i] === '--align-scan') out.alignScan = Number(value())
    else throw new Error(`알 수 없는 인자: ${argv[i]}`)
  }
  out.out ??= path.join(repoRoot, 'specs/LIFE-443-gui-diff/raw/claude/c3')
  return out
}

/**
 * 창 목록을 읽는 작은 helper 를 필요할 때 컴파일해서 쓴다.
 *
 * 왜 창 id 가 필요한가: `screencapture -R <사각형>` 은 **그 화면 좌표에 보이는 것**을 찍는다.
 * 개발 인스턴스가 설치본을 덮고 있으면 설치본 대신 개발 창이 찍힌다 (첫 시도에서 실제로 그랬다).
 * `screencapture -l <windowid>` 는 가려져 있어도 그 창만 찍는다 — 설치본을 **건드리지 않고** 보는
 * 유일한 길이다. 창 소유자 이름으로 설치본('Orca')과 개발본('Orca Dev')이 갈린다.
 *
 * osascript/System Events 로 가지 않는 이유: 손쉬움 접근 권한 프롬프트가 뜨면 사람 손이 필요해진다.
 */
function windowLister(workDir) {
  const binary = path.join(workDir, 'l443-listwin')
  if (fs.existsSync(binary)) return binary
  const source = path.join(workDir, 'l443-listwin.swift')
  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(
    source,
    [
      'import CoreGraphics',
      'import Foundation',
      'guard let list = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { exit(1) }',
      'var out: [[String: Any]] = []',
      'for w in list {',
      '  out.append([',
      '    "owner": w[kCGWindowOwnerName as String] as? String ?? "",',
      '    "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,',
      '    "id": w[kCGWindowNumber as String] as? Int ?? 0,',
      '    "name": w[kCGWindowName as String] as? String ?? "",',
      '    "bounds": w[kCGWindowBounds as String] as? [String: Any] ?? [:],',
      '    "layer": w[kCGWindowLayer as String] as? Int ?? 0',
      '  ])',
      '}',
      'FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))',
      ''
    ].join('\n')
  )
  const built = spawnSync('swiftc', ['-O', '-o', binary, source], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`[c3] swiftc 실패 — ${built.stderr?.slice(0, 200)}`)
  return binary
}

function listWindows(workDir) {
  const listed = spawnSync(windowLister(workDir), [], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (listed.status !== 0) throw new Error(`[c3] 창 목록 실패 — ${listed.stderr?.slice(0, 200)}`)
  return JSON.parse(listed.stdout)
}

function findInstalledOrcaWindow(workDir) {
  const windows = listWindows(workDir)
  // 설치본은 소유자 'Orca', 개발본은 'Orca Dev'. 본 창은 이름이 있고 레이어 0 이며 가장 크다.
  const candidates = windows.filter(
    (w) => w.owner === 'Orca' && w.layer === 0 && w.name && (w.bounds.Width ?? 0) > 400 && (w.bounds.Height ?? 0) > 400
  )
  if (candidates.length === 0) throw new Error('[c3] 설치본 Orca 창을 못 찾았다 (소유자 이름 "Orca", 레이어 0)')
  candidates.sort((a, b) => b.bounds.Width * b.bounds.Height - a.bounds.Width * a.bounds.Height)
  return candidates[0]
}

const args = parseArgs(process.argv.slice(2))
fs.mkdirSync(args.out, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// ---- 대조 모드 (G9): 비교 방법의 **판별력**을 먼저 보인다 -------------------
//
// 왜 필요한가: 이전 판의 C3 는 두 캡처를 남기고 「사람이 보기에 차이를 못 찾았다」로 끝났다.
// 그것은 *차이가 없다* 와 *이 방법으로는 못 본다* 를 가르지 못한다(리뷰 F13·G9). 그래서
// **원본은 그대로 두고 사본**에 알려진 크기의 변화를 심어, 같은 비교 함수로
// 원본↔원본(음성 0)·원본↔사본(양성 검출)을 돌리고 **검출 하한**을 값으로 낸다.
// 설치본에는 입력도 재시작도 하지 않는다 — 이미 찍어 둔 PNG 파일만 읽는다.
if (args.control) {
  if (!args.installedPng || !args.devPng) throw new Error('--control 에는 --installed <png> --dev <png> 가 필요하다')
  // 실행 한 번 = 원장 한 행. **도구가 스스로 적는다** — 사람이 옮겨 적으면 빠진다.
  const command = `node app/scripts/gui-diff/installed-compare.mjs ${process.argv.slice(2).join(' ')}`
  const controlRunId = args.ledger ? beginRun(args.ledger, { criterion: 'C3 (외관 대조 방법의 양성·음성 대조)', command, raw: path.relative(repoRoot, args.out) }) : null
  const installedImage = decodePng(fs.readFileSync(args.installedPng))
  const devImage = decodePng(fs.readFileSync(args.devPng))

  // ① 방법 민감도: 배경 밴드(색)와 구조 ROI(기하)에서 각각 음성·양성 대조
  const background = evaluateRoiControls(devImage, args.roiDev)
  const structure = evaluateRoiControls(devImage, args.roiStructure)
  // ② 실제 대조: 설치본 ↔ 개발본, 같은 크기의 배경 밴드.
  const actual = compareRoi(installedImage, devImage, args.roiInstalled, args.roiDev)

  // ③ **공통 크롬·타이포 실대조** (H4). 배경 밴드는 「배경색이 같다」만 말한다 — 글꼴·글자 위치·
  // 아이콘·개발 표시는 거기 없다. 그래서 두 앱에 똑같이 떠 있는 **왼쪽 정렬 크롬**을 같은 ROI 로
  // 맞춰 실제로 비교한다.
  //
  // 정렬은 **정수 y 이동 하나**다. 두 캡처의 크롭 원점이 다르므로(설치본은 창 y+30) 어긋남을
  // 먼저 값으로 찾고, 그 스캔 표를 통째로 남긴다 — 행마다 따로 맞추는 fitting 이 아니고,
  // 스캔 자체가 **양성 대조**다: 1px 만 어긋나도 차이가 수천 픽셀로 나온다는 것을 같은 표가 보인다.
  const chromeScan = []
  for (let dy = 0; dy <= args.alignScan; dy += 1) {
    const roi = { ...args.roiChrome, y: args.roiChrome.y + dy }
    if (roi.y + roi.h > installedImage.height) break
    chromeScan.push({ dy, ...compareRoi(installedImage, devImage, roi, args.roiChrome) })
  }
  const bestAlign = chromeScan.reduce((best, entry) => {
    if (!best) return entry
    if (entry.differing !== best.differing) return entry.differing < best.differing ? entry : best
    return entry.meanDelta < best.meanDelta ? entry : best
  }, null)
  const roiChromeInstalled = { ...args.roiChrome, y: args.roiChrome.y + (bestAlign?.dy ?? 0) }
  const chromeActual = compareRoi(installedImage, devImage, roiChromeInstalled, args.roiChrome)
  // 같은 정렬로 **사이드바 폭 전체**(오른쪽 정렬 요소가 들어오는 구간)도 재 둔다. 여기 나오는 차이는
  // 「비교하지 않았다」가 아니라 **값으로 적은 차이**다 — 폭이 460↔280 이라 오른쪽 요소의 자리가 다르다.
  const widerRoi = { x: 0, y: args.roiChrome.y, w: Math.min(installedImage.width, devImage.width), h: args.roiChrome.h }
  const chromeWider = compareRoi(installedImage, devImage, { ...widerRoi, y: widerRoi.y + (bestAlign?.dy ?? 0) }, widerRoi)
  // 크롬 ROI 에서도 음성·양성 대조를 돌린다 — 「0 이 나왔다」가 빈 검사가 아님을 같은 영역에서 보인다.
  const chromeControls = evaluateRoiControls(devImage, args.roiChrome)
  // 어떤 줄에서 차이가 났는지 사람이 볼 수 있게 행 단위로도 쪼갠다.
  const chromeRows = []
  for (let y = args.roiChrome.y; y < args.roiChrome.y + args.roiChrome.h; y += 16) {
    const h = Math.min(16, args.roiChrome.y + args.roiChrome.h - y)
    const roi = { x: args.roiChrome.x, y, w: args.roiChrome.w, h }
    chromeRows.push({ y, h, ...compareRoi(installedImage, devImage, { ...roi, y: y + (bestAlign?.dy ?? 0) }, roi) })
  }

  // 양성 대조에 쓴 사본을 **사람이 볼 수 있게** 남긴다 — 원자료 없이는 주장일 뿐이다.
  const mutants = []
  for (const [name, image] of [
    [`color+4`, mutateColor(devImage, args.roiDev, 4)],
    [`shift+2`, mutateShift(devImage, args.roiStructure, 2)],
    [`chrome-color+1`, mutateColor(devImage, args.roiChrome, 1)],
    [`chrome-shift+1`, mutateShift(devImage, args.roiChrome, 1)]
  ]) {
    const file = path.join(args.out, `${stamp}-c3-control-${name}.png`)
    fs.writeFileSync(file, encodePng(image))
    mutants.push({ name, file: path.relative(repoRoot, file) })
  }

  const detectorOk =
    background.negativeOk &&
    structure.negativeOk &&
    background.minColorDelta === 1 &&
    structure.minShift !== null &&
    // 크롬 ROI 의 판별력도 같이 본다 — 이 영역의 대조가 C3 의 본체이기 때문이다 (H4).
    chromeControls.negativeOk &&
    chromeControls.minColorDelta === 1 &&
    chromeControls.minShift !== null &&
    // 정렬 스캔이 **하나의 최소점**을 보여야 한다. 어디를 맞춰도 같으면 그 대조는 아무것도 안 본 것이다.
    chromeScan.length > 2 &&
    chromeScan.some((entry) => entry.differing > chromeActual.differing)
  const result = {
    stamp,
    mode: 'control',
    method:
      '공통 크롬 ROI(검색 줄·행 아이콘/문구·Projects 라벨)와 배경 밴드를 같은 좌표로 맞춰 비교한다. 값은 ROI 의 RGB 채널 최대·평균 차이. 알파는 보지 않는다 — screencapture 는 RGBA, CDP 는 RGB 로 주므로 알파를 넣으면 채널 수 차이가 곧 차이가 된다',
    inputs: {
      installed: path.relative(repoRoot, args.installedPng),
      dev: path.relative(repoRoot, args.devPng),
      installedSize: { w: installedImage.width, h: installedImage.height, channels: installedImage.channels },
      devSize: { w: devImage.width, h: devImage.height, channels: devImage.channels },
      roiInstalled: args.roiInstalled,
      roiDev: args.roiDev,
      roiStructure: args.roiStructure
    },
    controls: { background, structure, chrome: chromeControls },
    mutants,
    actual,
    // **C3 가 요구한 「같은 영역을 두 쪽에서 캡처해 차이를 기록」의 본체**가 이 칸이다 (H4).
    chrome: {
      what: '두 앱에 공통으로 떠 있는 왼쪽 정렬 크롬 — 검색 아이콘·「검색」 문구, 작업·자동화·Orca 모바일 행의 아이콘+문구, Projects 라벨',
      roiDev: args.roiChrome,
      roiInstalled: roiChromeInstalled,
      alignment: {
        dy: bestAlign?.dy ?? null,
        how: '정수 y 이동 하나를 ROI 전체에 적용. 행마다 따로 맞추지 않는다',
        scan: chromeScan
      },
      actual: chromeActual,
      rows: chromeRows,
      wider: {
        what: '같은 정렬로 폭 전체(오른쪽 정렬 요소 포함)를 잰 값. 통과 근거가 아니라 **차이의 기록**이다 — 사이드바 폭이 설치본 460px / 개발본 280px 라 「신규」 배지·Projects 헤더 아이콘의 자리가 다르다',
        roiDev: widerRoi,
        result: chromeWider
      }
    },
    detector: {
      ok: detectorOk,
      minColorDelta: background.minColorDelta,
      minShift: structure.minShift,
      minChromeColorDelta: chromeControls.minColorDelta,
      minChromeShift: chromeControls.minShift,
      why: detectorOk
        ? '음성 대조 0 · 색 Δ1 검출 · 구조/크롬 ROI 에서 1px 이동 검출 · 정렬 스캔에 최소점이 하나 — 이 방법은 이 크기부터 본다'
        : '판별력을 못 보였다 — 이 방법으로 낸 「차이 없음」은 근거가 아니다'
    },
    limits: [
      '이 대조는 **선언한 ROI 안**만 본다. 그 밖은 비교하지 않았다 — 전체 동일성 증명이 아니다',
      '균일한 배경 ROI 에서는 **이동을 검출하지 못한다**(구조가 없으면 밀어도 픽셀이 그대로다). 그래서 기하 민감도는 구조·크롬 ROI 에서만 말한다',
      '설치본 창에는 fixture 가 아니라 사용자의 실제 작업 상태가 떠 있다. 그래서 두 캡처의 **내용**(프로젝트·에이전트 행)은 겹칠 수 없다. 겹치는 것은 상태와 무관한 **왼쪽 정렬 크롬**이고 그것이 `chrome` 칸이다',
      '두 캡처의 크롭 원점이 다르다 — 크롬 ROI 는 정수 y 이동 하나(`chrome.alignment.dy`)로 맞추고 스캔 표를 남긴다. 배경 밴드 ROI 는 이 스캔 전에 눈으로 고른 좌표(y48/y40)라 균일한 색만 보는 값이다',
      '**비교하지 않은 것**: 오른쪽 정렬 요소(「신규」 배지·Projects 헤더 아이콘) — 사이드바 폭이 설치본 460px / 개발본 280px 로 달라 같은 ROI 로 맞출 수 없다. 사용자 창이라 폭을 맞추려면 설치본에 입력해야 하고, 설치본은 읽기 전용이다',
      '**비교하지 않은 것**: 크롬 아래 본문(프로젝트 목록·에이전트 행). 두 창의 내용이 다르다',
      '**개발 표시**는 이 픽셀 안에 없다 — 개발본은 창 소유자 이름이 `Orca Dev`(설치본은 `Orca`)로 갈린다. 그 차이는 창 목록 원자료에 있고 사이드바 픽셀에는 나타나지 않는다',
      '두 캡처가 **같은 래스터 배율**이라는 것은 가정이 아니라 결과다 — 같은 글자·아이콘이 픽셀 단위로 겹친다. 화면 배율(DPR) 값 자체는 이 도구가 읽지 않았다'
    ]
  }
  const jsonPath = path.join(args.out, `${stamp}-c3-control.json`)
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
  if (args.ledger && controlRunId) {
    finishRun(args.ledger, controlRunId, {
      criterion: 'C3 (외관 대조 방법의 양성·음성 대조)',
      command,
      actualExit: detectorOk ? 0 : 1,
      raw: path.relative(repoRoot, jsonPath),
      result: detectorOk
        ? `통과 — 음성 0 · 색 Δ${background.minColorDelta} 검출 · 구조 ROI 이동 ${structure.minShift}px 검출 · 크롬 ROI 이동 ${chromeControls.minShift}px 검출 · 공통 크롬 실대조(${chromeActual.pixels}px, dy=${bestAlign?.dy}) maxDelta ${chromeActual.maxDelta} 차이 ${chromeActual.differing}px · 배경 밴드 maxDelta ${actual.maxDelta}`
        : '실패 — 방법의 판별력을 못 보였다'
    })
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`[l443] ${path.relative(repoRoot, jsonPath)}\n`)
  // **판별력을 못 보이면 실패다.** 실제 대조 수치 자체는 관문이 아니다 — 차이가 있으면 기록한다.
  process.exit(detectorOk ? 0 : 1)
}

// ---- 설치본: 화면 캡처(읽기 전용) -------------------------------------------
let installed = { skipped: 'phase=dev' }
if (args.phase === 'installed' || args.phase === 'both') {
  installed = {}
  try {
    const target = findInstalledOrcaWindow(args.work)
    if (args.screenshot) {
      // 설치본이 **다른 Space** 에 있어 화면에도 없고 `-l` 도 거절당하는 경우의 길.
      // 미리 떠 둔 읽기 전용 전체 화면 캡처에서 영역만 잘라 쓴다. 언제 찍은 것인지 함께 남긴다 —
      // 개발 인스턴스 기동 **전**에 찍은 것이어야 의미가 있다.
      const [cx, cy, cw, ch] = args.crop.split(',').map(Number)
      // 크롭이 **그 창 안**인지 검증한다 (L7). 이전 판은 고정 상수로 자르고 `window.bounds` 는
      // 나란히 적기만 했다 — 두 값을 잇는 검사가 없어 바탕화면을 찍은 회차가 「통과(명령)」로 남았다.
      const bounds = target.bounds ?? {}
      const inside =
        cx >= (bounds.X ?? 0) &&
        cy >= (bounds.Y ?? 0) &&
        cx + cw <= (bounds.X ?? 0) + (bounds.Width ?? 0) &&
        cy + ch <= (bounds.Y ?? 0) + (bounds.Height ?? 0)
      if (!inside) {
        throw new Error(
          `크롭 ${args.crop} 이 설치본 창 영역 밖이다 (창 ${JSON.stringify(bounds)}) — 엉뚱한 그림을 남기지 않는다`
        )
      }
      const cropPath = path.join(args.out, `${stamp}-installed-${args.area}.png`)
      fs.copyFileSync(args.screenshot, cropPath)
      const cropped = spawnSync('sips', ['-c', String(ch), String(cw), '--cropOffset', String(cy), String(cx), cropPath], { encoding: 'utf8' })
      if (cropped.status !== 0) throw new Error(`sips crop → ${cropped.status} ${cropped.stderr?.trim()}`)
      installed = {
        window: { id: target.id, pid: target.pid, owner: target.owner, name: target.name, bounds: target.bounds },
        source: { screenshot: args.screenshot, takenAt: fs.statSync(args.screenshot).mtime.toISOString(), note: '개발 인스턴스 기동 전에 찍은 읽기 전용 전체 화면 캡처' },
        command: `sips -c ${ch} ${cw} --cropOffset ${cy} ${cx} <복사본>`,
        file: path.relative(repoRoot, cropPath),
        bytes: fs.statSync(cropPath).size,
        readOnly: '앱에 입력·재시작·설정 변경 없음 — 화면만 읽었다'
      }
      throw { handled: true }
    }
    const ours = listWindows(args.work).filter(
      (w) => (w.owner === 'Orca Dev' || w.name === 'corral') && w.layer === 0 && (w.bounds.Width ?? 0) > 400
    )
    // 우리 창이 하나라도 떠 있으면 화면 좌표 캡처는 그 창을 찍을 수 있다 — 조용히 틀린 그림을
    // 남기느니 거절한다 (첫 시도에서 실제로 개발 창이 찍혔다).
    if (ours.length > 0) {
      throw new Error(
        `측정 인스턴스 창이 떠 있다(${ours.map((w) => w.owner || w.name).join(', ')}) — ` +
          '설치본 캡처는 기동 **전에** `--phase installed` 로 먼저 돌려야 한다'
      )
    }
    const b = target.bounds
    const [cx, cy, cw, ch] = args.crop.split(',').map(Number)
    const rect = [Math.round(b.X + cx), Math.round(b.Y + cy), Math.min(cw, Math.round(b.Width)), Math.min(ch, Math.round(b.Height))]
    const cropPath = path.join(args.out, `${stamp}-installed-${args.area}.png`)
    // `-R` 로 영역만 찍는다: 전체 화면에는 이 일감과 무관한 사용자 화면이 들어간다 (원자료 규칙).
    // `-l <windowid>` 는 macOS 가 가려진 창에 대해 거절한다(실측) — 그래서 기동 전 좌표 캡처다.
    const shot = spawnSync('screencapture', ['-x', '-R', rect.join(','), '-t', 'png', cropPath], { encoding: 'utf8' })
    if (shot.status !== 0) throw new Error(`screencapture → ${shot.status} ${shot.stderr?.trim()}`)
    installed = {
      window: { id: target.id, pid: target.pid, owner: target.owner, name: target.name, bounds: b },
      command: `screencapture -x -R ${rect.join(',')} -t png <out>`,
      file: path.relative(repoRoot, cropPath),
      bytes: fs.statSync(cropPath).size,
      readOnly: '앱에 입력·재시작·설정 변경 없음 — 화면만 읽었다'
    }
  } catch (error) {
    if (!error?.handled) installed = { error: String(error?.message ?? error) }
  }
  // 설치본이 그대로인지(우리가 건드리지 않았는지) 같은 시점의 status 로 남긴다.
  const status = spawnSync('orca', ['status', '--json'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(args.out, `${stamp}-installed-status.json`), status.stdout || `{"error":${JSON.stringify(status.stderr)}}`)
}

// ---- 개발 인스턴스: 같은 영역을 CDP 로 -------------------------------------
const area = JSON.parse(fs.readFileSync(path.join(here, 'areas', `${args.area}.json`), 'utf8'))
let dev = { skipped: 'phase=installed' }
if (args.phase === 'dev' || args.phase === 'both') {
 dev = {}
 try {
  const { target } = await pickTarget(args.port, {
    label: 'orca-dev',
    match: (entry) => !entry.url.includes('popout') && !entry.url.includes('devtools')
  })
  const cdp = await connect(target.webSocketDebuggerUrl)
  await settlePage(cdp)
  const rect = await cdp.evaluate((selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }, area.root.orca)
  if (!rect) throw new Error(`dev 인스턴스에서 영역 루트를 못 찾았다: ${area.root.orca}`)
  const png = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } })
  const devPath = path.join(args.out, `${stamp}-dev-${args.area}.png`)
  fs.writeFileSync(devPath, Buffer.from(png.data, 'base64'))
  const info = await cdp.evaluate(() => ({
    userAgent: navigator.userAgent,
    href: location.href,
    devStyleTags: document.querySelectorAll('[data-vite-dev-id]').length,
    devOverlays: document.querySelectorAll('vite-error-overlay, #vite-error-overlay').length,
    fontFamily: getComputedStyle(document.body).fontFamily,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    dpr: window.devicePixelRatio
  }))
  dev = { file: path.relative(repoRoot, devPath), rect, info }
  await cdp.close()
 } catch (error) {
  dev = { error: String(error?.message ?? error) }
 }
}

const result = { stamp, phase: args.phase, area: args.area, installed, dev, limitation: '설치본 창에는 fixture 가 아니라 사용자의 실제 작업 상태가 떠 있다 — 이 대조는 크롬·타이포·개발 표시 수준이지 fixture 내용 비교가 아니다 (C3)' }
const jsonPath = path.join(args.out, `${stamp}-${args.tag ?? args.phase}-compare.json`)
fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
process.exitCode = installed.error || dev.error ? 1 : 0
