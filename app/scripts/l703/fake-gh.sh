#!/usr/bin/env bash
# LIFE-703 오프라인 하네스의 가짜 gh — 로컬 bare 원격(FGH_ORIGIN) 위에서 scripts/release.sh 가 부르는 gh 호출만 흉내 낸다.
# 하네스가 이 파일을 <bin>/gh 로 복사해 PATH 앞에 둔다. 상태는 FGH_STATE 폴더의 파일이다(PR 하나 = pr/<번호>).
#   pr/<번호>: state= base= head= draft= fork= oid= mergeCommit= mergedAt= title=   (oid 는 head 브랜치가 원격에 있으면 매번 다시 읽는다)
# GitHub 흉내:
#   - 간접 머지: OPEN PR 의 head 가 base 끝에서 닿으면 MERGED 로 바꾼다 — base 가 FGH_DEFAULT(기본 main)일 때만(GHES 3.12 문서 문장).
#     FGH_INDIRECT=off 면 하지 않는다(간접 머지 미확인 경로)
#   - OPEN PR 의 head 브랜치가 원격에서 사라지면 CLOSED (G4)
#   - pr merge 는 merge-tree 로 merge commit(부모 2개)을 만들어 base 를 옮긴다. --match-head-commit 이 지금 head 와 다르면 거절
# 주입: FGH_MERGEABLE(판정 고정, 예 UNKNOWN) · FGH_MERGE_FAIL=1 · FGH_CREATE_FAIL=1 · FGH_RELEASE_FAIL=1 · FGH_ON_RELEASE_CREATE(bash 명령)
# --jq 는 시스템 jq 로 푼다. 호출은 FGH_STATE/calls.txt 에 한 줄씩 남는다.
set -uo pipefail
: "${FGH_STATE:?FGH_STATE}" "${FGH_ORIGIN:?FGH_ORIGIN}"
DEFAULT="${FGH_DEFAULT:-main}"
mkdir -p "$FGH_STATE/pr" "$FGH_STATE/release"
printf 'gh' >> "$FGH_STATE/calls.txt"; for a in "$@"; do printf ' %q' "$a" >> "$FGH_STATE/calls.txt"; done; echo >> "$FGH_STATE/calls.txt"
og() { git --git-dir="$FGH_ORIGIN" "$@"; }
fail() { echo "fake gh: $1" >&2; exit 1; }

# PR 파일 읽기·쓰기
load() { # $1 번호 → state base head draft fork oid mergeCommit mergedAt title
  local f="$FGH_STATE/pr/$1"; [ -f "$f" ] || return 1
  state=""; base=""; head=""; draft=false; fork=false; oid=""; mergeCommit=""; mergedAt=""; title="PR $1"
  # shellcheck disable=SC1090
  . "$f"
}
save() {
  { printf 'state=%q\nbase=%q\nhead=%q\ndraft=%q\nfork=%q\noid=%q\nmergeCommit=%q\nmergedAt=%q\ntitle=%q\n' \
      "$state" "$base" "$head" "$draft" "$fork" "$oid" "$mergeCommit" "$mergedAt" "$title"; } > "$FGH_STATE/pr/$1"
}
refresh() { # GitHub 쪽 상태 갱신 — head 끝 다시 읽기·head 삭제로 CLOSED·간접 머지
  local n="$1" live btip
  load "$n" || return 1
  [ "$state" = OPEN ] || return 0
  live="$(og rev-parse -q --verify "refs/heads/$head" 2>/dev/null || true)"
  if [ -z "$live" ]; then state=CLOSED; save "$n"; return 0; fi
  oid="$live"
  btip="$(og rev-parse -q --verify "refs/heads/$base" 2>/dev/null || true)"
  if [ "${FGH_INDIRECT:-on}" = on ] && [ "$base" = "$DEFAULT" ] && [ -n "$btip" ] && og merge-base --is-ancestor "$oid" "$btip" 2>/dev/null; then
    state=MERGED; mergedAt="2026-10-26T00:00:00Z"; mergeCommit="$btip"
  fi
  save "$n"
}
mergeable_of() {
  [ -z "${FGH_MERGEABLE:-}" ] || { echo "$FGH_MERGEABLE"; return; }
  local btip; btip="$(og rev-parse "refs/heads/$base")"
  if og merge-tree --write-tree "$btip" "$oid" >/dev/null 2>&1; then echo MERGEABLE; else echo CONFLICTING; fi
}
pr_json() { # 현재 load 된 PR → JSON
  local n="$1" mc="null"
  [ -z "$mergeCommit" ] || mc="{\"oid\":\"$mergeCommit\"}"
  jq -n --argjson number "$n" --arg state "$state" --arg base "$base" --arg head "$head" --argjson draft "$draft" --argjson fork "$fork" \
    --arg oid "$oid" --argjson mc "$mc" --arg mergedAt "$mergedAt" --arg title "$title" --arg mergeable "$(mergeable_of)" \
    '{number: $number, state: $state, baseRefName: $base, headRefName: $head, isDraft: $draft, isCrossRepository: $fork,
      headRefOid: $oid, mergeCommit: $mc, mergedAt: (if $mergedAt == "" then null else $mergedAt end),
      mergedBy: (if $state == "MERGED" then {login: "fake"} else null end), title: $title, mergeable: $mergeable,
      url: ("https://github.example/o/r/pull/" + ($number | tostring))}'
}
# --json 필드·--jq 적용
emit() { # $1 JSON, $2 필드 목록, $3 jq 식(없으면 필드만 뽑아 출력)
  local sel
  sel="$(echo "$2" | awk -F, '{for (i = 1; i <= NF; i++) printf "%s%s: .%s", (i > 1 ? ", " : ""), $i, $i}')"
  if echo "$1" | jq -e 'type == "array"' >/dev/null; then sel="map({$sel})"; else sel="{$sel}"; fi
  if [ -n "$3" ]; then echo "$1" | jq -c "$sel" | jq -r "$3"; else echo "$1" | jq -c "$sel"; fi
}
opt() { # 인자 목록에서 --이름 값
  local want="$1"; shift
  while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "${2:-}"; return 0; }; shift; done
  return 1
}

case "${1:-} ${2:-}" in
  "pr view")
    n="$3"; shift 3
    refresh "$n" || fail "no pull request #$n"
    emit "$(pr_json "$n")" "$(opt --json "$@")" "$(opt --jq "$@" || true)" ;;
  "pr list")
    shift 2
    H="$(opt --head "$@" || true)"; B="$(opt --base "$@" || true)"; S="$(opt --state "$@" || echo open)"
    arr="[]"
    for f in "$FGH_STATE"/pr/*; do
      [ -f "$f" ] || continue
      n="$(basename "$f")"; refresh "$n"; load "$n"
      [ -z "$H" ] || [ "$head" = "$H" ] || continue
      [ -z "$B" ] || [ "$base" = "$B" ] || continue
      case "$S" in open) [ "$state" = OPEN ] || continue ;; merged) [ "$state" = MERGED ] || continue ;; closed) [ "$state" = CLOSED ] || continue ;; all) ;; esac
      arr="$(echo "$arr" | jq -c --argjson p "$(pr_json "$n")" '. + [$p]')"
    done
    emit "$arr" "$(opt --json "$@")" "$(opt --jq "$@" || true)" ;;
  "pr create")
    shift 2
    [ "${FGH_CREATE_FAIL:-0}" = 0 ] || fail "흉내 pr create 실패"
    B="$(opt --base "$@")"; H="$(opt --head "$@")"; T="$(opt --title "$@" || echo t)"
    og rev-parse -q --verify "refs/heads/$H" >/dev/null || fail "head $H 가 원격에 없다"
    last="$(ls "$FGH_STATE/pr" | sort -n | tail -1)"; n=$(( ${last:-0} + 1 ))
    state=OPEN; base="$B"; head="$H"; draft=false; fork=false; oid="$(og rev-parse "refs/heads/$H")"; mergeCommit=""; mergedAt=""; title="$T"
    save "$n"
    echo "https://github.example/o/r/pull/$n" ;;
  "pr merge")
    n="$3"; shift 3
    [ "${FGH_MERGE_FAIL:-0}" = 0 ] || fail "흉내 pr merge 거절"
    refresh "$n" || fail "no pull request #$n"; load "$n"
    [ "$state" = OPEN ] || fail "PR #$n 은 $state"
    M="$(opt --match-head-commit "$@" || true)"
    [ -z "$M" ] || [ "$M" = "$oid" ] || fail "Head branch was modified. Review and try the merge again."
    btip="$(og rev-parse "refs/heads/$base")"
    tree="$(og merge-tree --write-tree "$btip" "$oid")" || fail "merge conflict"
    mc="$(GIT_AUTHOR_NAME=gh GIT_AUTHOR_EMAIL=gh@example GIT_COMMITTER_NAME=gh GIT_COMMITTER_EMAIL=gh@example \
      og commit-tree "$tree" -p "$btip" -p "$oid" -m "Merge pull request #$n from o/$head")"
    og update-ref "refs/heads/$base" "$mc" "$btip" || fail "base 가 그새 움직였다"
    state=MERGED; mergeCommit="$mc"; mergedAt="2026-10-26T00:00:00Z"; save "$n" ;;
  "release view")
    T="$3"; shift 3
    [ -f "$FGH_STATE/release/$T" ] || fail "release not found"
    emit "$(jq -n --arg t "$T" --arg pre "$(cat "$FGH_STATE/release/$T")" '{tagName: $t, url: ("https://github.example/o/r/releases/tag/" + $t), isPrerelease: ($pre == "pre")}')" \
      "$(opt --json "$@" || echo tagName,url,isPrerelease)" "$(opt --jq "$@" || true)" ;;
  "release create")
    T="$3"; shift 3
    [ "${FGH_RELEASE_FAIL:-0}" = 0 ] || fail "흉내 release create 실패"
    og rev-parse -q --verify "refs/tags/$T" >/dev/null || fail "tag $T 가 원격에 없다(--verify-tag)"
    [ ! -f "$FGH_STATE/release/$T" ] || fail "release $T 가 이미 있다"
    F="$(opt --notes-file "$@")"; [ -s "$F" ] || fail "노트 파일 없음"
    pre=full; case " $* " in *" --prerelease "*) pre=pre ;; esac
    echo "$pre" > "$FGH_STATE/release/$T"
    [ -z "${FGH_ON_RELEASE_CREATE:-}" ] || bash -c "$FGH_ON_RELEASE_CREATE" || exit 1
    echo "https://github.example/o/r/releases/tag/$T" ;;
  *) fail "모르는 호출 $*" ;;
esac
