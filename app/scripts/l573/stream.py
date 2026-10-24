# LIFE-573 C5 — 한 행을 계속 다시 쓴다(제자리 \r). 사용: python3 stream.py <행 파일> <초>
# 행 파일 내용(줄바꿈 없음) 뒤에 6자리 카운터를 붙여 5ms 마다 쓴다.
import sys, time
line = open(sys.argv[1]).read()
end = time.time() + float(sys.argv[2])
i = 0
sys.stdout.write('\n')
while time.time() < end:
    i += 1
    sys.stdout.write('\r\033[2K' + line + ' %06d' % i)
    sys.stdout.flush()
    time.sleep(0.005)
sys.stdout.write('\nstream-done %d\n' % i)
