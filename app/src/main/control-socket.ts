// 계측 소켓 권한 (LIFE-577 fix1 R1-A6) — electron 을 모른다(vitest 로 실제 bind).
//
// 계측 소켓은 원래 아무 권한도 강제하지 않았다(umask 따라 0755·0777). 페어링 코드처럼 **비밀을 주는 명령**은
// 아래 둘이 모두 참일 때만 허용한다:
//   ① 소켓 폴더가 이 사용자 소유 · 심링크 아님 · group/other 비트 없음(0700) — `runtime/storage.ts` `privateDirectory` 와 같은 조건
//   ② 소켓 파일이 0600 — 생성 시 umask 077 아래에서 bind 하고 바로 chmod(`runtime/transport.ts` `serveSocket` 과 같은 방식)
// 폴더는 바꾸지 않는다 — 계측 스크립트가 고른 기존 폴더의 권한을 corral 이 고치면 남의 파일까지 닫힌다. 없으면 0700 으로 만든다.
// 같은 UID 의 다른 프로세스까지 0600 으로 막지는 못한다(유닉스 소켓 권한의 한계).
import fs from 'node:fs'
import type net from 'node:net'

export function privateSocketDirectory(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) return false
    if (process.getuid !== undefined && st.uid !== process.getuid()) return false
    return (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

/** umask 077 아래에서 bind 하고(소켓이 느슨한 권한으로 보이는 순간이 없게) 0600 으로 고정한다. */
export function listenPrivateSocket(input: { server: net.Server; socketPath: string }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    input.server.once('error', reject)
    const umask = process.umask(0o077)
    try {
      input.server.listen(input.socketPath, () => {
        input.server.off('error', reject)
        try {
          fs.chmodSync(input.socketPath, 0o600)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    } finally {
      process.umask(umask)
    }
  })
}

/** 비밀을 줘도 되는 소켓인가 — 폴더 ①과 소켓 ②를 지금 다시 본다. */
export function socketMaySendSecrets(input: { dir: string; socketPath: string }): boolean {
  if (!privateSocketDirectory(input.dir)) return false
  try {
    const st = fs.lstatSync(input.socketPath)
    return st.isSocket() && (process.getuid === undefined || st.uid === process.getuid()) && (st.mode & 0o077) === 0
  } catch {
    return false
  }
}
