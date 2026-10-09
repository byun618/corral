// 맥 이름 (LIFE-577 R5 A5ⓓ) — 인증 뒤 `hello`·`paired` 응답의 `server.macName`(표시용). electron 을 모른다.
//
// 출처 순서:
//   ① macOS 컴퓨터 이름 — `/usr/sbin/scutil --get ComputerName`(시스템 설정 › 일반 › 정보의 「이름」). **절대경로**로 불러
//      Finder 로 띄운 GUI 앱(셸 PATH 없음)에서도 같다. 2초 타임아웃.
//   ② 실패·빈 값이면 `os.hostname()` 에서 `.local` 을 뗀 값.
//   ③ 그것도 비면 「Mac」.
// 제어 문자를 빼고 64자로 자른다. 비밀이 아니다(tailnet 의 기기 목록에도 보이는 이름) — 그래도 인증 전 응답에는 싣지 않는다.
import { execFile } from 'node:child_process'
import os from 'node:os'

export const SCUTIL = '/usr/sbin/scutil'
export const MAC_NAME_FALLBACK = 'Mac'
const MAC_NAME_MAX = 64
const SCUTIL_TIMEOUT_MS = 2_000

function clean(raw: string): string {
  return [...raw].filter((char) => { const code = char.codePointAt(0) ?? 0; return code >= 0x20 && code !== 0x7f }).join('').trim().slice(0, MAC_NAME_MAX)
}

export function fallbackMacName(hostname: string = os.hostname()): string {
  const name = clean(hostname.replace(/\.local\.?$/i, ''))
  return name.length > 0 ? name : MAC_NAME_FALLBACK
}

function scutilComputerName(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(SCUTIL, ['--get', 'ComputerName'], { timeout: SCUTIL_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout))
  })
}

export async function readMacName(input: { exec?: () => Promise<string | null>; hostname?: () => string } = {}): Promise<string> {
  const raw = await (input.exec ?? scutilComputerName)()
  const name = raw === null ? '' : clean(raw)
  return name.length > 0 ? name : fallbackMacName((input.hostname ?? os.hostname)())
}
