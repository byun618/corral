import { describe, expect, it } from 'vitest'
import { desktopEnv, desktopLaunch } from './desktop-launch.js'

describe('desktopLaunch (LIFE-555 A4)', () => {
  it('설치본 번들 안 CLI 면 같은 번들의 실행 파일을 띄우고 레포·node_modules 를 보지 않는다', () => {
    const launch = desktopLaunch({ cliFile: '/Applications/corral.app/Contents/Resources/app.asar.unpacked/out/runtime/cli.mjs', electronOverride: '/elsewhere/Electron', platform: 'darwin' })
    expect(launch).toEqual({ kind: 'packaged', executable: '/Applications/corral.app/Contents/MacOS/corral', args: [] })
  })
  it('번들이 어디에 있든(복사본·다른 볼륨) 그 번들을 띄운다', () => {
    const launch = desktopLaunch({ cliFile: '/Volumes/corral 0.1.0-arm64/corral.app/Contents/Resources/app.asar.unpacked/out/runtime/cli.mjs', electronOverride: undefined, platform: 'darwin' })
    expect(launch).toEqual({ kind: 'packaged', executable: '/Volumes/corral 0.1.0-arm64/corral.app/Contents/MacOS/corral', args: [] })
  })
  it('레포 빌드면 종전대로 레포 Electron + 앱 루트 인자, main 번들 존재를 따진다', () => {
    const launch = desktopLaunch({ cliFile: '/r/corral/app/out/runtime/cli.mjs', electronOverride: undefined, platform: 'darwin' })
    expect(launch).toEqual({ kind: 'dev', executable: '/r/corral/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', args: ['/r/corral/app'], mainEntry: '/r/corral/app/out/main/index.js' })
  })
  it('개발 경로에서는 CORRAL_ELECTRON 덮어쓰기를 듣는다(하네스 격리 경로)', () => {
    const launch = desktopLaunch({ cliFile: '/r/corral/app/out/runtime/cli.mjs', electronOverride: '/x/Electron', platform: 'darwin' })
    expect(launch.kind === 'dev' ? launch.executable : null).toBe('/x/Electron')
  })
})

describe('desktopEnv (LIFE-555 A5)', () => {
  it('세션 마커·Node 모드 표지를 지우고 userData 를 싣는다, 허용 목록 변수는 남긴다', () => {
    const env = desktopEnv({
      env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', CLAUDE_CODE_SSE_PORT: '1', ORCA_AGENT_HOOK_TOKEN: 't', ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: '/c', GROK_HOME: '/g', CLAUDE_CONFIG_DIR: '/cc', CORRAL_USER_DATA: '/old' },
      userData: '/u',
    })
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/c', GROK_HOME: '/g', CLAUDE_CONFIG_DIR: '/cc', CORRAL_USER_DATA: '/u' })
  })
})
