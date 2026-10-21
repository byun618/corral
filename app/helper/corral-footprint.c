// corral-footprint (LIFE-676) — Resource Manager 메모리 도우미. 모든 pid 의 phys_footprint(활동 상태 보기 「메모리」 열과 같은 값)를 표로 낸다.
//
// 출력(stdout, 한 줄에 pid 하나):
//   <pid> <footprint 바이트>      읽었다
//   <pid> ERR <errno>             못 읽었다 — 다른 사용자·root 프로세스는 EPERM(1), 그 사이 끝난 프로세스는 ESRCH(3)
// 신호·입력을 보내지 않는다(읽기 전용). task_for_pid·root 가 필요 없다 — 같은 사용자 프로세스는 proc_pid_rusage 로 읽힌다(00-analysis C4).
// pid 목록을 못 얻으면 아무것도 찍지 않고 종료코드 2. 목록이 버퍼를 꽉 채우면(잘렸을 수 있다 — proc_listallpids 는 채운 개수만
// 돌려준다) 버퍼를 두 배로 늘려 다시 받고, ATTEMPTS 번 모두 차면 잘린 표를 내지 않고 종료코드 2(리뷰 r2 C2-2 — 수집기는 측정 불가).
// 빌드: app/scripts/build-footprint.mjs (clang + ad-hoc 서명). 소스는 코디 탐침 raw/coord/a02-fp-probe.c 를 개작했다.
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

#define ATTEMPTS 4

int main(void) {
  int count = proc_listallpids(NULL, 0);
  if (count <= 0) {
    fprintf(stderr, "corral-footprint: proc_listallpids 실패 (errno %d)\n", errno);
    return 2;
  }
  // 두 호출 사이에 생긴 프로세스 몫의 여유.
  int capacity = count + 256;
#ifdef INITIAL_CAPACITY
  // 절단 경로 시험용 빌드만(`clang -DINITIAL_CAPACITY=2`) — 제품 빌드(build-footprint.mjs)는 정의하지 않는다.
  capacity = INITIAL_CAPACITY;
#endif
  pid_t *pids = NULL;
  int full = 1;
  for (int attempt = 0; attempt < ATTEMPTS && full; attempt++) {
    if (attempt > 0) capacity *= 2;
    free(pids);
    pids = calloc((size_t)capacity, sizeof(pid_t));
    if (pids == NULL) {
      fprintf(stderr, "corral-footprint: 메모리 할당 실패\n");
      return 2;
    }
    count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    if (count <= 0) {
      fprintf(stderr, "corral-footprint: proc_listallpids 실패 (errno %d)\n", errno);
      free(pids);
      return 2;
    }
    full = count >= capacity;
  }
  if (full) {
    fprintf(stderr, "corral-footprint: pid 목록이 %d 번 모두 버퍼(마지막 %d 칸)를 채웠다 — 잘린 표를 내지 않는다\n", ATTEMPTS, capacity);
    free(pids);
    return 2;
  }
  for (int i = 0; i < count; i++) {
    if (pids[i] <= 0) continue;
    struct rusage_info_v2 info;
    if (proc_pid_rusage(pids[i], RUSAGE_INFO_V2, (rusage_info_t *)&info) == 0) printf("%d %llu\n", pids[i], (unsigned long long)info.ri_phys_footprint);
    else printf("%d ERR %d\n", pids[i], errno);
  }
  free(pids);
  return fflush(stdout) == 0 ? 0 : 2;
}
