// LIFE-638 C2 — 커서 페이지 동치 시험의 씨앗. 기본 씨앗(`LaMcpFixture.issues`)에 표시 부모 사슬이 까다로운 작업을 더한다.
// 수정 전 BFS 결과(`specs/LIFE-638-la-cursor-activity/raw/claude/c2-before-bfs.json`)를 이 씨앗으로 떴다 — 바꾸면 그 원자료를 다시 떠야 한다.
// seq 내림차순 쪽이라 부모(낮은 seq)는 자식보다 뒤 쪽에 온다:
//   - 보관된 checkpoint 아래 미보관 bug 아래 task(3단 · 보관 중간 노드) · 미보관 checkpoint 아래 보관된 bug 아래 task
//   - 스페이스 바로 아래 보관된 bug 아래 task · 완료 checkpoint 아래 task · 보관 작업 자신(행 0) · 다른 스페이스 작업(루트 거르기)

import type { LaMcpFixture } from './la-mcp-fixture.js'

type Issue = LaMcpFixture['issues'][number]

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const PAGING_IDS = {
  corral: uuid(337), lifeAssistant: uuid(2), checkpoint: uuid(372),
  doneCheckpoint: uuid(700), archivedCheckpoint: uuid(701), bugUnderArchived: uuid(702), taskUnderBugUnderArchived: uuid(703),
  archivedBugUnderCheckpoint: uuid(704), taskUnderArchivedBugUnderCheckpoint: uuid(705), archivedBugUnderSpace: uuid(706), taskUnderArchivedBugUnderSpace: uuid(707),
  taskUnderDoneCheckpoint: uuid(708), archivedTask: uuid(709), bugUnderCheckpoint: uuid(710), taskUnderBugUnderCheckpoint: uuid(711),
  laTask2: uuid(712), direct2: uuid(713),
}

export function pagingSeed(base: Issue[]): Issue[] {
  const template = base.find((issue) => issue.kind === 'task')
  if (template === undefined) throw new Error('paging seed: 기본 씨앗에 task 가 없다')
  const make = ({ n, kind, parentId, archived = false, done = false }: { n: number; kind: Issue['kind']; parentId: string; archived?: boolean; done?: boolean }): Issue => ({
    ...template, id: uuid(n), sequentialId: n, kind, parentId, title: `씨앗 ${n}`, description: null,
    statusId: done ? '00000000-0000-4000-8000-000000009004' : '00000000-0000-4000-8000-000000009001', resolution: done ? 'completed' : null,
    position: String(n), archivedAt: archived ? '2026-10-03T00:00:00.000Z' : null, version: 1,
  })
  return [
    ...base.map((issue) => ({ ...issue })),
    make({ n: 700, kind: 'checkpoint', parentId: PAGING_IDS.corral, done: true }),
    make({ n: 701, kind: 'checkpoint', parentId: PAGING_IDS.corral, archived: true }),
    make({ n: 702, kind: 'bug', parentId: PAGING_IDS.archivedCheckpoint }),
    make({ n: 703, kind: 'task', parentId: PAGING_IDS.bugUnderArchived }),
    make({ n: 704, kind: 'bug', parentId: PAGING_IDS.checkpoint, archived: true }),
    make({ n: 705, kind: 'task', parentId: PAGING_IDS.archivedBugUnderCheckpoint }),
    make({ n: 706, kind: 'bug', parentId: PAGING_IDS.corral, archived: true }),
    make({ n: 707, kind: 'task', parentId: PAGING_IDS.archivedBugUnderSpace }),
    make({ n: 708, kind: 'task', parentId: PAGING_IDS.doneCheckpoint }),
    make({ n: 709, kind: 'task', parentId: PAGING_IDS.checkpoint, archived: true }),
    make({ n: 710, kind: 'bug', parentId: PAGING_IDS.checkpoint }),
    make({ n: 711, kind: 'task', parentId: PAGING_IDS.bugUnderCheckpoint }),
    make({ n: 712, kind: 'task', parentId: PAGING_IDS.lifeAssistant }),
    make({ n: 713, kind: 'task', parentId: PAGING_IDS.corral }),
  ]
}
