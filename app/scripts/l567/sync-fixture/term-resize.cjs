var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var term_resize_exports = {};
__export(term_resize_exports, {
  SYNC_OUTPUT_BEGIN: () => SYNC_OUTPUT_BEGIN,
  SYNC_OUTPUT_END: () => SYNC_OUTPUT_END,
  resizeToFrame: () => resizeToFrame,
  viewportOffBottom: () => viewportOffBottom,
  writeFrame: () => writeFrame
});
module.exports = __toCommonJS(term_resize_exports);
const SYNC_OUTPUT_BEGIN = "\x1B[?2026h";
const SYNC_OUTPUT_END = "\x1B[?2026l";
function viewportOffBottom(term) {
  const buffer = term.buffer.active;
  return buffer.baseY !== 0 || buffer.viewportY !== buffer.baseY;
}
function resizeToFrame(term, size) {
  if (term.cols === size.cols && term.rows === size.rows) return false;
  term.resize(size.cols, size.rows);
  if (!viewportOffBottom(term)) return false;
  term.clear();
  return true;
}
function writeFrame(term, input) {
  if (term.cols === input.cols && term.rows === input.rows) {
    term.write(input.data, input.done);
    return;
  }
  term.write(SYNC_OUTPUT_BEGIN, () => {
    if (!input.alive()) return;
    resizeToFrame(term, input);
    term.write(input.data + SYNC_OUTPUT_END, input.done);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SYNC_OUTPUT_BEGIN,
  SYNC_OUTPUT_END,
  resizeToFrame,
  viewportOffBottom,
  writeFrame
});
