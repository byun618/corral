#!/usr/bin/env python3
"""LIFE-373 스파이크 2차 — 고정 크기 PTY 에 herdr TUI 클라이언트를 붙인다 (S3b).

`script -q /dev/null herdr` 는 stdin 이 tty 가 아니면 winsize 가 0 이라
"terminal reported a zero-sized grid" 로 죽는다. 그래서 pty 를 직접 열고
TIOCSWINSZ 로 크기를 박은 뒤 그 슬레이브를 stdio 로 준다.

격리: L373_SESSION(기본 life373-claude) 접두 검사.
"""
import fcntl
import os
import pty
import struct
import subprocess
import sys
import termios

session = os.environ.get("L373_SESSION", "life373-claude")
if not session.startswith("life373-"):
    raise SystemExit(f"거부: 격리 세션이 아니다 ({session})")

cols = int(sys.argv[1]) if len(sys.argv) > 1 else 100
rows = int(sys.argv[2]) if len(sys.argv) > 2 else 30

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
proc = subprocess.Popen(
    ["herdr", "--session", session],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
print(f"tui started pid={proc.pid} {cols}x{rows}", flush=True)
try:
    while proc.poll() is None:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
except KeyboardInterrupt:
    pass
finally:
    if proc.poll() is None:
        proc.terminate()
print(f"tui exited rc={proc.poll()}", flush=True)
