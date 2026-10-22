#!/usr/bin/env python3
# LIFE-672 R6ⓑⓒ·R7ⓐ — 실제 git 으로 수정 전(optional lock 켬)·후(--no-optional-locks) 인자를 비교한다. 임시 레포에서만(/tmp/l672opt.XXXXXX).
#
# optlock.py r6 <원자료 폴더> [--n 20] [--files 300]
#   ⓑ 두 호출부(탐색기·세션 git-status)마다: 추적 파일을 touch 해 stat-dirty 로 둔 뒤 수정 전 인자 N회 → lock 나타남 ≥1(양성 대조),
#      같은 방식으로 수정 후 인자 N회 → 0. lock 나타남 = index 의 inode 가 바뀜(lock 을 잡고 rename 했다는 흔적) + 10ms 관측기(lockprobe.py)
#   ⓒ 같은 레포·같은 시각(같은 dirty 상태)에서 수정 전/후 인자 출력이 바이트로 같은지 — 순서를 바꿔 가며 N회
# optlock.py r7 <원자료 폴더> [--n 30] [--files 1000]
#   탐색기 인자 그대로, 수정 전/후 각 N회 소요 시간(중앙값·p95). 조건 (a) 매 회차 앞에서 dirty 복원 (b) 복원 없이 평소 상태
#   전/후는 같은 내용의 레포 두 벌에서 번갈아 돈다(한쪽의 index 갱신이 다른 쪽에 영향을 주지 않게). 기준: 후 중앙값 ≤ 전 중앙값 × 1.5
# 종료: 0 기준 안 · 1 기준 밖 · 2 인자 오류
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

if len(sys.argv) < 3 or sys.argv[1] not in ("r6", "r7"):
    print(__doc__ or "optlock.py r6|r7 <원자료 폴더> [--n N] [--files F]", file=sys.stderr)
    sys.exit(2)
MODE, OUT = sys.argv[1], os.path.abspath(sys.argv[2])
opts = dict(zip(sys.argv[3::2], sys.argv[4::2]))
N = int(opts.get("--n", 20 if MODE == "r6" else 30))
NF = int(opts.get("--files", 300 if MODE == "r6" else 1000))
os.makedirs(OUT, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))

EXPLORER = ["-c", "core.quotePath=false", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching"]
SESSION = ["status", "--porcelain=v2", "--branch"]
FORMS = {"explorer": EXPLORER, "session": SESSION}
PRE = lambda a: a  # noqa: E731 — 수정 전(510152c65) 인자
POST = lambda a: ["--no-optional-locks"] + a  # noqa: E731 — 수정 후 인자(GIT_STATUS_ARGS)

ENV = dict(os.environ)
ENV.pop("GIT_OPTIONAL_LOCKS", None)  # optional lock 을 켠 채로(수정 전 상태 재현)
GENV = dict(ENV, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")

W = tempfile.mkdtemp(prefix="l672opt.", dir="/tmp")
log = open(os.path.join(OUT, "log.txt"), "w")


def say(s):
    print(s)
    log.write(s + "\n")
    log.flush()


def git(repo, args, check=True):
    p = subprocess.run(["git", "-C", repo] + args, env=GENV, capture_output=True)
    if check and p.returncode != 0:
        raise SystemExit(f"git {args} 실패: {p.stderr.decode()[:300]}")
    return p


def make_repo(name):
    r = os.path.join(W, name)
    os.makedirs(r)
    git(r, ["init", "-q", "-b", "main"])
    for i in range(NF):
        d = os.path.join(r, f"d{i % 10}")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"f{i}.txt"), "w") as f:
            f.write(f"line {i}\n" * 20)
    with open(os.path.join(r, ".gitignore"), "w") as f:
        f.write("*.log\nbuild/\n")
    git(r, ["add", "-A"])
    git(r, ["-c", "commit.gpgsign=false", "commit", "-qm", "base"])
    # 탐색기 인자가 실제로 보는 것: 수정·미추적·무시 파일
    with open(os.path.join(r, "d0", "f0.txt"), "a") as f:
        f.write("changed\n")
    for k in range(5):
        open(os.path.join(r, f"untracked{k}.txt"), "w").write("u\n")
        open(os.path.join(r, f"ignored{k}.log"), "w").write("i\n")
    os.makedirs(os.path.join(r, "build"), exist_ok=True)
    open(os.path.join(r, "build", "out.bin"), "w").write("b\n")
    return r


def tracked(r):
    return [os.path.join(r, f"d{i % 10}", f"f{i}.txt") for i in range(NF)]


def dirty(paths):
    now = time.time()
    for p in paths:
        os.utime(p, (now, now))


def index_id(r):
    st = os.stat(os.path.join(r, ".git", "index"))
    return (st.st_ino, st.st_mtime_ns)


def timed(r, args):
    t0 = time.perf_counter()
    p = subprocess.run(["git", "-C", r] + args, env=ENV, capture_output=True)
    return (time.perf_counter() - t0) * 1000, p


def pct(xs, q):
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


say(f"# optlock {MODE} {time.strftime('%F %T')} · git {subprocess.run(['git', '--version'], capture_output=True, text=True).stdout.strip()} · work {W} · 추적 파일 {NF} · N {N}")
say("uptime " + subprocess.run(["uptime"], capture_output=True, text=True).stdout.strip())
rc = 0
try:
    if MODE == "r6":
        r = make_repo("r6")
        files = tracked(r)
        lockp = os.path.join(r, ".git", "index.lock")
        probe = subprocess.Popen([sys.executable, os.path.join(HERE, "lockprobe.py"), "--lock", lockp, "--out", os.path.join(OUT, "probe"),
                                  "--seconds", "3600", "--interval", "0.01", "--no-owner", "--no-ps"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        say(f"관측기 pid {probe.pid} · lock {lockp}")
        open(os.path.join(OUT, "helper-pids.txt"), "w").write(f"관측기 pid {probe.pid}\n")
        time.sleep(1)
        rows = []
        for form, args in FORMS.items():
            for phase, fn in (("전", PRE), ("후", POST)):
                for i in range(N):
                    dirty(files[:50])
                    time.sleep(0.02)
                    before = index_id(r)
                    t0 = time.time()
                    _, p = timed(r, fn(args))
                    t1 = time.time()
                    after = index_id(r)
                    rows.append({"form": form, "phase": phase, "i": i + 1, "exit": p.returncode, "t0": round(t0, 3), "t1": round(t1, 3),
                                 "index_rewritten": before[0] != after[0], "argv": fn(args)})
                    time.sleep(0.03)
        time.sleep(0.2)
        probe.terminate()
        probe.wait()
        apps = [json.loads(l)["t"] for l in open(os.path.join(OUT, "probe", "appearances.ndjson")) if '"t"' in l]
        for row in rows:
            row["probe_seen"] = sum(1 for t in apps if row["t0"] - 0.005 <= t <= row["t1"] + 0.02)
        with open(os.path.join(OUT, "runs.ndjson"), "w") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        say("## ⓑ lock 나타남 (index inode 바뀜 / 관측기)")
        for form in FORMS:
            for phase in ("전", "후"):
                sel = [x for x in rows if x["form"] == form and x["phase"] == phase]
                rew = sum(x["index_rewritten"] for x in sel)
                seen = sum(x["probe_seen"] for x in sel)
                bad = sum(x["exit"] != 0 for x in sel)
                say(f"{form} 수정{phase}: {len(sel)}회 · index 다시 씀 {rew}회 · 관측기 lock {seen}회 · git 비0 {bad}")
                if phase == "전" and rew + seen == 0:
                    rc = 1
                    say("  ✗ 양성 대조 실패 — 수정 전 인자로 lock 이 한 번도 안 보였다")
                if phase == "후" and (rew or seen or bad):
                    rc = 1
                    say(f"  ✗ 수정 후 인자로 lock/비0 이 보였다")
        say(f"관측기 전체 나타남 {len(apps)}회 · " + open(os.path.join(OUT, "probe", "summary.txt")).read().splitlines()[1])
        say("## ⓒ 같은 레포·같은 시각 출력 비교 (dirty 복원 뒤 전→후, 후→전 번갈아)")
        same = 0
        diffs = []
        for form, args in FORMS.items():
            for i in range(N):
                dirty(files[:50])
                order = [("전", PRE), ("후", POST)] if i % 2 == 0 else [("후", POST), ("전", PRE)]
                outs = {}
                for phase, fn in order:
                    _, p = timed(r, fn(args))
                    outs[phase] = (p.returncode, p.stdout)
                if outs["전"] == outs["후"]:
                    same += 1
                else:
                    diffs.append((form, i + 1))
                    open(os.path.join(OUT, f"diff-{form}-{i + 1}-pre.bin"), "wb").write(outs["전"][1])
                    open(os.path.join(OUT, f"diff-{form}-{i + 1}-post.bin"), "wb").write(outs["후"][1])
            open(os.path.join(OUT, f"sample-{form}.bin"), "wb").write(outs["전"][1])
        say(f"같음 {same}/{2 * N} · 다름 {diffs or '없음'} · 표본 출력 sample-*.bin (탐색기 {os.path.getsize(os.path.join(OUT, 'sample-explorer.bin'))}바이트)")
        if diffs:
            rc = 1
    else:
        res = {}
        for cond in ("a", "b"):
            rp, rq = make_repo(f"pre-{cond}"), make_repo(f"post-{cond}")
            fp, fq = tracked(rp), tracked(rq)
            dirty(fp)
            dirty(fq)
            time.sleep(1.1)  # racy-git 창 밖으로
            pre, post = [], []
            for i in range(N):
                for repo, files, fn, acc in ((rp, fp, PRE, pre), (rq, fq, POST, post)) if i % 2 == 0 else ((rq, fq, POST, post), (rp, fp, PRE, pre)):
                    if cond == "a":
                        dirty(files)
                    ms, p = timed(repo, fn(EXPLORER))
                    if p.returncode != 0:
                        raise SystemExit(f"git 비0: {p.stderr.decode()[:200]}")
                    acc.append(round(ms, 2))
            res[cond] = (pre, post)
            mp, mq = statistics.median(pre), statistics.median(post)
            ok = mq <= mp * 1.5
            if not ok:
                rc = 1
            label = "(a) 매 회차 dirty 복원" if cond == "a" else "(b) 복원 없음(평소 상태 — 처음 한 번만 dirty)"
            say(f"## {label}")
            say(f"수정 전 {N}회: 중앙값 {mp:.2f}ms · p95 {pct(pre, 0.95):.2f}ms · 값 {pre}")
            say(f"수정 후 {N}회: 중앙값 {mq:.2f}ms · p95 {pct(post, 0.95):.2f}ms · 값 {post}")
            say(f"기준 후 {mq:.2f} ≤ 전 {mp:.2f} × 1.5 = {mp * 1.5:.2f} → {'안' if ok else '밖'} (비 {mq / mp:.2f})")
        json.dump({k: {"pre": v[0], "post": v[1]} for k, v in res.items()}, open(os.path.join(OUT, "timings.json"), "w"))
finally:
    say("uptime " + subprocess.run(["uptime"], capture_output=True, text=True).stdout.strip())
    shutil.rmtree(W, ignore_errors=True)
say(f"optlock {MODE} exit={rc}")
sys.exit(rc)
