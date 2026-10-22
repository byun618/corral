#!/usr/bin/env python3
# LIFE-672 lock 관측기 — index.lock 을 10ms 간격으로 보고, 나타날 때마다 시각·크기·inode 와 그 순간 쥔 프로세스(lsof·ps)를 남긴다.
# 읽기만 한다: lock 을 만들거나 지우거나 열지 않는다(os.stat 만). 레포에서 git 도 돌리지 않는다.
#
# lockprobe.py --lock <index.lock 절대경로> --out <원자료 폴더> [--seconds 300] [--interval 0.01]
#              [--no-owner] [--ps-every 0.1] [--parent-match <정규식>] [--no-ps]
#   --no-owner      나타날 때 lsof·ps 를 부르지 않는다(관측 간격을 지키는 가벼운 양성 대조용 — R1ⓑ·R6ⓑ)
#   --parent-match  조상 프로세스 명령이 이 정규식에 맞는 `git … status` 자식을 ps 표본에서 센다(양성 대조 — 기본은 설치본 corral)
#   --no-ps         ps 표본을 끈다
# 남기는 것: appearances.ndjson(나타남 한 줄씩) · status-children.txt(본 git 자식 pid·종류·명령) · summary.txt · pid.txt
# 셸의 /usr/bin/git(xcrun 경유)으로 띄운 git 은 ps 에 「(git)」 으로만 보이는 일이 잦다(2026-10-22 확인, 설치본 corral 이 띄운 CLT git 은 인자가 보였다) — 그래서 git 자식을 셋으로 나눠 센다:
#   status(인자에 status) · 인자 못 읽음(「(git)」) · 다른 git 명령. 양성 대조 수 = status + 인자 못 읽음
# 종료: 0 끝까지 관측 · 2 인자 오류. 관측 결과로 종료코드를 바꾸지 않는다(판정은 summary 를 읽고 사람이·체크리스트가 한다).
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

ap = argparse.ArgumentParser()
ap.add_argument("--lock", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--seconds", type=float, default=300)
ap.add_argument("--interval", type=float, default=0.01)
ap.add_argument("--no-owner", action="store_true")
ap.add_argument("--ps-every", type=float, default=0.1)
ap.add_argument("--parent-match", default=r"^/Applications/corral\.app/")
ap.add_argument("--no-ps", action="store_true")
a = ap.parse_args()
if not os.path.isabs(a.lock):
    print("--lock 은 절대경로", file=sys.stderr)
    sys.exit(2)
os.makedirs(a.out, exist_ok=True)
with open(os.path.join(a.out, "pid.txt"), "w") as f:
    f.write(f"{os.getpid()}\n")

stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())


def run(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=2)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:  # 관측기는 죽지 않는다 — 실패도 기록
        return -1, "", str(e)


def ps_table():
    rc, out, _ = run(["ps", "-Ao", "pid=,ppid=,command="])
    rows = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(.*)$", line)
        if m:
            rows[int(m.group(1))] = (int(m.group(2)), m.group(3))
    return rows


def ancestry(rows, pid):
    chain = []
    seen = set()
    while pid in rows and pid not in seen and pid > 1:
        seen.add(pid)
        ppid, cmd = rows[pid]
        chain.append((pid, cmd))
        pid = ppid
    return chain


parent_re = re.compile(a.parent_match)
status_re = re.compile(r"(^|/)git(\s.*)?\sstatus(\s|$)")
git_re = re.compile(r"^(\(git\)$|(\S*/)?git(\s|$))")
children = {}  # pid → (종류, 명령) (처음 본 것)
samples = [0]


def ps_loop():
    while not stop.is_set():
        rows = ps_table()
        samples[0] += 1
        for pid, (ppid, cmd) in rows.items():
            if pid in children or not git_re.search(cmd):
                continue
            anc = ancestry(rows, ppid)
            if any(parent_re.search(c) for _, c in anc):
                kind = "status" if status_re.search(cmd) else ("인자 못 읽음" if cmd == "(git)" else "다른 git 명령")
                children[pid] = (kind, cmd)
        stop.wait(a.ps_every)


if not a.no_ps:
    threading.Thread(target=ps_loop, daemon=True).start()

apf = open(os.path.join(a.out, "appearances.ndjson"), "w")
t_start = time.time()
deadline = t_start + a.seconds
present = None  # (inode, 처음 본 시각)
count = 0
durations = []
polls = 0
max_gap = 0.0
last = time.monotonic()
while not stop.is_set() and time.time() < deadline:
    polls += 1
    now_m = time.monotonic()
    max_gap = max(max_gap, now_m - last)
    last = now_m
    try:
        st = os.stat(a.lock)
    except FileNotFoundError:
        st = None
    except OSError as e:
        st = None
        apf.write(json.dumps({"t": time.time(), "stat_error": str(e)}) + "\n")
    if st is not None and (present is None or present[0] != st.st_ino):
        if present is not None:
            durations.append(time.time() - present[1])
        count += 1
        rec = {"n": count, "t": round(time.time(), 3), "size": st.st_size, "inode": st.st_ino, "mtime": st.st_mtime}
        if not a.no_owner:
            # ps 를 먼저 — lock 이 짧으면 lsof 가 돌 때는 이미 놓았다. 그 순간 돌던 git 과 조상을 남긴다
            rows = ps_table()
            rec["git_now"] = [{"pid": p, "ppid": r[0], "cmd": r[1][:200], "chain": [c[:120] for _, c in ancestry(rows, r[0])[:3]]}
                              for p, r in rows.items() if git_re.search(r[1])][:20]
            rc, out, err = run(["lsof", "-t", "--", a.lock])
            rec["lsof_rc"] = rc
            rec["lsof_pids"] = out.split()
            rec["lsof_err"] = err.strip()[:200]
            rec["owners"] = [{"pid": int(p), "chain": ancestry(rows, int(p))[:4]} for p in rec["lsof_pids"] if p.isdigit()]
        apf.write(json.dumps(rec, ensure_ascii=False) + "\n")
        apf.flush()
        present = (st.st_ino, time.time())
    elif st is None and present is not None:
        durations.append(time.time() - present[1])
        present = None
    stop.wait(a.interval)
apf.close()
stop.set()
t_end = time.time()
with open(os.path.join(a.out, "status-children.txt"), "w") as f:
    for pid, (kind, cmd) in sorted(children.items()):
        f.write(f"{pid}\t{kind}\t{cmd}\n")
K = {k: sum(1 for v in children.values() if v[0] == k) for k in ("status", "인자 못 읽음", "다른 git 명령")}
summary = [
    f"lock {a.lock}",
    f"관측 {time.strftime('%F %T', time.localtime(t_start))} ~ {time.strftime('%F %T', time.localtime(t_end))} ({t_end - t_start:.1f}초) · 간격 {a.interval}s · 폴링 {polls}회 · 최대 폴링 틈 {max_gap * 1000:.0f}ms",
    f"lock 나타남 {count}회 · 최장 유지 {max(durations) if durations else 0:.3f}초(관측 기준) · 끝날 때 있음 {'예' if present else '아니오'}",
    f"git 자식(조상 ~ /{a.parent_match}/) " + ("ps 표본 끔" if a.no_ps else f"{len(children)}개 — status {K['status']} · 인자 못 읽음 {K['인자 못 읽음']} · 다른 git 명령 {K['다른 git 명령']} · 양성 대조 수(status + 인자 못 읽음) {K['status'] + K['인자 못 읽음']} · ps 표본 {samples[0]}회"),
]
with open(os.path.join(a.out, "summary.txt"), "w") as f:
    f.write("\n".join(summary) + "\n")
print("\n".join(summary))
