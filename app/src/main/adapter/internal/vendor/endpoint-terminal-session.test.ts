// 벤더 테스트 수정 (LIFE-353 — PROVENANCE.md 에 strip 목록):
//   ① bun:test → vitest, Bun.sleep → 로컬 sleep (S7ⓑ: 벤더 트리 Bun 참조 0)
//   ② import: ./thin-client → ./frame-types, ../utils/logger → ./logger
//   ③ terminal-bridge(createTerminalBridge)·create()/EndpointCreationDeadline 의존 테스트 전량 strip
//      — bridge 는 벤더 금지(사용자 지시: 참고만), create() 는 R3 범위라 세션에서 strip 됨.
//      남긴 것: EndpointTerminalSession describe 전체 + 마우스 top-level 2건 + cropFrame describe
//   ④ (LIFE-544) 간헐 실패 7건의 고정 대기를 조건 대기(`until`)로, 500ms 보류 타이머와 경합하던
//      4건(first visible frame ×3·continuous stale frames)은 제품 타이머만 가짜 시계(`fakeProductTimers`)로
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import {
  EndpointTerminalSession,
  cropFrame,
} from "./endpoint-terminal-session";
import type { CellData, FrameData } from "./frame-types";
import { silentLogger } from "./logger";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// LIFE-544: captured before any test fakes timers, so waits stay on the real clock.
const realSetTimeout = globalThis.setTimeout;
const POLL_MS = 5;
// Wall-clock ceiling per test, kept below vitest's 5s test timeout.
const WALL_CEILING_MS = 4000;
let testStartedAt = performance.now();
beforeEach(() => {
  testStartedAt = performance.now();
});

/**
 * Waits for something that must arrive. The budget counts polls, not
 * wall-clock: an event loop stalled by full-suite load delays one poll
 * instead of eating the budget. A wall-clock ceiling measured from the
 * test start still ends the wait as an assertion before vitest's 5s
 * timeout. `performance` is never faked here (fakeProductTimers fakes
 * setTimeout/clearTimeout only).
 */
async function until(label: string, check: () => boolean, budgetMs = 1000) {
  for (let polled = 0; !check(); polled += POLL_MS) {
    if (polled >= budgetMs)
      expect.fail(`missing ${label} within ${budgetMs}ms of polling`);
    const elapsed = performance.now() - testStartedAt;
    if (elapsed >= WALL_CEILING_MS)
      expect.fail(
        `missing ${label} at the ${WALL_CEILING_MS}ms wall-clock ceiling (${Math.round(elapsed)}ms since test start)`,
      );
    await new Promise<void>((resolve) => realSetTimeout(resolve, POLL_MS));
  }
}

/** `until` for a promise: resolves with its value or rethrows its error. */
async function untilSettled<T>(label: string, promise: Promise<T>): Promise<T> {
  const outcomes: Array<{ ok: true; value: T } | { ok: false; error: unknown }> =
    [];
  void promise.then(
    (value) => outcomes.push({ ok: true, value }),
    (error: unknown) => outcomes.push({ ok: false, error }),
  );
  await until(label, () => outcomes.length > 0);
  const [outcome] = outcomes;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * The session's FIT_DEFER_MS deadline races a real-clock test under load.
 * Fake only setTimeout/clearTimeout so the deadline moves when the test
 * advances it; sockets and `until` keep running on the real clock.
 */
function fakeProductTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/**
 * Surface revisions the session has processed, from its debug log.
 * Depends on vendor change ③ (`logger.debug("surface", { surfaceRevision })`
 * in endpoint-terminal-session.ts): removing or renaming that line fails
 * these tests loudly as `missing stale surface …`, never silently.
 */
function surfaceLog() {
  const revisions: number[] = [];
  const logger = {
    ...silentLogger,
    debug: (message: string, fields?: Record<string, unknown>) => {
      if (message === "surface") revisions.push(Number(fields?.surfaceRevision));
    },
  };
  return { revisions, logger };
}


const servers: net.Server[] = [];

afterEach(async () => {
  // A test that hits vitest's timeout skips its `finally`; never leak fake
  // timers into the next test.
  vi.useRealTimers();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function cell(symbol: string, over: Partial<CellData> = {}): CellData {
  return {
    symbol,
    fg: 0,
    bg: 0,
    modifier: 0,
    skip: false,
    hyperlink: null,
    ...over,
  };
}

function writeCell(w: BinWriter, c: CellData) {
  w.string(c.symbol);
  w.varint(c.fg);
  w.varint(c.bg);
  w.varint(c.modifier);
  w.bool(c.skip);
  w.option(c.hyperlink, (v) => w.varint(v));
}

function writeFrame(w: BinWriter, frame: FrameData) {
  w.varint(frame.cells.length);
  for (const c of frame.cells) writeCell(w, c);
  w.varint(frame.width);
  w.varint(frame.height);
  w.option(frame.cursor, (cur) => {
    w.varint(cur.x);
    w.varint(cur.y);
    w.bool(cur.visible);
    w.u8(cur.shape);
  });
  w.varint(frame.hyperlinks.length);
  for (const link of frame.hyperlinks) w.string(link);
  w.bytes(Buffer.alloc(0));
}

type Rect = { x: number; y: number; width: number; height: number };
type TestPane = {
  paneId: string;
  x: number;
  mouseReporting: boolean;
  rect?: Rect;
  innerRect?: Rect;
};
const DEFAULT_PANES: TestPane[] = [
  { paneId: "w1:p1", x: 0, mouseReporting: false },
];

function writePane(
  w: BinWriter,
  paneId: string,
  x = 0,
  y = 0,
  mouseReporting = false,
  rect = { x, y, width: 10, height: 5 },
  innerRect = { x: x + 1, y: y + 1, width: 8, height: 3 },
) {
  w.string(paneId);
  w.varint(1);
  for (const bounds of [rect, innerRect]) {
    w.varint(bounds.x);
    w.varint(bounds.y);
    w.varint(bounds.width);
    w.varint(bounds.height);
  }
  w.bool(false);
  w.bool(true); // scroll metrics present
  w.varint(0); // offset_from_bottom
  w.varint(100); // max_offset_from_bottom
  w.varint(3); // viewport_rows
  w.bool(true); // focused
  w.bool(mouseReporting);
  w.bool(false);
  w.bool(false);
  w.varint(0);
  w.varint(0);
}

function surfaceFrame(
  revision: number,
  frame: FrameData,
  panes = DEFAULT_PANES,
): Buffer {
  const w = new BinWriter();
  w.variant(13);
  w.string("boot-1");
  w.varint(1);
  w.varint(revision);
  writeFrame(w, frame);
  w.varint(panes.length);
  for (const pane of panes)
    writePane(
      w,
      pane.paneId,
      pane.x,
      0,
      pane.mouseReporting,
      pane.rect,
      pane.innerRect,
    );
  w.varint(0);
  w.bool(false);
  return w.toBuffer();
}

function controlFrame(kind: string, data: string): Buffer {
  const w = new BinWriter();
  w.variant(20);
  w.string(kind);
  w.string(data);
  return w.toBuffer();
}

const WELCOME = {
  generation: 1,
  server_version: "0.9.0",
  snapshot_codec: "shell.snapshot.v1",
  surface_codec: "shell.surface.v1",
  input_codec: "shell.input.semantic.v1",
  blob_codec: "shell.blob.v1",
  methods: ["pane.focus", "pane.scroll"],
  capabilities: ["health_check"],
};

/**
 * Fake endpoint server that answers the handshake, sends a snapshot, answers
 * endpoint requests, and streams a two-pane surface.
 */
async function startSessionServer(handlers: {
  onRequest?: (method: string, params: any, connection: number) => unknown;
  methods?: string[] | ((connection: number) => string[]);
  capabilities?: (connection: number) => string[];
  onPaneInput?: (paneId: string, reader: BinReader) => void;
  panes?: TestPane[];
  onConnection?: (sendSurface: (panes: TestPane[]) => void) => void;
  onClipboardConnection?: (send: (data: string) => void) => void;
  onDisconnectConnection?: (disconnect: () => void) => void;
  initialSurface?: { frame: FrameData; panes: TestPane[] };
  surfaceForHello?: (
    cols: number,
    rows: number,
  ) => { frame: FrameData; panes: TestPane[] };
  onResize?: (
    cols: number,
    rows: number,
    send: (frame: FrameData, panes: TestPane[]) => void,
  ) => void;
}) {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-eps-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const frame: FrameData = {
    // Tab surface 10x5; pane w1:p1 inner rect is 1,1 8x3 => "abcdefgh" rows.
    cells: Array.from({ length: handlers.panes ? 100 : 50 }, (_, i) =>
      cell(String.fromCharCode(65 + (i % 26))),
    ),
    width: handlers.panes ? 20 : 10,
    height: 5,
    cursor: { x: 2, y: 2, visible: true, shape: 1 },
    hyperlinks: [],
  };
  let connectionSeq = 0;
  const server = net.createServer((socket) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      expect(["EPIPE", "ECONNRESET"]).toContain(error.code ?? "");
    });
    const connection = ++connectionSeq;
    handlers.onDisconnectConnection?.(() => socket.destroy());
    handlers.onClipboardConnection?.((data) => {
      const w = new BinWriter();
      w.variant(5);
      w.string(data);
      socket.write(encodeFrame(w.toBuffer()));
    });
    let input = Buffer.alloc(0);
    let greeted = false;
    let revision = 1;
    handlers.onConnection?.((panes) =>
      socket.write(encodeFrame(surfaceFrame(++revision, frame, panes))),
    );
    socket.on("data", (chunk) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      while (input.length >= 4) {
        const length = input.readUInt32LE(0);
        if (input.length < length + 4) return;
        const reader = new BinReader(input.subarray(4, length + 4));
        input = input.subarray(length + 4);
        const variant = reader.variant();
        if (!greeted) {
          greeted = true;
          reader.string(); // kind
          const hello = JSON.parse(reader.string());
          const initialSurface =
            handlers.surfaceForHello?.(
              hello.surface_size.cols,
              hello.surface_size.rows,
            ) ?? handlers.initialSurface;
          socket.write(
            encodeFrame(
              controlFrame(
                "endpoint.welcome.v1",
                JSON.stringify({
                  ...WELCOME,
                  capabilities:
                    handlers.capabilities?.(connection) ?? WELCOME.capabilities,
                  methods:
                    typeof handlers.methods === "function"
                      ? handlers.methods(connection)
                      : (handlers.methods ?? WELCOME.methods),
                }),
              ),
            ),
          );
          socket.write(
            encodeFrame(
              controlFrame(
                "shell.snapshot.v1",
                JSON.stringify({ boot_id: "boot-1", revision: 1 }),
              ),
            ),
          );
          socket.write(
            encodeFrame(
              surfaceFrame(
                1,
                initialSurface?.frame ?? frame,
                initialSurface?.panes ?? handlers.panes,
              ),
            ),
          );
          continue;
        }
        if (variant === 15) {
          // ClientShellEndpointRequest
          reader.string(); // boot_id
          const request = JSON.parse(reader.string());
          void Promise.resolve()
            .then(() =>
              handlers.onRequest?.(request.method, request.params, connection),
            )
            .then(
              (result) => sendResponse({ result: result ?? {} }),
              (error) => sendResponse({ error: { message: String(error) } }),
            );
          function sendResponse(response: object) {
            const w = new BinWriter();
            w.variant(18);
            w.string("boot-1");
            w.string(request.id);
            w.bool(true);
            w.bytes(
              Buffer.from(JSON.stringify({ id: request.id, ...response })),
            );
            socket.write(encodeFrame(w.toBuffer()));
          }
        } else if (variant === 12) {
          reader.varint(); // cell_width_px
          reader.varint(); // cell_height_px
          const cols = reader.varint();
          const rows = reader.varint();
          handlers.onResize?.(cols, rows, (nextFrame, panes) =>
            socket.write(
              encodeFrame(surfaceFrame(++revision, nextFrame, panes)),
            ),
          );
        } else if (variant === 13) {
          const paneId = reader.string();
          handlers.onPaneInput?.(paneId, reader);
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

function splitSurface(cols: number, rows: number, count = 2) {
  const frame: FrameData = {
    width: cols,
    height: rows,
    cells: Array.from({ length: cols * rows }, () => cell("x")),
    cursor: null,
    hyperlinks: [],
  };
  const panes = Array.from({ length: count }, (_, index) => {
    const x = Math.floor((cols * index) / count);
    const width = Math.floor((cols * (index + 1)) / count) - x;
    return {
      paneId: `w1:p${index + 1}`,
      x,
      mouseReporting: false,
      rect: { x, y: 0, width, height: rows },
      innerRect: { x: x + 1, y: 1, width: width - 3, height: rows - 2 },
    };
  });
  return { frame, panes };
}

describe("EndpointTerminalSession", () => {
  test.each([
    { cols: 252, rows: 26, count: 3, expected: [249, 26] },
    { cols: 166, rows: 27, count: 2, expected: [166, 26] },
  ])("corrects a one-cell overshoot ($cols x $rows)", async (initial) => {
    const resizes: number[][] = [];
    const socketPath = await startSessionServer({
      surfaceForHello: (cols, rows) => splitSurface(cols, rows, initial.count),
      onResize: (cols, rows, send) => {
        resizes.push([cols, rows]);
        const next = splitSurface(cols, rows, initial.count);
        send(next.frame, next.panes);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
    );
    const frames: Array<{ width: number; height: number }> = [];
    session.on("terminal", (frame) => frames.push(frame));
    try {
      await session.connect(80, 24, { cols: initial.cols, rows: initial.rows });
      await until("80x24 frame", () =>
        frames.some((frame) => frame.width === 80 && frame.height === 24),
      );
      await sleep(60); // observation window: no further correction after convergence
      expect(resizes).toEqual([[...initial.expected]]);
      expect(frames.at(-1)).toMatchObject({ width: 80, height: 24 });
    } finally {
      session.close();
    }
  });

  test.each([
    [2, 0],
    [2, 1],
    [3, 1],
  ])(
    "first visible frame fits a %i-way split pane %i without an extra viewer resize",
    async (count, index) => {
      const cols = count === 3 ? 135 : 134;
      const initial = splitSurface(cols, 69, count);
      const requested = Promise.withResolvers<() => void>();
      const socketPath = await startSessionServer({
        initialSurface: initial,
        onResize: (cols, rows, send) => {
          const settled = splitSurface(cols, rows, count);
          send(initial.frame, initial.panes);
          requested.resolve(() => send(settled.frame, settled.panes));
        },
      });
      const { revisions, logger } = surfaceLog();
      const session = new EndpointTerminalSession(
        socketPath,
        "terminal",
        async () => initial.panes[index].paneId,
        logger,
      );
      const frames: Array<{ width: number; height: number }> = [];
      session.on("terminal", (frame) => frames.push(frame));
      fakeProductTimers();
      try {
        // Fake timers silence the product's connect timeouts; bound it here.
        await untilSettled("connect", session.connect(cols, 69));
        const settle = await untilSettled("resize request", requested.promise);
        await until("stale surface", () => revisions.includes(2));
        vi.advanceTimersByTime(60);
        expect(frames).toEqual([]);
        settle();
        await until("settled frame", () => frames.length > 0);
        expect(frames).toEqual([
          expect.objectContaining({ width: cols, height: 69 }),
        ]);
        vi.advanceTimersByTime(550);
        expect(frames).toHaveLength(1); // no stale timer repaint
      } finally {
        session.close();
        vi.useRealTimers();
      }
    },
  );

  test("continuous stale frames cannot extend the first-frame deadline", async () => {
    const initial = splitSurface(134, 69);
    const requested = Promise.withResolvers<(reporting: boolean) => void>();
    const socketPath = await startSessionServer({
      initialSurface: initial,
      onResize: (_cols, _rows, send) =>
        requested.resolve((reporting) =>
          send(
            initial.frame,
            initial.panes.map((pane) => ({
              ...pane,
              mouseReporting: reporting,
            })),
          ),
        ),
    });
    const { revisions, logger } = surfaceLog();
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
      logger,
    );
    const frames: Array<{ width: number; mouseReporting: boolean }> = [];
    session.on("terminal", (frame) => frames.push(frame));
    fakeProductTimers();
    try {
      // Fake timers silence the product's connect timeouts; bound it here.
      await untilSettled("connect", session.connect(134, 69));
      const send = await untilSettled("resize request", requested.promise);
      expect(frames).toEqual([]);
      for (let i = 0; i < 7; i++) {
        send(true);
        await until(`stale surface ${i + 1}`, () => revisions.includes(i + 2));
        vi.advanceTimersByTime(100);
      }
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)).toEqual(
        expect.objectContaining({ width: 64, mouseReporting: true }),
      );
      send(false);
      await until("mouseReporting false frame", () => revisions.includes(9));
      expect(frames.at(-1)?.mouseReporting).toBe(false);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  });

  test.each(["local", "remote"])(
    "%s close cancels a pending first frame",
    async (side) => {
      const initial = splitSurface(134, 69);
      const requested = Promise.withResolvers<void>();
      let disconnect!: () => void;
      const socketPath = await startSessionServer({
        initialSurface: initial,
        onDisconnectConnection: (close) => {
          disconnect = close;
        },
        onResize: () => requested.resolve(),
      });
      const session = new EndpointTerminalSession(
        socketPath,
        "terminal",
        async () => "w1:p1",
      );
      const frames: unknown[] = [];
      session.on("terminal", (frame) => frames.push(frame));
      try {
        await session.connect(134, 69);
        await requested.promise;
        expect(frames).toEqual([]);
        if (side === "local") session.close();
        else disconnect();
        await sleep(600);
        expect(session.isClosed).toBe(true);
        expect(frames).toEqual([]);
      } finally {
        session.close();
      }
    },
  );
  test.each([
    ["single pane", 1, 1, 0, 1],
    ["stacked panes", 1, 0.5, 2, 3],
    ["three stacked panes", 1, 1 / 3, 2, 3],
    ["side-by-side panes", 0.5, 1, 2, 3],
    ["unequal nested splits", 0.3, 0.25, 2, 3],
  ] as const)(
    "fits pane content through a full-tab surface: %s",
    async (_name, widthRatio, heightRatio, rowChrome, colChrome) => {
      const makeSurface = (cols: number, rows: number) => {
        const rect = {
          x: 0,
          y: 0,
          width: Math.floor(cols * widthRatio),
          height: Math.floor(rows * heightRatio),
        };
        const innerRect = {
          x: colChrome > 1 ? 1 : 0,
          y: rowChrome > 0 ? 1 : 0,
          width: rect.width - colChrome,
          height: rect.height - rowChrome,
        };
        return {
          frame: {
            width: cols,
            height: rows,
            cells: Array.from({ length: cols * rows }, () => cell(" ")),
            cursor: null,
            hyperlinks: [],
          } satisfies FrameData,
          panes: [
            { paneId: "w1:p1", x: 0, mouseReporting: false, rect, innerRect },
          ],
        };
      };
      const resizes: Array<[number, number]> = [];
      const initial = makeSurface(100, 30);
      const socketPath = await startSessionServer({
        initialSurface: initial,
        onResize: (cols, rows, send) => {
          resizes.push([cols, rows]);
          // A queued old surface must not cause another correction.
          send(initial.frame, initial.panes);
          const next = makeSurface(cols, rows);
          send(next.frame, next.panes);
        },
      });
      const session = new EndpointTerminalSession(
        socketPath,
        "term_1",
        async () => "w1:p1",
      );
      const waitForSize = (width: number, height: number) => {
        let seen = false;
        const onFrame = (frame: { width: number; height: number }) => {
          if (frame.width === width && frame.height === height) seen = true;
        };
        session.on("terminal", onFrame);
        return until(`${width}x${height} frame`, () => seen, 2000).finally(
          () => session.off("terminal", onFrame),
        );
      };
      try {
        await session.connect(100, 30);
        // The viewer attach drives convergence: one targeted resize, at
        // most one rounding follow-up, and the crop lands on the pane size.
        const resized = waitForSize(81, 25);
        session.resize(81, 25);
        await resized;
        // Boot correction + the attach resize + at most one rounding
        // follow-up; never an iterative chase.
        expect(resizes.length).toBeLessThanOrEqual(3);
        const refreshed = waitForSize(81, 25);
        session.resize(81, 25);
        await refreshed;
      } finally {
        session.close();
      }
    },
  );

  test("defers pane fitting while surfaces lack the pane", async () => {
    // Focus transits through tabs that do not contain the pane. Resizing
    // from those foreign geometries reflows the whole tab and shows up as
    // panes first rendering narrow, then expanding.
    const other = {
      frame: {
        width: 48,
        height: 12,
        cells: Array.from({ length: 48 * 12 }, () => cell(" ")),
        cursor: null,
        hyperlinks: [],
      } satisfies FrameData,
      panes: [
        {
          paneId: "w1:other",
          x: 0,
          mouseReporting: false,
          rect: { x: 0, y: 0, width: 48, height: 12 },
          innerRect: { x: 0, y: 1, width: 47, height: 11 },
        },
      ],
    };
    const own = {
      frame: {
        width: 120,
        height: 40,
        cells: Array.from({ length: 120 * 40 }, () => cell(" ")),
        cursor: null,
        hyperlinks: [],
      } satisfies FrameData,
      panes: [
        {
          paneId: "w1:p1",
          x: 0,
          mouseReporting: false,
          rect: { x: 0, y: 0, width: 120, height: 40 },
          innerRect: { x: 0, y: 1, width: 119, height: 39 },
        },
      ],
    };
    const resizes: Array<[number, number]> = [];
    const socketPath = await startSessionServer({
      initialSurface: other,
      onResize: (cols, rows, send) => {
        resizes.push([cols, rows]);
        send(own.frame, own.panes);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async () => "w1:p1",
      silentLogger,
      150,
    );
    const frames: Array<{ width: number; height: number }> = [];
    session.on("terminal", (t) => frames.push(t));
    try {
      // The foreign surface never contains the pane, so connect times out
      // rather than fitting against the wrong tab geometry.
      await expect(session.connect(119, 39)).rejects.toThrow(
        "timed out waiting for endpoint surface",
      );
      // No resize may derive from the foreign 48x12 geometry.
      expect(resizes).toEqual([]);
      expect(frames).toEqual([]);
    } finally {
      session.close();
    }
  });

  test("ignores stale surfaces while a viewer resize is in flight", async () => {
    // Split-pane attach: the viewer asks for the settled pane size while the
    // server still streams pre-resize frames. Fitting against that stale
    // ratio reflows the whole tab away from the requested size.
    const makeSurface = (cols: number, rows: number, innerW: number) => ({
      frame: {
        width: cols,
        height: rows,
        cells: Array.from({ length: cols * rows }, () => cell(" ")),
        cursor: null,
        hyperlinks: [],
      } satisfies FrameData,
      panes: [
        {
          paneId: "w1:p1",
          x: 0,
          mouseReporting: false,
          rect: { x: 0, y: 0, width: Math.floor(cols / 2), height: rows },
          innerRect: { x: 0, y: 1, width: innerW, height: rows - 2 },
        },
      ],
    });
    const stale = makeSurface(134, 69, 64); // pre-resize split geometry
    const settled = makeSurface(136, 70, 133); // after applying 136x70
    const resizes: Array<[number, number]> = [];
    const socketPath = await startSessionServer({
      initialSurface: stale,
      onResize: (cols, rows, send) => {
        resizes.push([cols, rows]);
        send(stale.frame, stale.panes); // in-flight stale frames
        if (cols === 136 && rows === 70) send(settled.frame, settled.panes);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async () => "w1:p1",
    );
    try {
      await session.connect(134, 69);
      session.resize(134, 69);
      await sleep(100);
      // The attach resize carries the wanted pane size once; stale frames
      // arriving while it is in flight must not trigger another resize.
      expect(resizes.length).toBeLessThanOrEqual(2);
      expect(resizes.every(([c, r]) => c === 274 && r === 71)).toBe(true);
    } finally {
      session.close();
    }
  });

  test("focuses the pane and emits cropped ANSI terminal frames", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const socketPath = await startSessionServer({
      onRequest: (method, params) => requests.push({ method, params }),
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async (terminalId) => (terminalId === "term_1" ? "w1:p1" : null),
    );
    const frames: Array<{
      width: number;
      height: number;
      full: boolean;
      text: string;
    }> = [];
    session.on("terminal", (t) =>
      frames.push({
        width: t.width,
        height: t.height,
        full: t.full,
        text: t.bytes.toString("utf8"),
      }),
    );
    await session.connect(80, 24);

    expect(requests).toEqual([
      { method: "pane.focus", params: { pane_id: "w1:p1" } },
    ]);
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0];
    expect(first.width).toBe(8);
    expect(first.height).toBe(3);
    expect(first.full).toBe(true);
    // Cropped content: inner rect starts at (1,1) of the 10x5 grid,
    // so the first row is cells 11-18 (L..S).
    expect(first.text).toContain("LMNOPQRS");
    // Cursor was at (2,2) in tab space -> (1,1) in crop space.
    expect(first.text).toContain("\x1b[2;2H");
    session.close();
  });

  test("rejects connect when the terminal has no pane", async () => {
    const socketPath = await startSessionServer({});
    const session = new EndpointTerminalSession(
      socketPath,
      "term_x",
      async () => null,
    );
    await expect(session.connect(80, 24)).rejects.toThrow("no pane found");
  });

  test("classifies input and sends pane.scroll with absolute offsets", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const inputs: string[] = [];
    const socketPath = await startSessionServer({
      onRequest: (method, params) => requests.push({ method, params }),
      onPaneInput: (paneId, reader) => {
        expect(paneId).toBe("w1:p1");
        const count = reader.varint();
        for (let i = 0; i < count; i++) {
          const v = reader.variant();
          if (v === 1) inputs.push(`text:${reader.string()}`);
          else if (v === 3) inputs.push(`paste:${reader.string()}`);
          else inputs.push(`key:${v}`);
        }
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async () => "w1:p1",
    );
    await session.connect(80, 24);
    session.input(Buffer.from("hi"));
    session.scroll("up", 3);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(inputs).toContain("text:hi");
    expect(requests).toContainEqual({
      method: "pane.scroll",
      params: { pane_id: "w1:p1", offset_from_bottom: 3 },
    });
    session.close();
  });
});

test("endpoint mouse stays pane-local and mode changes route application input versus history", async () => {
  const panes: TestPane[] = [
    { paneId: "w1:p1", x: 0, mouseReporting: false },
    { paneId: "w1:p2", x: 10, mouseReporting: true },
  ];
  const inputs: Array<{
    paneId: string;
    kind: number;
    column: number;
    row: number;
  }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const senders: Array<(panes: TestPane[]) => void> = [];
  const socketPath = await startSessionServer({
    panes,
    onConnection: (send) => senders.push(send),
    onRequest: (method, params) => requests.push({ method, params }),
    onPaneInput: (paneId, reader) => {
      const count = reader.varint();
      for (let i = 0; i < count; i++) {
        expect(reader.variant()).toBe(2);
        const kind = reader.variant();
        if (kind <= 2) reader.variant();
        expect(reader.variant()).toBe(0);
        const column = reader.varint();
        const row = reader.varint();
        expect(reader.bool()).toBe(false);
        reader.u8();
        reader.varint();
        inputs.push({ paneId, kind, column, row });
      }
    },
  });
  const left = new EndpointTerminalSession(
    socketPath,
    "term-left",
    async () => "w1:p1",
  );
  const right = new EndpointTerminalSession(
    socketPath,
    "term-right",
    async () => "w1:p2",
  );
  const modes: boolean[] = [];
  right.on("terminal", (frame) => modes.push(frame.mouseReporting));
  try {
    // These input fixtures have fixed 8x3 content, not a resizing layout.
    await left.connect(8, 3);
    await right.connect(8, 3);
    const clickDragWheel = Buffer.from(
      "\x1b[<0;2;3M\x1b[<32;3;2M\x1b[<0;3;2m\x1b[<64;8;3M",
    );
    left.input(clickDragWheel); // no mouse reporting in this pane
    right.input(clickDragWheel);
    right.input(Buffer.from("\x1b[<0;9;1M\x1b[<0;1;4M")); // outside 8x3 crop
    right.scroll("down", 3, 1, 2);
    left.scroll("up", 3, 1, 2);
    await sleep(40);
    expect(inputs).toEqual([
      { paneId: "w1:p2", kind: 0, column: 1, row: 2 },
      { paneId: "w1:p2", kind: 2, column: 2, row: 1 },
      { paneId: "w1:p2", kind: 1, column: 2, row: 1 },
      { paneId: "w1:p2", kind: 4, column: 7, row: 2 },
      { paneId: "w1:p2", kind: 5, column: 1, row: 2 },
    ]);
    expect(requests).toContainEqual({
      method: "pane.scroll",
      params: { pane_id: "w1:p1", offset_from_bottom: 3 },
    });
    // Disable reporting mid-report; no stale mouse is delivered after the mode change.
    right.input(Buffer.from("\x1b[<0;"));
    const disabled = panes.map((pane) => ({ ...pane, mouseReporting: false }));
    for (const send of senders) send(disabled);
    await sleep(40);
    right.input(Buffer.from("2;3M"));
    right.scroll("up", 4, 1, 2);
    right.scroll("up", Number.NaN);
    await sleep(40);
    expect(inputs).toHaveLength(5);
    expect(modes).toContain(true);
    expect(modes.at(-1)).toBe(false);
    expect(requests).toContainEqual({
      method: "pane.scroll",
      params: { pane_id: "w1:p2", offset_from_bottom: 4 },
    });
    for (const send of senders) send(panes);
    await sleep(40);
    right.input(Buffer.from("\x1b[<0;1;1M"));
    left.input(Buffer.from("\x1b[<0;1;1M"));
    await sleep(40);
    expect(inputs.at(-1)).toEqual({
      paneId: "w1:p2",
      kind: 0,
      column: 0,
      row: 0,
    });
    expect(inputs).toHaveLength(6);
  } finally {
    left.close();
    right.close();
  }
});

test("accepted presses retain clamped drag and release ownership outside the pane crop", async () => {
  const panes: TestPane[] = [
    { paneId: "w1:p1", x: 0, mouseReporting: true },
    { paneId: "w1:p2", x: 10, mouseReporting: true },
  ];
  const inputs: Array<{
    paneId: string;
    kind: number;
    column: number;
    row: number;
  }> = [];
  let sendSurface!: (panes: TestPane[]) => void;
  const socketPath = await startSessionServer({
    panes,
    onConnection: (send) => {
      sendSurface = send;
    },
    onPaneInput: (paneId, reader) => {
      const count = reader.varint();
      for (let i = 0; i < count; i++) {
        expect(reader.variant()).toBe(2);
        const kind = reader.variant();
        reader.variant(); // button
        expect(reader.variant()).toBe(0);
        const column = reader.varint(),
          row = reader.varint();
        reader.bool();
        reader.u8();
        reader.varint();
        inputs.push({ paneId, kind, column, row });
      }
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "right",
    async () => "w1:p2",
  );
  try {
    await session.connect(20, 5);
    session.input(Buffer.from("\x1b[<0;8;3M\x1b[<32;9;3M\x1b[<0;9;3m"));
    await sleep(40);
    expect(inputs).toEqual(
      [0, 2, 1].map((kind) => ({ paneId: "w1:p2", kind, column: 7, row: 2 })),
    );
    session.input(Buffer.from("\x1b[<0;9;3M\x1b[<32;8;3M\x1b[<0;8;3m"));
    await sleep(40);
    expect(inputs).toHaveLength(3); // an outside press cannot acquire ownership
    session.input(Buffer.from("\x1b[<0;8;3M"));
    await sleep(40);
    sendSurface(panes.map((pane) => ({ ...pane, mouseReporting: false })));
    await sleep(40);
    sendSurface(panes);
    await sleep(40);
    session.input(Buffer.from("\x1b[<32;9;3M\x1b[<0;9;3m"));
    await sleep(40);
    expect(inputs).toHaveLength(4); // mode changes cancel gesture ownership
  } finally {
    session.close();
  }
});


describe("cropFrame", () => {
  test("crops cells and repositions the cursor", () => {
    const frame: FrameData = {
      cells: Array.from({ length: 12 }, (_, i) => cell(String(i))),
      width: 4,
      height: 3,
      cursor: { x: 2, y: 1, visible: true, shape: 0 },
      hyperlinks: ["https://example.com"],
    };
    const cropped = cropFrame(frame, { x: 1, y: 1, width: 2, height: 2 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    expect(cropped.cells.map((c) => c.symbol)).toEqual(["5", "6", "9", "10"]);
    expect(cropped.cursor).toEqual({ x: 1, y: 0, visible: true, shape: 0 });
    expect(cropped.hyperlinks).toEqual(["https://example.com"]);
  });

  test("drops an out-of-crop cursor and clamps the rect", () => {
    const frame: FrameData = {
      cells: Array.from({ length: 4 }, () => cell("x")),
      width: 2,
      height: 2,
      cursor: { x: 0, y: 0, visible: true, shape: 0 },
      hyperlinks: [],
    };
    const cropped = cropFrame(frame, { x: 1, y: 1, width: 99, height: 99 });
    expect(cropped.width).toBe(1);
    expect(cropped.height).toBe(1);
    expect(cropped.cursor).toBeNull();
  });
});
