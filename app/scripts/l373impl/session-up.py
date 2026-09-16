#!/usr/bin/env python3
"""격리 herdr 세션을 띄운다 — pty 를 열어 고정 크기 TUI 클라이언트를 붙인다.

`herdr session attach` 는 stdin 이 tty 가 아니면 winsize 0 으로 죽는다.
그래서 pty 를 직접 열고 TIOCSWINSZ 로 크기를 박은 뒤 그 슬레이브를 stdio 로 준다.
(spike2 `tui.py` 와 같은 수법 — 하네스는 재사용하지 않고 수법만 참고한다.)

격리: L373_SESSION 은 반드시 `life373-` 접두.
"""
import fcntl, os, pty, struct, subprocess, sys, termios, time

session = os.environ.get("L373_SESSION", "life373-impl")
if not session.startswith("life373-"):
    raise SystemExit(f"거부: 격리 세션이 아니다 ({session})")

cols = int(sys.argv[1]) if len(sys.argv) > 1 else 200
rows = int(sys.argv[2]) if len(sys.argv) > 2 else 50

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
proc = subprocess.Popen(
    ["herdr", "session", "attach", session],
    stdin=slave, stdout=slave, stderr=slave, close_fds=True, start_new_session=True,
)
os.close(slave)
sys.stderr.write(f"attached pid={proc.pid} {cols}x{rows}\n")
# 출력은 버린다 (pty 버퍼가 차면 herdr 가 막힌다).
while proc.poll() is None:
    try:
        if not os.read(master, 65536):
            break
    except OSError:
        break
