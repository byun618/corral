# LIFE-593 수정 r2 — 한글 경로 12만 fixture(리뷰 r2 `probes/mk-kor.py` 사본, 경로만 /tmp/l593f-kor120k). 디스크 이름은 macOS 가 받은 그대로(NFC 로 만든다 — git 은 NFC, readdir 도 NFC).
import os, subprocess
root = '/tmp/l593f-kor120k/repo'
os.makedirs(root, exist_ok=True)
n = 0
for a in range(300):
    for b in range(4):
        d = f"{root}/모듈{a:03d}/하위{b}"
        os.makedirs(d, exist_ok=True)
        for c in range(100):
            open(f"{d}/파일_{a}_{b}_{c}.ts", "w").write("x\n"); n += 1
subprocess.run(['git', 'init', '-q', root], check=True)
print(n)
