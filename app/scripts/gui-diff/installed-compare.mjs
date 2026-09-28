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
// 아니다. 두 캡처에서 같은 요소의 픽셀을 겹쳐 보는 것이 아니라, "개발 빌드라서 눈에 띄게 달라진
// 것이 있는가" 를 사람이 확인할 재료를 남긴다.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, pickTarget } from './lib/cdp.mjs'
import { settlePage } from './lib/probe.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

function parseArgs(argv) {
  const out = { out: null, crop: '0,30,470,1410', port: 9444, area: 'sidebar', work: process.env.L443_WORK ?? '/tmp/l443', phase: 'both', tag: null }
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
