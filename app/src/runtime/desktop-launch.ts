// `corral open` 이 무엇을 띄우나 (LIFE-555 A4·A5) — CLI 파일 위치로 설치본/개발 실행을 가른다.
//
// 설치본: shim(`Contents/Resources/bin/corral`)이 `Contents/Resources/app.asar.unpacked/cli/corral.mjs` 를 앱 자신의
// Electron 으로 돌린다 — 그 경로 안에 있으면 띄울 것은 같은 번들의 `Contents/MacOS/corral` 이고, 레포·`node_modules` 는 보지 않는다.
// 그 밖(레포 `out/runtime/cli.mjs`)은 종전대로 레포 Electron + 앱 루트 인자. `CORRAL_ELECTRON` 덮어쓰기는 개발 경로에서만 듣는다.

import path from 'node:path'
import { withoutSessionMarkers } from '../shared/session-markers.js'

/**
 * 설치본 표지 — 이 코드가 번들의 `Contents/Resources/app.asar(.unpacked)/` 안에 있나.
 * CLI(shim 이 부르는 `app.asar.unpacked/cli` · `out/runtime`)와 앱 main(`app.asar/out/main`) 둘 다 이 표지로 번들 `Contents` 를 안다.
 */
const PACKAGED_MARKERS = ['app.asar', 'app.asar.unpacked'].map(name => `${path.sep}Contents${path.sep}Resources${path.sep}${name}${path.sep}`)

/** 설치본이면 번들의 `Contents` 경로, 아니면 null. */
export function packagedContents(file: string): string | null {
  for (const marker of PACKAGED_MARKERS) {
    const at = file.lastIndexOf(marker)
    if (at !== -1) return file.slice(0, at + `${path.sep}Contents`.length)
  }
  return null
}

export type DesktopLaunch =
  | { kind: 'packaged'; executable: string; args: string[] }
  | { kind: 'dev'; executable: string; args: string[]; mainEntry: string }

export function desktopLaunch(input: { cliFile: string; electronOverride: string | undefined; platform: NodeJS.Platform }): DesktopLaunch {
  const contents = packagedContents(input.cliFile)
  if (contents !== null) return { kind: 'packaged', executable: path.join(contents, 'MacOS', 'corral'), args: [] }
  // 레포 번들은 `app/out/runtime/cli.mjs` — 두 단계 위가 앱 루트다.
  const root = path.resolve(path.dirname(input.cliFile), '../..')
  const executable = input.electronOverride ?? path.join(root, 'node_modules/electron', input.platform === 'darwin' ? 'dist/Electron.app/Contents/MacOS/Electron' : 'dist/electron')
  return { kind: 'dev', executable, args: [root], mainEntry: path.join(root, 'out/main/index.js') }
}

/** 앱에 넘기는 env — 세션 마커를 지우고(허용 목록 변수는 남는다) Node 모드 표지를 뗀다. */
export function desktopEnv(input: { env: NodeJS.ProcessEnv; userData: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...withoutSessionMarkers(input.env), CORRAL_USER_DATA: input.userData }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * 워커 pane 이 corral 을 부를 모양 (LIFE-555 fix1 M1) — 워커 프리앰블·`ask --resume` 명령이 쓴다.
 * 설치본에서는 shim 절대경로다: 앱 Electron + CLI 파일을 그대로 박으면 `ELECTRON_RUN_AS_NODE` 가 없는 워커 셸에서 GUI 가 한 번 더 뜬다.
 * `CORRAL_CLI` 덮어쓰기와 개발 경로(레포 `corral.mjs` 를 node 로 부른 실행 — 그 node + 그 파일, 아니면 PATH 의 `corral`)는 종전대로다.
 */
export type CliInvocation =
  | { kind: 'override'; command: string }
  | { kind: 'argv'; argv: string[] }
  | { kind: 'path' }

export function cliInvocation(input: { override: string | undefined; moduleFile: string; entry: string | undefined; execPath: string }): CliInvocation {
  if (input.override !== undefined) return { kind: 'override', command: input.override }
  const contents = packagedContents(input.moduleFile)
  if (contents !== null) return { kind: 'argv', argv: [path.join(contents, 'Resources', 'bin', 'corral')] }
  if (input.entry !== undefined && input.entry.endsWith('corral.mjs')) return { kind: 'argv', argv: [input.execPath, input.entry] }
  return { kind: 'path' }
}
