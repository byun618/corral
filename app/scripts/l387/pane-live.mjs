// Supplemental live-backend verification. SSR is NOT the C-P10 Electron GUI gate.
// Run from app after preparing the isolated session described in raw/codex/DONE.md:
// npx esbuild scripts/l387/pane-live.mjs --bundle --platform=node --format=esm \
//   --packages=external --loader:.png=dataurl --jsx=automatic --outfile=out/pane-live.mjs
// XDG_CONFIG_HOME=/private/tmp/l387codex/config node out/pane-live.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionLink, closePane } from "../../src/main/adapter/index.js";
import { attachDigests, buildSkeleton, collectSessionRefs, joinTree } from "../../src/main/tree.js";
import { readSessionDigests } from "../../src/main/transcript.js";
import { WorktreeBlock } from "../../src/renderer/src/components/WorktreeBlock.js";
import { StatusBar } from "../../src/renderer/src/components/StatusBar.js";
import { agentPanes } from "../../src/renderer/src/session-title.js";
const session = "life387-pane-verify-codex";
const root = "/private/tmp/l387codex/repo";
const config = "/private/tmp/l387codex/config";
assert.equal(process.env.XDG_CONFIG_HOME, config, "Never target the user\u2019s herdr config");
const socketPath = `${config}/herdr/sessions/${session}/herdr.sock`;
const raw = path.resolve("../specs/LIFE-387-split-ux/raw/codex");
const save = (name, data) => fs.writeFileSync(path.join(raw, name), JSON.stringify(data, null, 2) + "\n");
const oracle = (...args) => JSON.parse(execFileSync("herdr", ["--session", session, ...args], { encoding: "utf8" }));
const waitFor = async (condition) => {
  const deadline = Date.now() + 15e3;
  while (!condition()) {
    assert(Date.now() < deadline, "live state did not converge");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const link = new SessionLink({ onChange: () => {
} });
try {
  save("live-oracle-before.json", {
    at: (/* @__PURE__ */ new Date()).toISOString(),
    session,
    tabs: oracle("tab", "list"),
    panes: oracle("pane", "list"),
    agents: oracle("agent", "list"),
    firstProcess: oracle("pane", "process-info", "--pane", "w1:p1"),
    secondProcess: oracle("pane", "process-info", "--pane", "w1:p2")
  });
  link.open({ name: session, isDefault: false, running: true, socketPath });
  await waitFor(() => link.linkState().phase === "live" && link.store.rows()[0]?.tabs[0]?.panes.length === 2);
  const before = link.store.rows();
  assert.equal(before.length, 1);
  assert.equal(before[0]?.tabs.length, 1);
  assert.equal(agentPanes(before[0].tabs).length, 2);
  const reads = readSessionDigests(collectSessionRefs(before));
  const skeleton = await buildSkeleton({ roots: [root], socketPath });
  const tree = joinTree(skeleton, attachDigests(before, reads.digests));
  save("live-app-tree.json", tree);
  const worktree = tree.repos[0].worktrees[0];
  assert(worktree.workspace, "actual workspace must join the registered scratch repo");
  const noop = () => {
  };
  const sidebar = renderToStaticMarkup(createElement(WorktreeBlock, {
    worktree,
    selected: true,
    selectedPane: "w1:p2",
    groupGlyph: null,
    integrations: [],
    home: "",
    now: Date.now(),
    groupCollapsed: false,
    onToggleGroup: noop,
    onSelectBlock: noop,
    onSelectSession: noop,
    onCloseSession: noop,
    onCloseWorktree: noop,
    onCreateShell: noop,
    onCreateAgent: noop
  }));
  const statusbar = renderToStaticMarkup(createElement(StatusBar, {
    activeWorktreeLabel: "pane-verification",
    dirtyTotal: 0,
    aheadTotal: 0,
    behindTotal: 0,
    groupCount: 1,
    paneCount: 2,
    zoomed: false,
    agentCount: agentPanes(worktree.workspace.tabs).length,
    termSize: null,
    memoryLabel: null
  }));
  const ids = [...sidebar.matchAll(/class="session-row [^"]*" data-tab="([^"]+)" data-pane="([^"]+)"/g)].map((match) => ({ tab: match[1], pane: match[2] }));
  assert.deepEqual(ids, [{ tab: "w1:t1", pane: "w1:p1" }, { tab: "w1:t1", pane: "w1:p2" }]);
  assert(statusbar.includes("2 agents"));
  fs.writeFileSync(path.join(raw, "live-render.html"), sidebar + "\n" + statusbar + "\n");
  save("live-render-result.json", {
    at: (/* @__PURE__ */ new Date()).toISOString(),
    kind: "live SessionLink + tree + React SSR, not Electron GUI",
    rows: ids,
    rowCount: ids.length,
    statusbar,
    guiVerified: false,
    agentState: "Real Claude foreground processes; isolated config onboarding, no model task submitted"
  });
  assert.equal((await closePane({ socketPath, paneId: "w1:p2" })).outcome, "ok");
  await waitFor(() => link.store.rows()[0]?.tabs[0]?.panes.length === 1);
  const afterOne = link.store.rows();
  assert.equal(afterOne[0].tabs[0].panes[0].paneId, "w1:p1");
  save("live-close-one.json", { appRows: afterOne, oracle: oracle("pane", "list"), tabs: oracle("tab", "list") });
  assert.equal((await closePane({ socketPath, paneId: "w1:p1" })).outcome, "ok");
  await waitFor(() => link.store.rows().length === 0);
  save("live-close-last.json", { appRows: link.store.rows(), oracle: oracle("pane", "list"), tabs: oracle("tab", "list") });
  console.log("PASS supplemental live backend: 1 tab / 2 real agents / 2 sidebar SSR rows / 2 agents; close one preserves sibling; close last removes tab.");
  console.log("C-P10 GUI remains unverified: Electron aborts before app.whenReady in this environment.");
} finally {
  link.close();
}
