---
status: accepted
date: 2026-11-24
decision-makers: 코디네이터(게이트 ⓪ 사용자 승인) · 사용자(출고 회고 채택)
---

# 음성 받아쓰기는 macOS 내장 SpeechTranscriber 를 별도 Swift 헬퍼 프로세스로 돌리고, 확정 글만 pane 에 넣는다

## Context and Problem Statement

포커스된 터미널 pane 에 말로 입력하는 기능이 필요했다(LIFE-834). 엔진을 무엇으로, 어느 프로세스에서 돌리고, 인식 결과 중 무엇을 언제 pane 에 넣을지 정해야 했다. 넣은 글이 셸 명령으로 실행되거나 에이전트 입력으로 제출되면 안 된다.

## Decision Drivers

* 음성이 기기 밖으로 나가지 않을 것, 모델 내려받기·저장 관리가 없을 것
* 한국어 정확도(영어 용어 섞임 포함)
* Electron 앱 크기·빌드 기계(PR CI 는 swiftc·macOS 26 SDK 없음) 부담 최소
* 마이크 권한 주체가 corral 앱으로 보일 것
* 넣은 글이 Enter 를 만들 수 없을 것

## Considered Options

* A. macOS 내장 `SpeechTranscriber`(ko-KR) — Swift 헬퍼 프로세스가 마이크·인식을 함께, 줄 단위 JSON 으로 main 에 보고
* B. Whisper 계열(Large v3 Turbo 등) 기기 안 모델 — 모델 내려받기·엔진 런타임 동봉
* C. 클라우드 음성 인식 API

## Decision Outcome

Chosen option: "A", because 순수 한국어 오류율이 B 와 비슷하고(외부 측정 약 4.3% 대) 모델 관리·수백 MB 동봉이 없으며 음성이 밖으로 나가지 않는다. 헬퍼는 앱 번들 안에 ad-hoc 서명으로 넣고(dmg +수십 KB), `package:mac` 단계에서만 빌드해 dev·PR CI 는 swiftc 없이 돈다.

딸린 결정:

* **확정(FINAL) 글만 넣는다** — 중간 결과는 표시만. 빠른 결과 모드(`.fastResults`)는 확정 글 자체를 바꿔 정확도를 낮추므로 쓰지 않는다(정확도 우선 — 말하는 중 실시간 미리보기는 거의 없다).
* **정지 방식** — 300 ms 이상 누르고 떼면 정지(홀드), 짧게 누르면 켜진 채 다음 누름 또는 60초 무음에 자동 정지(탭).
* **넣는 길** — 대상 pane 이 화면에 붙어 있으면 기존 붙여넣기와 같은 bracketed paste, 붙어 있지 않으면 terminal backend guard 의 `pane.send_text` 로 제어 문자를 지우고 줄바꿈을 공백으로 바꾼 글만 보낸다. 어느 길이든 Enter 가 들어가지 않는다.

### Consequences

* Good, because 엔진 비용(내려받기·저장·업데이트)이 0 이고 오프라인으로 돈다.
* Good, because 헬퍼가 죽거나 멈춰도 앱 본체는 영향이 없고, 헬퍼 실패는 받아쓰기 알림으로만 나타난다.
* Bad, because macOS 26 이상·ko-KR 자산이 있어야 하고, 언어·어휘 조정 여지가 Apple API 범위에 묶인다.
* Bad, because ad-hoc 서명이라 앱을 새로 깔 때마다 마이크 권한을 다시 묻는다(정식 서명 전까지).
* Bad, because 붙지 않은 pane 으로 들어간 글은 앱에 「붙여넣기」가 아니라 「타자」로 보이고 여러 줄이 한 줄이 된다.

### Confirmation

* 헬퍼 파일 입력 시험(합성 음성 → 확정 글)과 simulate 경로 시험 — 레포 밖 관문 스크립트라 받아쓰기를 바꾸는 일감마다 다시 돌린다.
* 대상·상태 표 단위 시험(넣기 길 선택·제어 문자 제거·Enter 없음, 홀드·탭 판정)이 `npm test` 에 있다.
* `package:mac` 은 헬퍼 빌드·`--check` 실패 시 멈춘다.

## Pros and Cons of the Options

### A. SpeechTranscriber + Swift 헬퍼

* Good, because 동봉 크기·모델 관리 0, 기기 안 처리.
* Bad, because OS 버전·Apple API 의존, 빠른 미리보기와 정확도를 같이 얻지 못한다.

### B. Whisper 계열 기기 안 모델

* Good, because 영어 섞인 말에 더 강할 가능성, 언어 선택 폭.
* Bad, because 모델 수백 MB 내려받기·저장 관리·엔진 런타임 동봉, 순수 한국어 정확도 이득은 측정상 거의 없다.

### C. 클라우드 API

* Good, because 정확도·언어 폭.
* Bad, because 음성이 밖으로 나가고 키·과금·네트워크 의존이 생긴다.

## More Information

* LIFE-834. 다시 볼 조건: 영어 용어 오인식이 사용에서 반복될 때(사용자 어휘 힌트 실측 → 엔진 B 검토), 정식 서명을 붙일 때(권한 재요청 결과 갱신), 앱 안 입력칸으로 넣기를 넓힐 때.
