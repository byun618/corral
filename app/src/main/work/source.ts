// 작업 출처 하나의 main 쪽 모양 (LIFE-600 킥오프 2). 출처 사정(LA 의 프로젝트 = 스페이스, MCP 도구 이름 …)은 이 인터페이스 뒤에만 있다.
// 레지스트리는 출처 id → (표시 정보, 토큰으로 클라이언트 만들기). 연결마다 클라이언트 인스턴스가 하나씩 생긴다(`service.ts`).

import type { WorkCall, WorkCapabilities, WorkError, WorkResult, WorkSourceDescriptor } from '../../shared/work.js'

export type WorkOutcome = { ok: true; result: WorkResult } | { ok: false; error: WorkError }

/**
 * 연산에 딸린 것 (LIFE-602) — `writeId` 는 main 이 쓰기마다 새로 만든 id 다. 출처가 변경 이력에 메타를 실을 수 있으면(Jira `historyMetadata` 류)
 * 실어 두고 이력(`listHistory`)에서 그대로 돌려준다 — corral 활동 기록과 같은 변경을 한 번만 보이게 하는 열쇠(G10). 못 실으면 무시한다.
 */
export type WorkCallMeta = { writeId: string | null }

export interface WorkSourceClient {
  /** 능력 표 — 화면은 이것으로 켜고 끈다. 연결 하나 안에서 고정. */
  capabilities(): WorkCapabilities
  /** 연산 하나. 능력이 꺼진 연산은 main 이 먼저 막지만, 출처도 `unsupported` 로 답해야 한다(이중 방어). */
  call(call: WorkCall, meta?: WorkCallMeta): Promise<WorkOutcome>
  /** 해제·토큰 교체 때 — 이후 출처로 아무것도 보내지 않는다. 이미 보낸 요청은 되돌리지 못한다. */
  close(): void
}

/** 연결 자격 (LIFE-605 C1) — 토큰(비밀) + descriptor `accountFields` 의 값(비밀 아님, 출처가 정규화한 값). LA 는 `account` 가 빈 객체. */
export type WorkCredentials = { token: string; account: Record<string, string> }

export type WorkAccountCheck = { ok: true; account: Record<string, string> } | { ok: false; message: string }

export type WorkSourceEntry = {
  descriptor: WorkSourceDescriptor
  create: (credentials: WorkCredentials) => WorkSourceClient
  /**
   * 비밀 아닌 칸 검증·정규화(LIFE-605 C1②) — **네트워크 전에** service 가 부른다. 칸이 없는 출처는 생략(빈 객체만 받는다).
   * 거절 문구에 입력값을 싣지 않는다(이메일이 오류 문구에 남지 않게).
   */
  checkAccount?: (account: Record<string, string>) => WorkAccountCheck
  /** 이 자격에서 나오는 비밀 글(토큰 말고 — Jira Basic 헤더 값·이메일). 밖으로 나가는 문구에서 지운다(F2). */
  secretsOf?: (credentials: WorkCredentials) => string[]
}

export class WorkSourceRegistry {
  private readonly entries: Map<string, WorkSourceEntry>

  constructor(entries: WorkSourceEntry[]) {
    this.entries = new Map(entries.map((entry) => [entry.descriptor.id, entry]))
  }

  descriptors(): WorkSourceDescriptor[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.descriptor }))
  }

  get(sourceId: string): WorkSourceEntry | null {
    return this.entries.get(sourceId) ?? null
  }
}
