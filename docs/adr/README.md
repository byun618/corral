# ADR — 오래 남을 결정 기록

corral 의 구조·작업 방식에서 **오래 남을 결정**과 그 이유를 남긴다. 형식은 [MADR](https://adr.github.io/madr/) 이고
템플릿은 [`template.md`](template.md) 다. ADR 의 번호·상태·수정 규칙의 원본은 이 파일 한 곳이다 (LIFE-704).

## 언제 쓰나

- 되돌리기 비싸거나, 나중에 「왜 이렇게 했지」를 다시 물을 결정 — 비교한 안과 기각 사유가 있는 것.
- 일회성 선호·구체적 동작·덜 검증된 지침은 ADR 이 아니다 — 목적지 분류는 `.agents/learnings/README.md`.

## 흐름과 번호

- **초안**: 코디가 게이트 ② 에 corral-specs 작업 폴더에 쓴다(task-coordinate §8). 번호 없이, `status: proposed`.
  PR 에는 싣지 않는다.
- **채택**: 출고 회고(release §4)에서 사용자와 정한다. 채택분만 release 브랜치에 `docs/adr/NNNN-<제목-케밥>.md` 로 커밋한다.
- **번호는 채택할 때 매긴다** — 이 폴더의 가장 큰 번호 + 1, 네 자리(`0001`). 초안 단계에서 번호를 집지 않는다
  (병렬 일감이 같은 번호를 집는다).
- 공개 레포다: 홈 경로·사용자 이름·corral-specs 원자료 경로·세션 id·사용자 원문 인용을 넣지 않는다. 근거는 LIFE 번호로.

## 상태

front matter `status` 값: `proposed` · `accepted` · `rejected` · `deprecated` · `superseded by ADR-NNNN`.

- **accepted 뒤에는 본문을 고치지 않는다.** 결정이 바뀌면 새 ADR 을 쓰고, 옛 ADR 은 `status` 만
  `superseded by ADR-NNNN` 으로 바꾼다(오타·깨진 링크 수정은 예외).
- 이 폴더에 들어오는 것은 채택된 결정뿐이라 `proposed`·`rejected` 는 초안(작업 폴더)에서만 쓴다.
