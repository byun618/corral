// 「Install CLI」·「Uninstall CLI」 (LIFE-556 B14) — 설치본 shim 을 `~/.local/bin/corral` 심링크 하나로 PATH 에 올린다.
//
// 규칙(00-analysis §4-8): 대상은 심링크 하나 · 셸 설정 파일은 고치지 않는다(PATH 에 없으면 한 줄 안내만) ·
// 사용자가 메뉴에서 실행할 때만 돈다. 이미 다른 `corral` 이 있으면 **확인 없이 바꾸지 않는다**,
// 지우기는 **이 번들 shim 을 가리킬 때만** 한다. 판단은 파일 시스템 사실 + 주입한 확인·셸 조회로 하고,
// 대화상자·메뉴는 `index.ts` 가 붙인다 — 분기는 임시 HOME 으로 단위 시험한다.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function cliTarget(home: string): string {
  return path.join(home, '.local', 'bin', 'corral')
}

/** 대상 자리에 지금 있는 것. `ours` — 이 번들 shim 으로 풀리는 심링크. */
export type CliSlot =
  | { kind: 'absent' }
  | { kind: 'ours'; link: string }
  | { kind: 'other-link'; link: string }
  | { kind: 'other-file' }
  | { kind: 'directory' }

function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file)
  } catch {
    return null
  }
}

export function inspectCliSlot(input: { target: string; shim: string }): CliSlot {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(input.target)
  } catch {
    return { kind: 'absent' }
  }
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(input.target)
    const pointed = path.resolve(path.dirname(input.target), link)
    const real = realpathOrNull(input.target)
    const shim = realpathOrNull(input.shim) ?? input.shim
    return pointed === input.shim || (real !== null && real === shim) ? { kind: 'ours', link } : { kind: 'other-link', link }
  }
  return stat.isDirectory() ? { kind: 'directory' } : { kind: 'other-file' }
}

/** 로그인 셸이 보는 PATH 와 `command -v corral`. 조회 실패는 null — 안내를 「모름」 으로 낸다. */
export type ShellView = { path: string[]; corral: string | null } | null

export type PathAdvice =
  | { kind: 'ok' }
  | { kind: 'not-on-path'; dir: string; line: string }
  | { kind: 'shadowed'; by: string }
  | { kind: 'unknown' }

export function pathAdvice(input: { target: string; view: ShellView }): PathAdvice {
  if (input.view === null) return { kind: 'unknown' }
  const dir = path.dirname(input.target)
  const onPath = input.view.path.some((entry) => entry.length > 0 && path.resolve(entry) === dir)
  // 한 줄 안내 — 홈 아래면 `$HOME` 으로 적는다. 셸 파일에는 쓰지 않는다.
  const home = os.homedir()
  const shown = dir.startsWith(home + path.sep) ? `$HOME/${path.relative(home, dir)}` : dir
  if (!onPath) return { kind: 'not-on-path', dir, line: `export PATH="${shown}:$PATH"` }
  if (input.view.corral !== null && path.resolve(input.view.corral) !== input.target) return { kind: 'shadowed', by: input.view.corral }
  return { kind: 'ok' }
}

export type InstallResult =
  | { kind: 'installed'; target: string; replaced: string | null; advice: PathAdvice }
  | { kind: 'already'; target: string; advice: PathAdvice }
  | { kind: 'declined'; target: string; current: string }
  | { kind: 'refused'; target: string; reason: string }

/** 지금 자리에 있는 것을 사람 말로 — 확인 대화상자와 거절 안내에 쓴다. */
export function describeSlot(slot: CliSlot): string {
  switch (slot.kind) {
    case 'absent':
      return '없음'
    case 'ours':
      return `이 앱을 가리키는 심링크 (→ ${slot.link})`
    case 'other-link':
      return `다른 곳을 가리키는 심링크 (→ ${slot.link})`
    case 'other-file':
      return '일반 파일'
    case 'directory':
      return '디렉터리'
  }
}

export async function installCli(input: {
  target: string
  shim: string
  /** 다른 `corral` 이 있을 때만 불린다. 참이어야 바꾼다. */
  confirmReplace: (current: string) => Promise<boolean>
  shellView: () => Promise<ShellView>
}): Promise<InstallResult> {
  const slot = inspectCliSlot(input)
  if (slot.kind === 'ours') return { kind: 'already', target: input.target, advice: pathAdvice({ target: input.target, view: await input.shellView() }) }
  if (slot.kind === 'directory') return { kind: 'refused', target: input.target, reason: '그 자리에 디렉터리가 있어 바꾸지 않는다' }
  let replaced: string | null = null
  if (slot.kind !== 'absent') {
    const current = describeSlot(slot)
    if (!(await input.confirmReplace(current))) return { kind: 'declined', target: input.target, current }
    replaced = current
  }
  fs.mkdirSync(path.dirname(input.target), { recursive: true })
  // 새 링크를 옆에 만들고 rename 으로 덮는다 — 바꾸는 도중 대상이 비는 순간이 없다.
  const temporary = `${input.target}.corral-install-${process.pid}`
  fs.rmSync(temporary, { force: true })
  fs.symlinkSync(input.shim, temporary)
  fs.renameSync(temporary, input.target)
  return { kind: 'installed', target: input.target, replaced, advice: pathAdvice({ target: input.target, view: await input.shellView() }) }
}

export type UninstallResult =
  | { kind: 'removed'; target: string }
  | { kind: 'absent'; target: string }
  | { kind: 'kept'; target: string; current: string }

export function uninstallCli(input: { target: string; shim: string }): UninstallResult {
  const slot = inspectCliSlot(input)
  if (slot.kind === 'absent') return { kind: 'absent', target: input.target }
  if (slot.kind !== 'ours') return { kind: 'kept', target: input.target, current: describeSlot(slot) }
  fs.unlinkSync(input.target)
  return { kind: 'removed', target: input.target }
}

const MARK = '__CORRAL_CLI__'

/** 새 로그인 셸이 보는 PATH 와 `command -v corral` — `server.ts` 의 herdr 조회와 같은 방식(구분자·10초). */
export async function loginShellView(): Promise<ShellView> {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  try {
    const { stdout } = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}%s${MARK}' "$PATH" "$(command -v corral)"`], {
      timeout: 10_000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    })
    return parseShellView(stdout)
  } catch {
    return null
  }
}

export function parseShellView(stdout: string): ShellView {
  const parts = stdout.split(MARK)
  // 앞 잡음 · PATH · corral · 뒤 잡음
  if (parts.length < 4) return null
  const corral = (parts[2] ?? '').trim()
  return { path: (parts[1] ?? '').split(':'), corral: corral.length > 0 ? corral : null }
}
