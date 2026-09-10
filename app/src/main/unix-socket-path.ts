// 유닉스 소켓 경로 길이 한계 — 실측으로 확인한 OS 제약이다.
//
// macOS 의 sockaddr_un.sun_path 는 104 bytes(NUL 포함)다. 실측(raw/claude/12-unix-socket-path-limit.json):
//   Electron 44 / Node 24.20 → 104 bytes 까지 성공, **105 bytes 부터 EINVAL**
//   Node 20.20               → 105 bytes 이상도 "성공"하지만 경로를 **조용히 잘라** 엉뚱한 파일을 만든다
// 두 쪽 다 위험하다. 그래서 붙기·바인드 **전에** 길이를 재고, 넘으면 식별 가능한 실패로 남긴다.
//
// corral 에 이게 왜 중요한가: herdr 세션 소켓 경로가 길어지면 앱이 그 세션에 아예 못 붙는다.
// 오늘 값은 default 36 bytes · named(life344-probe) 59 bytes 로 여유가 있다.

export const MAX_UNIX_SOCKET_PATH_BYTES = 104

export type SocketPathCheck = { ok: boolean; bytes: number; limit: number; reason: string | null }

export function checkUnixSocketPath(socketPath: string): SocketPathCheck {
  const bytes = Buffer.byteLength(socketPath, 'utf8')
  if (bytes <= MAX_UNIX_SOCKET_PATH_BYTES) return { ok: true, bytes, limit: MAX_UNIX_SOCKET_PATH_BYTES, reason: null }
  return {
    ok: false,
    bytes,
    limit: MAX_UNIX_SOCKET_PATH_BYTES,
    reason: `유닉스 소켓 경로가 ${bytes} bytes 로 한계(${MAX_UNIX_SOCKET_PATH_BYTES})를 넘는다: ${socketPath}`,
  }
}
