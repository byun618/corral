import os, sys, tty, termios, select
log, fifo, starts = sys.argv[1:]
with open(starts, 'ab') as f: f.write(b'start\n')
prior = termios.tcgetattr(0)
tty.setraw(0)
fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
print('RECEIVER_READY', flush=True)
try:
    while True:
        ready, _, _ = select.select([0, fd], [], [], 60)
        if 0 in ready:
            data = os.read(0, 65536)
            with open(log, 'ab') as f: f.write(data)
            if b'\x04' in data: break
        if fd in ready:
            data = os.read(fd, 65536)
            os.write(1, data)
finally:
    termios.tcsetattr(0, termios.TCSANOW, prior)
    os.close(fd)
