#!/bin/sh
# LIFE-694 최종 관문 fixture — 관문용 임시 git 레포 r·r2 와 레지스트리. up.sh 전에. sh scripts/l694/setup.sh <ROOT=/tmp/l694g-*>
set -eu
ROOT=$1; case "$ROOT" in /tmp/l694g-*) ;; *) echo "ROOT 는 /tmp/l694g-*"; exit 2 ;; esac
[ -e "$ROOT" ] && { echo "이미 있다 $ROOT"; exit 3; }
mkdir -p "$ROOT/repos" "$ROOT/ud"
for r in r r2; do
  git init -q -b main "$ROOT/repos/$r"
  git -C "$ROOT/repos/$r" -c user.email=l694@x -c user.name=l694 commit -q --allow-empty -m init
done
mkdir -p "$ROOT/repos/r/app"
R=$(cd "$ROOT" && pwd -P)
printf '["%s","%s"]\n' "$R/repos/r" "$R/repos/r2" > "$ROOT/ud/repos.json"
echo "setup ok $R $(date -u +%FT%TZ)" | tee -a "$ROOT/made.txt"
