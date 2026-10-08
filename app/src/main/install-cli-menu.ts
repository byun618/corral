// 「Install CLI」 진입점 (LIFE-556 B14) — 앱 메뉴(첫 메뉴, macOS 의 「corral」)에 두 항목을 더한다.
//
// corral 은 메뉴를 새로 만들지 않는다(index.ts `⌘W` 주석 — Edit role·`⌘Q` 를 우리가 책임지지 않으려고).
// 그래서 지금 살아 있는 기본 메뉴의 첫 메뉴에 항목만 끼워 넣고 같은 메뉴 객체를 다시 건다. 설치본에서만 붙는다 —
// 개발 실행에는 번들 shim 이 없다. 대화상자는 OS 기본(`dialog.showMessageBox`)이다.

import os from 'node:os'
import { dialog, Menu, MenuItem, type BrowserWindow } from 'electron'
import { log } from './log.js'
import { installCli, loginShellView, uninstallCli, type InstallResult, type PathAdvice, type UninstallResult } from './install-cli.js'

const home = os.homedir()
const tilde = (file: string): string => (file.startsWith(home + '/') ? `~${file.slice(home.length)}` : file)

function adviceText(advice: PathAdvice): string {
  switch (advice.kind) {
    case 'ok':
      return '새 터미널에서 corral 명령을 쓸 수 있습니다.'
    case 'not-on-path':
      return `${tilde(advice.dir)} 가 로그인 셸 PATH 에 없습니다. 셸 설정(~/.zshrc 등)에 다음 한 줄을 추가하세요 — corral 은 셸 파일을 고치지 않습니다.\n\n${advice.line}`
    case 'shadowed':
      return `PATH 앞쪽의 다른 corral 이 먼저 잡힙니다: ${tilde(advice.by)}\n그 파일을 지우거나 PATH 순서를 바꾸세요.`
    case 'unknown':
      return '로그인 셸의 PATH 를 확인하지 못했습니다. 새 터미널에서 command -v corral 로 확인하세요.'
  }
}

function installMessage(result: InstallResult, shim: string): { message: string; detail: string; type: 'info' | 'warning' } {
  switch (result.kind) {
    case 'installed':
      return {
        type: result.advice.kind === 'ok' ? 'info' : 'warning',
        message: 'corral 명령을 설치했습니다',
        detail: `${tilde(result.target)} → ${shim}${result.replaced === null ? '' : `\n바꾼 것: ${result.replaced}`}\n\n${adviceText(result.advice)}`,
      }
    case 'already':
      return { type: result.advice.kind === 'ok' ? 'info' : 'warning', message: '이미 설치돼 있습니다', detail: `${tilde(result.target)} → ${shim}\n\n${adviceText(result.advice)}` }
    case 'declined':
      return { type: 'info', message: '설치하지 않았습니다', detail: `${tilde(result.target)} 를 그대로 두었습니다 (${result.current})` }
    case 'refused':
      return { type: 'warning', message: '설치하지 않았습니다', detail: `${tilde(result.target)}: ${result.reason}` }
  }
}

function uninstallMessage(result: UninstallResult): { message: string; detail: string } {
  switch (result.kind) {
    case 'removed':
      return { message: 'corral 명령을 제거했습니다', detail: `${tilde(result.target)} 를 지웠습니다` }
    case 'absent':
      return { message: '설치돼 있지 않습니다', detail: `${tilde(result.target)} 가 없습니다` }
    case 'kept':
      return { message: '지우지 않았습니다', detail: `${tilde(result.target)} 는 이 앱이 설치한 것이 아닙니다 (${result.current})` }
  }
}

export function addInstallCliMenu(input: { shim: string; target: string; window: () => BrowserWindow | null }): void {
  const menu = Menu.getApplicationMenu()
  const first = menu?.items[0]?.submenu
  if (menu === null || first === undefined) {
    log('install_cli.menu_unavailable', {})
    return
  }
  const show = async (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> => {
    const parent = input.window()
    return parent === null || parent.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options)
  }
  const install = async (): Promise<void> => {
    const result = await installCli({
      target: input.target,
      shim: input.shim,
      confirmReplace: async (current) =>
        (
          await show({
            type: 'warning',
            message: `${tilde(input.target)} 가 이미 있습니다`,
            detail: `지금 있는 것: ${current}\n이 앱의 corral 명령으로 바꿀까요?`,
            buttons: ['바꾸기', '취소'],
            defaultId: 1,
            cancelId: 1,
          })
        ).response === 0,
      shellView: loginShellView,
    })
    log('install_cli.install', { result: result.kind, advice: 'advice' in result ? result.advice.kind : null })
    await show({ ...installMessage(result, input.shim), buttons: ['확인'] })
  }
  const uninstall = async (): Promise<void> => {
    const result = uninstallCli({ target: input.target, shim: input.shim })
    log('install_cli.uninstall', { result: result.kind })
    await show({ type: 'info', ...uninstallMessage(result), buttons: ['확인'] })
  }
  const failed = (what: string) => (error: unknown) => {
    log('install_cli.failed', { what, error: String(error) })
    void show({ type: 'error', message: `${what} 실패`, detail: String(error), buttons: ['확인'] })
  }
  // 「About」 과 그 뒤 구분선 다음 자리 — [About, ─, Install, Uninstall, ─, Services…]. 모양이 다르면 맨 앞에 둔다.
  const at = first.items[0]?.role === 'about' && first.items[1]?.type === 'separator' ? 2 : 0
  first.insert(at, new MenuItem({ type: 'separator' }))
  first.insert(at, new MenuItem({ id: 'corral-uninstall-cli', label: "Uninstall 'corral' Command…", click: () => void uninstall().catch(failed('Uninstall CLI')) }))
  first.insert(at, new MenuItem({ id: 'corral-install-cli', label: "Install 'corral' Command in PATH…", click: () => void install().catch(failed('Install CLI')) }))
  Menu.setApplicationMenu(menu)
  log('install_cli.menu_added', { target: tilde(input.target) })
}
