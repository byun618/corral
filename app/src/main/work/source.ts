// 작업 출처 하나의 main 쪽 모양 (LIFE-600 킥오프 2). 출처 사정(LA 의 프로젝트 = 스페이스, MCP 도구 이름 …)은 이 인터페이스 뒤에만 있다.
// 레지스트리는 출처 id → (표시 정보, 토큰으로 클라이언트 만들기). 연결마다 클라이언트 인스턴스가 하나씩 생긴다(`service.ts`).

import type { WorkCall, WorkCapabilities, WorkError, WorkResult, WorkSourceDescriptor } from '../../shared/work.js'

export type WorkOutcome = { ok: true; result: WorkResult } | { ok: false; error: WorkError }

export interface WorkSourceClient {
  /** 능력 표 — 화면은 이것으로 켜고 끈다. 연결 하나 안에서 고정. */
  capabilities(): WorkCapabilities
  /** 연산 하나. 능력이 꺼진 연산은 main 이 먼저 막지만, 출처도 `unsupported` 로 답해야 한다(이중 방어). */
  call(call: WorkCall): Promise<WorkOutcome>
  /** 해제·토큰 교체 때 — 이후 출처로 아무것도 보내지 않는다. 이미 보낸 요청은 되돌리지 못한다. */
  close(): void
}

export type WorkSourceEntry = {
  descriptor: WorkSourceDescriptor
  create: (token: string) => WorkSourceClient
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
