// `corral open` 이 무엇을 띄우나 (LIFE-555 A4·A5) — CLI 파일 위치로 설치본/개발 실행을 가른다.
//
// 설치본: shim(`Contents/Resources/bin/corral`)이 `Contents/Resources/app.asar.unpacked/cli/corral.mjs` 를 앱 자신의
// Electron 으로 돌린다 — 그 경로 안에 있으면 띄울 것은 같은 번들의 `Contents/MacOS/corral` 이고, 레포·`node_modules` 는 보지 않는다.
// 그 밖(레포 `out/runtime/cli.mjs`)은 종전대로 레포 Electron + 앱 루트 인자. `CORRAL_ELECTRON` 덮어쓰기는 개발 경로에서만 듣는다.

import path from 'node:path'
import { withoutSessionMarkers } from '../shared/session-markers.js'

/** 번들 안 CLI 의 위치 표지 — electron-builder `asarUnpack` 이 푸는 자리. */
const PACKAGED_MARKER = `${path.sep}Contents${path.sep}Resources${path.sep}app.asar.unpacked${path.sep}`

export type DesktopLaunch =
  | { kind: 'packaged'; executable: string; args: string[] }
  | { kind: 'dev'; executable: string; args: string[]; mainEntry: string }

export function desktopLaunch(input: { cliFile: string; electronOverride: string | undefined; platform: NodeJS.Platform }): DesktopLaunch {
  const at = input.cliFile.lastIndexOf(PACKAGED_MARKER)
  if (at !== -1) {
    const contents = input.cliFile.slice(0, at + `${path.sep}Contents`.length)
    return { kind: 'packaged', executable: path.join(contents, 'MacOS', 'corral'), args: [] }
  }
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
