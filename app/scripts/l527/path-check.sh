# LIFE-527 K9 — l526 복사(코드 줄의 잔존 검색어 l526→l527·ROOT 꼴 /tmp/l527n*·이 빌드 경로·L526_ 환경변수 이름만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-526 fix5 — 삭제·복원 대상 경로를 바깥 입력(argv·env)에서 받는 셸 스크립트용 경로 검사(native-up.sh·native-down.sh 가 `.` 으로 읽는다).
# R5-01 과 같은 꼴(접두 문자열만 보고 `..` 를 통과시킴)을 닫는다. 실패면 호출자가 아무것도 지우거나 쓰기 전에 멈춘다.
# l526_plain_path <경로> <접두>: 절대경로 · `//`·`/./`·`/../`·끝 `/.`·`/..` 없음 · <접두> 또는 /private<접두> 로 시작 → 0, 아니면 1.
# l526_real_dir <경로> <접두>: l526_plain_path 통과 + 실제 폴더이고 심링크를 푼 실경로(pwd -P)도 /private<접두>·<접두> 로 시작 → 0, 아니면 1.
l527_plain_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *//*|*/./*|*/../*|*/.|*/..) return 1 ;;
  esac
  case "$1" in
    "$2"*|"/private$2"*) return 0 ;;
  esac
  return 1
}
l527_real_dir() {
  l527_plain_path "$1" "$2" || return 1
  real=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  case "$real" in
    "$2"*|"/private$2"*) return 0 ;;
  esac
  return 1
}
