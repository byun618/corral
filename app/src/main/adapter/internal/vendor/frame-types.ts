// 벤더 발췌 — herdr-studio `server/src/bridge/thin-client.ts` 에서 프레임 타입·리더만.
// 출처: e806c14 (v0.6.1, MIT). 전체 목록은 PROVENANCE.md.
//
// thin-client.ts 원본은 레거시 프로토콜(0.9.0 이전) 클라이언트 전체라 벤더하지 않는다
// (02-rebuild-plan §2 "안 봄"). PaneSurface 프레임이 이 wire FrameData 레이아웃을 공유하므로
// 여기 발췌한 다섯 개(원본 주석 그대로: "Exported for the stable endpoint client")만 가져온다.
// 코드 본문은 원본과 한 글자도 다르지 않다 — import 대상만 이 파일로 바뀌었다.

import type { BinReader } from "./bincode";

export interface CellData {
  symbol: string;
  fg: number;
  bg: number;
  modifier: number;
  skip: boolean;
  hyperlink: number | null;
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  shape: number;
}

export interface FrameData {
  cells: CellData[];
  width: number;
  height: number;
  cursor: CursorState | null;
  hyperlinks: string[];
}

// Exported for the stable endpoint client (PaneSurface frames share the wire
// FrameData layout).
export function readCellData(r: BinReader): CellData {
  return {
    symbol: r.string(),
    fg: r.varint(),
    bg: r.varint(),
    modifier: r.varint(),
    skip: r.bool(),
    hyperlink: r.option(() => r.varint()),
  };
}

export function readFrameData(r: BinReader): FrameData {
  const cellCount = r.varint();
  const cells: CellData[] = new Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    cells[i] = readCellData(r);
  }
  const width = r.varint();
  const height = r.varint();
  const cursor = r.option(
    (): CursorState => ({
      x: r.varint(),
      y: r.varint(),
      visible: r.bool(),
      shape: r.u8(),
    }),
  );
  const linkCount = r.varint();
  const hyperlinks: string[] = new Array(linkCount);
  for (let i = 0; i < linkCount; i++) hyperlinks[i] = r.string();
  r.bytes(); // graphics (ignored)
  return { cells, width, height, cursor, hyperlinks };
}
