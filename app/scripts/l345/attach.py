#!/usr/bin/env python3
"""격리 herdr 세션을 **크기를 정한 PTY** 로 띄운다.

herdr 는 attach 에 TTY 를 요구한다. `script -q /dev/null herdr session attach` 로도 뜨지만,
백그라운드에는 제어 터미널이 없어 PTY 가 기본값 80x24 로 잡힌다 — 그 상태로 재면 pane 의
진짜 격자가 80x24 인데 herdr 의 `pane.layout` 은 120x40 을 보고해 둘이 어긋난다 (T2 에서 잡혔다).
그래서 exec 전에 TIOCSWINSZ 로 크기를 박고 넘긴다. 측정 세계를 결정적으로 만든다.

    python3 attach.py <세션이름> [rows] [cols]
"""
import fcntl
import os
import pty
import struct
import sys
import termios

name = sys.argv[1]
rows = int(sys.argv[2]) if len(sys.argv) > 2 else 40
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 120

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

if os.fork() == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for target in (0, 1, 2):
        os.dup2(slave, target)
    os.close(master)
    if slave > 2:
        os.close(slave)
    os.execvp('herdr', ['herdr', 'session', 'attach', name])

os.close(slave)
# 마스터를 계속 비워 준다 — 안 읽으면 herdr 가 출력에서 막힌다.
while True:
    try:
        if not os.read(master, 65536):
            break
    except OSError:
        break
