import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
// =========================
// Backend API endpoints
// =========================
const API_LIST = "/api/list";
const API_FILE = "/api/file";
const API_SEARCH = "/api/search";
const API_NOTE_CREATE = "/api/note";
const API_TEXT_WRITE = "/api/write-text";
// Client "root" path - your backend can interpret "/" however you want
const DEFAULT_PATH = "/";

// =========================
// State (editor-like)
// =========================
const state = {
  mode: "normal",   // "normal" | "command" | "search" | "insert"
  cmd: "",
  cmdErr: "",
  search: "",
  searchErr: "",

  nextId: 1,
  freeIds: [],
  focusId: null,
  root: null,
  windows: new Map(),
  pdfCache: new Map(),
  nextPdfToken: 1,
  awaitingSecondG: false,
};

// Window object shape:
// {
//   id: number,
//   kind: "empty" | "explorer" | "viewer",
//   title: string,
//   explorer?: { cwd, items, cursor, loading, err },
//   viewer?: { path, contentType, objectUrl, text }
// }

// Split tree node:
// - Leaf: { type:"leaf", winId:number }
// - Split: { type:"split", dir:"v"|"h", a:node, b:node }

// =========================
// Utility helpers
// =========================
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

function joinPath(base, name){
  if (!base || base === "/") return "/" + name;
  if (base.endsWith("/")) return base + name;
  return base + "/" + name;
}

function parentPath(p){
  if (!p || p === "/") return "/";
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function getFocusedWin(){
  return state.windows.get(state.focusId) || null;
}

function dropPdfCache(winId){
  if (winId == null) return;
  const entry = state.pdfCache.get(winId);
  if (entry?.el){
    entry.el.remove();
  }
  state.pdfCache.delete(winId);
}

function makePdfCacheKey(viewer){
  if (!viewer) return "";
  const zoom = viewer.pdfZoom || 1.25;
  const token = viewer.pdfToken || 0;
  const path = viewer.path || "";
  return `${path}::${token}::${zoom.toFixed(2)}`;
}

function setMode(mode){
  state.mode = mode;
  document.getElementById("modePill").textContent = mode.toUpperCase();

  if (mode === "command"){
    setPrompt(":");
    showCmdline();
  } else if (mode === "search"){
    setPrompt("/");
    showCmdline();
  } else {
    hideCmdline();
  }
}

function showCmdline(){
  const el = document.getElementById("cmdline");
  el.classList.remove("hidden");
  updateCmdline();
}

function hideCmdline(){
  const el = document.getElementById("cmdline");
  el.classList.add("hidden");
  state.cmdErr = "";
  updateCmdline();
}

function updateCmdline(){
  document.getElementById("cmdtext").textContent =
    state.mode === "search" ? state.search : state.cmd;
  document.getElementById("cmderr").textContent =
    state.mode === "search" ? state.searchErr : (state.cmdErr || "");
}

function setGlobalHint(text){
  document.getElementById("globalHint").textContent = text || "";
}

// =========================
// Vim-style editor helpers
// =========================
function makeVimState(){
  return {
    mode: "normal",
    pendingKey: "",
    countBuffer: "",
    registerText: "",
    registerLinewise: false,
    desiredCol: null,
  };
}

function ensureVimState(ed){
  if (!ed.vim) ed.vim = makeVimState();
  return ed.vim;
}

function editorClampPos(textarea, pos){
  return clamp(pos, 0, textarea.value.length);
}

function editorSetCaret(ed, textarea, pos){
  const next = editorClampPos(textarea, pos);
  textarea.selectionStart = textarea.selectionEnd = next;
  ed.selectionStart = next;
  ed.selectionEnd = next;
}

function editorSyncSelection(ed, textarea){
  ed.selectionStart = textarea.selectionStart;
  ed.selectionEnd = textarea.selectionEnd;
}

function editorApplyEdit(ed, textarea, start, end, insertText, cursorPos){
  const value = textarea.value;
  const s = clamp(start, 0, value.length);
  const e = clamp(end, s, value.length);
  const before = value.slice(0, s);
  const after = value.slice(e);
  const nextValue = before + insertText + after;
  textarea.value = nextValue;
  const nextCursor =
    typeof cursorPos === "number"
      ? clamp(cursorPos, 0, nextValue.length)
      : s + insertText.length;
  textarea.selectionStart = textarea.selectionEnd = nextCursor;
  ed.text = nextValue;
  ed.dirty = true;
  ed.selectionStart = nextCursor;
  ed.selectionEnd = nextCursor;
}

function editorLineStart(text, pos){
  if (pos <= 0) return 0;
  const idx = text.lastIndexOf("\n", pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

function editorLineEnd(text, pos){
  if (!text.length) return 0;
  const idx = text.indexOf("\n", pos);
  return idx === -1 ? text.length : idx;
}

function editorLineEndInclusive(text, pos){
  if (!text.length) return 0;
  const idx = text.indexOf("\n", pos);
  return idx === -1 ? text.length : idx + 1;
}

function editorMoveHorizontal(ed, textarea, dir, count){
  let pos = textarea.selectionStart;
  const limit = textarea.value.length;
  for (let i = 0; i < count; i++){
    pos = clamp(pos + dir, 0, Math.max(limit - 1, 0));
  }
  editorSetCaret(ed, textarea, pos);
  ensureVimState(ed).desiredCol = null;
}

function editorMoveToLineBoundary(ed, textarea, which){
  const text = textarea.value;
  const pos = textarea.selectionStart;
  const start = editorLineStart(text, pos);
  const end = editorLineEnd(text, pos);
  if (which === "start"){
    editorSetCaret(ed, textarea, start);
  } else {
    const target = end > start ? end - 1 : end;
    editorSetCaret(ed, textarea, target);
  }
  ensureVimState(ed).desiredCol = null;
}

function editorMoveToFileEdge(ed, textarea, edge){
  const len = textarea.value.length;
  if (!len){
    editorSetCaret(ed, textarea, 0);
    return;
  }
  const target = edge === "start" ? 0 : len - 1;
  editorSetCaret(ed, textarea, target);
  ensureVimState(ed).desiredCol = null;
}

function editorGoToLine(ed, textarea, lineNumber){
  const text = textarea.value;
  if (!text.length){
    editorSetCaret(ed, textarea, 0);
    ensureVimState(ed).desiredCol = null;
    return;
  }
  const targetLine = Math.max(1, lineNumber);
  let idx = 0;
  let current = 1;
  while (current < targetLine){
    const next = text.indexOf("\n", idx);
    if (next === -1){
      idx = text.length - 1;
      break;
    }
    idx = next + 1;
    current++;
  }
  editorSetCaret(ed, textarea, idx);
  ensureVimState(ed).desiredCol = null;
}

function isWordChar(ch){
  return /\S/.test(ch || "");
}

function moveWordForwardOnce(text, pos){
  const len = text.length;
  if (!len) return 0;
  let i = Math.min(pos + 1, len - 1);
  while (i < len && !/\s/.test(text[i])) i++;
  while (i < len && /\s/.test(text[i])) i++;
  if (i >= len) return len - 1;
  return i;
}

function moveWordBackwardOnce(text, pos){
  const len = text.length;
  if (!len) return 0;
  let i = clamp(pos, 0, len - 1);

  if (!/\s/.test(text[i]) && i > 0 && /\s/.test(text[i - 1])){
    i--;
  }

  if (/\s/.test(text[i])){
    while (i > 0 && /\s/.test(text[i])) i--;
  }

  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

function editorMoveWord(ed, textarea, dir, count){
  let pos = textarea.selectionStart;
  const text = textarea.value;
  for (let step = 0; step < count; step++){
    if (dir > 0){
      pos = moveWordForwardOnce(text, pos);
    } else {
      pos = moveWordBackwardOnce(text, pos);
    }
  }
  editorSetCaret(ed, textarea, pos);
  ensureVimState(ed).desiredCol = null;
}

function editorMoveLines(ed, textarea, dir, count){
  const vim = ensureVimState(ed);
  const text = textarea.value;
  if (!text.length) return;
  let pos = textarea.selectionStart;
  let desired = vim.desiredCol;
  if (desired == null){
    desired = pos - editorLineStart(text, pos);
  }

  for (let i = 0; i < count; i++){
    if (dir > 0){
      const next = editorLineEndInclusive(text, pos);
      if (next >= text.length){
        pos = text.length - 1;
        break;
      }
      pos = next;
    } else {
      if (pos === 0) break;
      const prevLineEnd = editorLineStart(text, pos - 1);
      pos = prevLineEnd;
    }
  }

  const lineStart = editorLineStart(text, pos);
  const lineEnd = editorLineEnd(text, pos);
  const available = Math.max(lineEnd - lineStart - 1, 0);
  const offset = Math.min(desired, available);
  const rawTarget = lineStart + (available > 0 ? offset : 0);
  const maxTarget = Math.max(lineEnd - 1, lineStart);
  editorSetCaret(ed, textarea, clamp(rawTarget, lineStart, maxTarget));
  vim.desiredCol = desired;
}

function editorDeleteChars(ed, textarea, count){
  if (count <= 0) return;
  const pos = textarea.selectionStart;
  if (pos >= textarea.value.length) return;
  editorApplyEdit(ed, textarea, pos, pos + count, "", pos);
  ensureVimState(ed).desiredCol = null;
}

function editorDeleteLines(ed, textarea, count){
  const text = textarea.value;
  if (!text.length) return;
  const pos = textarea.selectionStart;
  let start = editorLineStart(text, pos);
  let end = start;
  for (let i = 0; i < count; i++){
    end = editorLineEndInclusive(text, end);
  }
  if (end <= start){
    end = text.length;
  }
  const removed = text.slice(start, end);
  const vim = ensureVimState(ed);
  vim.registerText = removed;
  vim.registerLinewise = true;
  const removedLen = end - start;
  const nextLen = Math.max(text.length - removedLen, 0);
  const nextCursor = Math.min(start, Math.max(nextLen - 1, 0));
  editorApplyEdit(ed, textarea, start, end, "", nextCursor);
  vim.desiredCol = null;
}

function editorYankLines(ed, textarea, count){
  const text = textarea.value;
  if (!text.length) return;
  const pos = textarea.selectionStart;
  let start = editorLineStart(text, pos);
  let end = start;
  for (let i = 0; i < count; i++){
    end = editorLineEndInclusive(text, end);
  }
  if (end <= start) end = editorLineEndInclusive(text, pos);
  const vim = ensureVimState(ed);
  vim.registerText = text.slice(start, end);
  vim.registerLinewise = true;
  setGlobalHint(`${count} line${count === 1 ? "" : "s"} yanked`);
}

function editorPasteRegister(ed, textarea){
  const vim = ensureVimState(ed);
  const clip = vim.registerText || "";
  if (!clip) return;
  const isLinewise = vim.registerLinewise;
  const pos = textarea.selectionStart;
  const text = textarea.value;
  let insertPos = pos;
  if (isLinewise){
    insertPos = editorLineEndInclusive(text, pos);
  } else {
    insertPos = Math.min(pos + 1, text.length);
  }
  editorApplyEdit(ed, textarea, insertPos, insertPos, clip, isLinewise ? insertPos : insertPos + clip.length - 1);
  vim.desiredCol = null;
}

function editorInsertNewLine(ed, textarea, above){
  const text = textarea.value;
  const pos = textarea.selectionStart;
  const target = above ? editorLineStart(text, pos) : editorLineEndInclusive(text, pos);
  editorApplyEdit(ed, textarea, target, target, "\n", target);
  ensureVimState(ed).desiredCol = null;
  enterEditorInsertMode(ed, textarea);
}

function enterEditorInsertMode(ed, textarea){
  const vim = ensureVimState(ed);
  vim.mode = "insert";
  vim.pendingKey = "";
  vim.countBuffer = "";
  vim.desiredCol = null;
  setMode("insert");
  setGlobalHint("EDITOR INSERT — Esc returns to NORMAL");
}

function enterEditorNormalMode(ed, textarea, opts = {}){
  const vim = ensureVimState(ed);
  if (opts.fromInsert && textarea.selectionStart === textarea.selectionEnd && textarea.selectionStart > 0){
    editorSetCaret(ed, textarea, textarea.selectionStart - 1);
  } else {
    editorSyncSelection(ed, textarea);
  }
  vim.mode = "normal";
  vim.pendingKey = "";
  vim.countBuffer = "";
  vim.desiredCol = null;
  setMode("normal");
  setGlobalHint("EDITOR NORMAL — i insert · : command · Esc twice to leave");
}

function consumeVimCount(vim){
  if (!vim.countBuffer) return 1;
  const parsed = parseInt(vim.countBuffer, 10);
  vim.countBuffer = "";
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function handleEditorKeydown(ev, textarea, ed, winId){
  const vim = ensureVimState(ed);
  if (vim.mode === "insert"){
    if (ev.key === "Escape"){
      ev.preventDefault();
      enterEditorNormalMode(ed, textarea, { fromInsert: true });
    }
    return;
  }

  // normal mode
  if (ev.key === "Escape"){
    ev.preventDefault();
    textarea.blur();
    if (winId != null) focusPaneByWinId(winId);
    setMode("normal");
    setGlobalHint("");
    return;
  }

  if (ev.key === ":" && !vim.pendingKey){
    ev.preventDefault();
    state.cmd = "";
    state.cmdErr = "";
    setMode("command");
    setGlobalHint("");
    textarea.blur();
    if (winId != null) focusPaneByWinId(winId);
    return;
  }

  if (/^[1-9]$/.test(ev.key)){
    vim.countBuffer += ev.key;
    ev.preventDefault();
    return;
  }
  if (ev.key === "0" && vim.countBuffer){
    vim.countBuffer += "0";
    ev.preventDefault();
    return;
  }

  if (vim.pendingKey === "g"){
    if (ev.key === "g"){
      ev.preventDefault();
      const count = consumeVimCount(vim);
      vim.pendingKey = "";
      if (count > 1){
        editorGoToLine(ed, textarea, count);
      } else {
        editorMoveToFileEdge(ed, textarea, "start");
      }
      return;
    }
    if (ev.key === "G"){
      ev.preventDefault();
      consumeVimCount(vim);
      vim.pendingKey = "";
      editorMoveToFileEdge(ed, textarea, "end");
      return;
    }
    vim.pendingKey = "";
    vim.countBuffer = "";
  }

  if (vim.pendingKey === "d"){
    if (ev.key === "d"){
      ev.preventDefault();
      const count = consumeVimCount(vim);
      vim.pendingKey = "";
      editorDeleteLines(ed, textarea, count);
      return;
    }
    vim.pendingKey = "";
    vim.countBuffer = "";
  }

  if (vim.pendingKey === "y"){
    if (ev.key === "y"){
      ev.preventDefault();
      const count = consumeVimCount(vim);
      vim.pendingKey = "";
      editorYankLines(ed, textarea, count);
      return;
    }
    vim.pendingKey = "";
    vim.countBuffer = "";
  }

  if (ev.key === "g" && !vim.pendingKey){
    ev.preventDefault();
    vim.pendingKey = "g";
    return;
  }
  if (ev.key === "d" && !vim.pendingKey){
    ev.preventDefault();
    vim.pendingKey = "d";
    return;
  }
  if (ev.key === "y" && !vim.pendingKey){
    ev.preventDefault();
    vim.pendingKey = "y";
    return;
  }

  const count = consumeVimCount(vim);
  switch (ev.key){
    case "h":
      ev.preventDefault();
      editorMoveHorizontal(ed, textarea, -1, count);
      return;
    case "l":
      ev.preventDefault();
      editorMoveHorizontal(ed, textarea, +1, count);
      return;
    case "j":
      ev.preventDefault();
      editorMoveLines(ed, textarea, +1, count);
      return;
    case "k":
      ev.preventDefault();
      editorMoveLines(ed, textarea, -1, count);
      return;
    case "w":
      ev.preventDefault();
      editorMoveWord(ed, textarea, +1, count);
      return;
    case "b":
      ev.preventDefault();
      editorMoveWord(ed, textarea, -1, count);
      return;
    case "0":
      ev.preventDefault();
      editorMoveToLineBoundary(ed, textarea, "start");
      return;
    case "$":
      ev.preventDefault();
      editorMoveToLineBoundary(ed, textarea, "end");
      return;
    case "G":
      ev.preventDefault();
      if (count > 1){
        editorGoToLine(ed, textarea, count);
      } else {
        editorMoveToFileEdge(ed, textarea, "end");
      }
      return;
    case "x":
      ev.preventDefault();
      editorDeleteChars(ed, textarea, count);
      return;
    case "p":
      ev.preventDefault();
      for (let i = 0; i < count; i++){
        editorPasteRegister(ed, textarea);
      }
      return;
    case "i":
      ev.preventDefault();
      enterEditorInsertMode(ed, textarea);
      return;
    case "a":
      ev.preventDefault();
      editorSetCaret(ed, textarea, Math.min(textarea.selectionStart + 1, textarea.value.length));
      ensureVimState(ed).desiredCol = null;
      enterEditorInsertMode(ed, textarea);
      return;
    case "I":
      ev.preventDefault();
      {
        const text = textarea.value;
        const pos = textarea.selectionStart;
        const start = editorLineStart(text, pos);
        const lineEnd = editorLineEnd(text, pos);
        let target = start;
        while (target < lineEnd && (text[target] === " " || text[target] === "\t")){
          target++;
        }
        editorSetCaret(ed, textarea, target);
      }
      enterEditorInsertMode(ed, textarea);
      return;
    case "A":
      ev.preventDefault();
      {
        const text = textarea.value;
        const pos = textarea.selectionStart;
        const end = editorLineEnd(text, pos);
        editorSetCaret(ed, textarea, end);
      }
      enterEditorInsertMode(ed, textarea);
      return;
    case "o":
      ev.preventDefault();
      editorInsertNewLine(ed, textarea, false);
      return;
    case "O":
      ev.preventDefault();
      editorInsertNewLine(ed, textarea, true);
      return;
    case "y":
      // Already handled for yy via pending
      return;
    case "d":
      // Already handled for dd via pending
      return;
    case "g":
      // Already handled above
      return;
    default:
      return;
  }
}

// =========================
// Tree operations
// =========================
function makeWindow(kind){
  const id = state.freeIds.length ? state.freeIds.shift() : state.nextId++;
  const w = { id, kind, title: "", lastViewerPath: null };

  if (kind === "empty"){
    w.title = "No buffer";
  } else if (kind === "explorer"){
    w.title = "Explorer";
    w.explorer = { cwd: DEFAULT_PATH, items: [], cursor: 0, loading: false, err: "" };
  } else if (kind === "viewer"){
    w.title = "Viewer";
    w.viewer = { path: "", contentType: "", objectUrl: null, text: "" };
    w.lastViewerPath = w.viewer.path || null;
  }

  state.windows.set(id, w);
  if (state.focusId == null) state.focusId = id;
  return w;
}

function makeLeaf(winId){
  return { type:"leaf", winId };
}

function makeSplit(dir, a, b){
  return { type:"split", dir, a, b, wA: 1, wB: 1 };
}

function findLeafPath(node, targetWinId, path = []){
  // returns array of nodes along path; last element is the leaf node itself
  if (!node) return null;
  if (node.type === "leaf"){
    return node.winId === targetWinId ? [...path, node] : null;
  }
  const left = findLeafPath(node.a, targetWinId, [...path, node]);
  if (left) return left;
  return findLeafPath(node.b, targetWinId, [...path, node]);
}

function clampWeight(x){
  // keep panes from collapsing too much
  return Math.max(0.25, Math.min(8, x));
}

function scrollFocusedViewer(deltaLines){
  const w = getFocusedWin();
  if (!w || w.kind !== "viewer") return false;

  const pane = document.querySelector(`[data-win="${w.id}"]`);
  if (!pane) return false;

  const content = pane.querySelector(".content");
  if (!content) return false;

  const px = deltaLines * 48;
  content.scrollBy({ top: px, behavior: "auto" });
  return true;
}

function scrollFocusedViewerXY(dx, dy){
  const w = getFocusedWin();
  if (!w || w.kind !== "viewer") return false;

  const pane = document.querySelector(`[data-win="${w.id}"]`);
  if (!pane) return false;

  const content = pane.querySelector(".content");
  if (!content) return false;

  content.scrollBy({ left: dx, top: dy, behavior: "auto" });
  return true;
}

function resizeFocused(dir, delta){
  const focusedId = state.focusId;
  if (!focusedId) return;

  const path = findLeafPath(state.root, focusedId);
  if (!path) return;

  // Walk upward from leaf to root to find nearest split of the right direction
  // path looks like: [split, split, ..., leaf]
  for (let i = path.length - 2; i >= 0; i--){
    const node = path[i];
    if (node.type !== "split") continue;
    if (node.dir !== dir) continue;

    const child = path[i + 1]; // this is the subtree we came from (either node.a or node.b)
    const focusedIsA = (node.a === child);

    // If focused pane should "grow", increase its weight, decrease sibling (or vice versa)
    if (focusedIsA){
      node.wA = clampWeight((node.wA ?? 1) + delta);
      node.wB = clampWeight((node.wB ?? 1) - delta);
    } else {
      node.wB = clampWeight((node.wB ?? 1) + delta);
      node.wA = clampWeight((node.wA ?? 1) - delta);
    }

    render();
    return;
  }

  setGlobalHint(`No ${dir === "v" ? "vertical" : "horizontal"} split to resize near focused window.`);
}

function splitFocused(dir){
  const focusedId = state.focusId;
  if (!focusedId) return;

  const newWin = makeWindow("empty");
  const root = state.root;
  const leafPath = findLeafPath(root, focusedId);
  if (!leafPath) return;

  const leaf = leafPath[leafPath.length - 1];
  // Replace that leaf with a split node: existing on a, new on b
  const newNode = makeSplit(dir, makeLeaf(leaf.winId), makeLeaf(newWin.id));

  // Patch into tree
  if (leafPath.length === 1){
    state.root = newNode;
  } else {
    const parent = leafPath[leafPath.length - 2];
    // parent is split
    if (parent.a === leaf) parent.a = newNode;
    else parent.b = newNode;
  }

  // Focus stays on original, like vim (you can change if you want)
  state.focusId = focusedId;
  render();
  setGlobalHint(`${dir === "v" ? "Vertical" : "Horizontal"} split created (new window ${newWin.id}).`);
}

function collectLeafIds(node, out = []){
  if (!node) return out;
  if (node.type === "leaf"){ out.push(node.winId); return out; }
  collectLeafIds(node.a, out);
  collectLeafIds(node.b, out);
  return out;
}

function removeFocusedWindow(){
  const focusedId = state.focusId;
  if (!focusedId) return;

  // Don't remove the last remaining window
  const leafIds = collectLeafIds(state.root);
  if (leafIds.length <= 1){
    setGlobalHint("Cannot close the last window.");
    return;
  }

  // Find path to leaf
  const leafPath = findLeafPath(state.root, focusedId);
  if (!leafPath || leafPath.length < 2){
    setGlobalHint("Internal: couldn't find window in tree.");
    return;
  }

  const leaf = leafPath[leafPath.length - 1];
  const parent = leafPath[leafPath.length - 2]; // split node
  const sibling = (parent.a === leaf) ? parent.b : parent.a;

  // Replace parent with sibling in grandparent
  if (leafPath.length === 2){
    // parent is root
    state.root = sibling;
  } else {
    const grand = leafPath[leafPath.length - 3];
    if (grand.a === parent) grand.a = sibling;
    else grand.b = sibling;
  }

  // Cleanup resources (blob URLs)
  const w = state.windows.get(focusedId);
  if (w?.kind === "viewer" && w.viewer?.objectUrl){
    URL.revokeObjectURL(w.viewer.objectUrl);
  }
  if (w?.kind === "editor" && state.mode === "insert"){
    setMode("normal");
  }
  dropPdfCache(focusedId);

  state.windows.delete(focusedId);
  state.freeIds.push(focusedId);
  state.freeIds.sort((a, b) => a - b);

  // Choose a new focus: first leaf id
  const newLeafIds = collectLeafIds(state.root);
  state.focusId = newLeafIds[0] || null;

  render();
  setGlobalHint(`Closed window ${focusedId}.`);
}

function focusWindow(id){
  if (!state.windows.has(id)) return;

  const prev = state.focusId;
  state.focusId = id;

  // update focused CSS class
  if (prev != null) {
    const prevPane = document.querySelector(`[data-win="${prev}"]`);
    if (prevPane) prevPane.classList.remove("focused");
  }
  const newPane = document.querySelector(`[data-win="${id}"]`);
  if (newPane) newPane.classList.add("focused");

  // update "FOCUS" label in statusline
  document.querySelectorAll(".statusRight span").forEach(span => {
    span.textContent = "";
  });
  if (newPane) {
    const focusSpan = newPane.querySelector(".statusRight span");
    if (focusSpan) focusSpan.textContent = "FOCUS";
  }

  setGlobalHint(`Focused window ${id}.`);
}

// =========================
// Backend calls
// =========================
async function fetchListing(path){
  const url = new URL(API_LIST, window.location.origin);
  url.searchParams.set("path", path);
  const res = await fetch(url.toString(), { method:"GET" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchFile(path){
  const url = new URL(API_FILE, window.location.origin);
  url.searchParams.set("path", path);
  const res = await fetch(url.toString(), { method:"GET" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  const contentType = res.headers.get("Content-Type") || "application/octet-stream";
  const blob = await res.blob();
  return { blob, contentType, url: url.toString() };
}

async function createNoteOnServer(dir, name){
  const payload = { dir };
  if (name) payload.name = name;
  const res = await fetch(API_NOTE_CREATE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    let msg = txt;
    try{
      const parsed = JSON.parse(txt);
      if (parsed?.error) msg = parsed.error;
    } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

async function writeTextFile(path, content){
  const res = await fetch(API_TEXT_WRITE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    let msg = txt;
    try{
      const parsed = JSON.parse(txt);
      if (parsed?.error) msg = parsed.error;
    } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

// =========================
// Window actions
// =========================
async function ensureExplorerInFocused(){
  const w = getFocusedWin();
  if (!w) return;

  if (w.kind !== "explorer"){
    // If viewer had a blob, cleanup
    if (w.kind === "viewer" && w.viewer?.objectUrl){
      URL.revokeObjectURL(w.viewer.objectUrl);
    }
    if (w.kind === "viewer"){
      if (w.viewer?.path){
        w.lastViewerPath = w.viewer.path;
      }
      dropPdfCache(w.id);
    }
    if (w.kind === "editor"){
      setMode("normal");
      const backCwd =
        w.editor?.returnToCwd ||
        (w.editor?.path ? parentPath(w.editor.path) : null) ||
        DEFAULT_PATH;
      delete w.editor;
      w.explorer = { cwd: backCwd, items: [], cursor: 0, loading: false, err: "" };
      w.kind = "explorer";
      w.title = "Explorer";
    }
    // Convert window to explorer
    w.kind = "explorer";
    w.title = "Explorer";
    w.explorer = { cwd: DEFAULT_PATH, items: [], cursor: 0, loading: false, err: "" };
    delete w.viewer;
  }

  // Load listing if empty
  if (w.explorer.items.length === 0 && !w.explorer.loading){
    await loadExplorerListing(w, w.explorer.cwd);
  } else {
    render();
  }
}

async function loadExplorerListing(win, cwd){
  win.explorer.loading = true;
  win.explorer.err = "";
  win.explorer.cwd = cwd;
  render();

  try{
    const data = await fetchListing(cwd);
    const items = Array.isArray(data.items) ? data.items : [];
    // Sort: dirs first, then files, alpha
    items.sort((a,b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

    win.explorer.items = items;
    win.explorer.cursor = clamp(win.explorer.cursor, 0, Math.max(0, items.length - 1));
    win.explorer.loading = false;
    render();
    setGlobalHint(`Explorer loaded: ${data.path ?? cwd}`);
  } catch(err){
    win.explorer.loading = false;
    win.explorer.err = err.message || "Failed to load directory";
    render();
    setGlobalHint(`Explorer error: ${win.explorer.err}`);
  }
}

async function explorerMove(delta){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer") return;
  const n = w.explorer.items.length;
  if (n === 0) return;
  w.explorer.cursor = clamp(w.explorer.cursor + delta, 0, n - 1);
  render();
  scrollCursorIntoView(w.id);
}

function explorerJumpToEdge(edge){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer") return;
  const n = w.explorer.items.length;
  if (n === 0) return;

  const idx = edge === "end" ? n - 1 : 0;
  w.explorer.cursor = idx;
  render();
  scrollCursorIntoView(w.id);
  setGlobalHint(edge === "end" ? "Bottom of list" : "Top of list");
}

function scrollCursorIntoView(winId){
  const container = document.querySelector(`[data-win="${winId}"] .content`);
  if (!container) return;
  const sel = container.querySelector(`.entry.selected`);
  if (!sel) return;
  const selRect = sel.getBoundingClientRect();
  const contRect = container.getBoundingClientRect();
  if (selRect.top < contRect.top){
    sel.scrollIntoView({ block:"nearest" });
  } else if (selRect.bottom > contRect.bottom){
    sel.scrollIntoView({ block:"nearest" });
  }
}

async function explorerEnter(){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer") return;

  const items = w.explorer.items;
  if (!items.length) return;

  const cur = items[w.explorer.cursor];
  if (!cur) return;

  // If this item came from search results, it has an absolute path
  if (cur.fullPath){
    if (cur.type === "dir"){
      await loadExplorerListing(w, cur.fullPath);
      return;
    }
    await openFileInWindow(w.id, cur.fullPath);
    return;
  }

  // Normal explorer listing path logic
  if (cur.type === "dir"){
    const next = joinPath(w.explorer.cwd, cur.name);
    await loadExplorerListing(w, next);
    return;
  }

  await openFileInWindow(w.id, joinPath(w.explorer.cwd, cur.name));
}

async function explorerUp(){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer") return;
  const up = parentPath(w.explorer.cwd);
  await loadExplorerListing(w, up);
}

async function openFileInWindow(winId, filePath){
  const w = state.windows.get(winId);
  if (!w) return;

  dropPdfCache(winId);

  // Cleanup old viewer state
  if (w.kind === "viewer" && w.viewer?.objectUrl){
    URL.revokeObjectURL(w.viewer.objectUrl);
  }

  w.kind = "viewer";
  w.title = "Viewer";
  w.viewer = {
    path: filePath,
    contentType: "",
    objectUrl: null,
    text: "",
    pdfBlob: null,
    pdfZoom: 1.25,
    pdfToken: 0,
  };
  w.lastViewerPath = filePath;
  delete w.explorer;

  render();
  focusPaneByWinId(winId);
  setGlobalHint(`Opening ${filePath}…`);

  try{
    const { blob, contentType } = await fetchFile(filePath);
    w.viewer.contentType = contentType;

    const ct = (contentType || "").toLowerCase();

    if (ct.includes("application/pdf")) {
      w.viewer.pdfBlob = blob;       // store the Blob, not ArrayBuffer
      w.viewer.pdfToken = state.nextPdfToken++;

      render();
      focusPaneByWinId(winId);
      setGlobalHint(`Opened ${filePath}`);
      return;
    }

    // Text
    if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")){
      w.viewer.text = await blob.text();
      render();
      focusPaneByWinId(winId);
      setGlobalHint(`Opened ${filePath}`);
      return;
    }

    // Other binary: provide blob URL (optional)
    w.viewer.objectUrl = URL.createObjectURL(blob);
    render();
    focusPaneByWinId(winId);
    setGlobalHint(`Opened ${filePath}`);
  } catch(err){
    w.viewer.text = `Failed to open file:\n${err.message || err}`;
    w.viewer.contentType = "text/plain";
    render();
    focusPaneByWinId(winId);
    setGlobalHint(`Open failed: ${err.message || err}`);
  }
}

function openEditorInWindow(win, filePath, text, returnCwd){
  if (!win) return;

  if (win.kind === "viewer" && win.viewer?.objectUrl){
    URL.revokeObjectURL(win.viewer.objectUrl);
  }
  if (win.kind === "viewer"){
    dropPdfCache(win.id);
  }

  const cwd =
    returnCwd ||
    (win.kind === "explorer" ? win.explorer.cwd : null) ||
    (filePath ? parentPath(filePath) : DEFAULT_PATH) ||
    DEFAULT_PATH;

  win.kind = "editor";
  win.title = "Editor";
  win.editor = {
    path: filePath,
    text: text ?? "",
    returnToCwd: cwd,
    dirty: false,
    saving: false,
    err: "",
    selectionStart: (text ?? "").length,
    selectionEnd: (text ?? "").length,
    scrollTop: 0,
    shouldFocus: true,
    vim: makeVimState(),
  };
  delete win.explorer;
  delete win.viewer;

  render();
  focusPaneByWinId(win.id);
  setGlobalHint(`EDITOR NORMAL — i insert · :w saves · :wq saves & quits · Esc twice leaves editor`);
}

async function exitEditorToExplorer(win){
  if (!win || win.kind !== "editor") return;
  const cwd =
    win.editor?.returnToCwd ||
    (win.editor?.path ? parentPath(win.editor.path) : null) ||
    DEFAULT_PATH;

  delete win.editor;
  win.kind = "explorer";
  win.title = "Explorer";
  win.explorer = { cwd, items: [], cursor: 0, loading: false, err: "" };
  setMode("normal");
  render();
  await loadExplorerListing(win, cwd);
}

// =========================
// Rendering
// =========================
function render(){
  const ws = document.getElementById("workspace");
  ws.innerHTML = "";
  if (!state.root){
    ws.innerHTML = `<div class="emptyMsg">Internal error: no root.</div>`;
    return;
  }
  ws.appendChild(renderNode(state.root));
  updateCmdline();
  updateModePill();

  // After DOM is built, render all PDFs from state
  for (const w of state.windows.values()) {
    if (w.kind !== "viewer") continue;
    const v = w.viewer;
    const ct = (v.contentType || "").toLowerCase();
    if (!ct.includes("application/pdf") || !v.pdfBlob) {
      dropPdfCache(w.id);
      continue;
    }

    const pane = document.querySelector(`[data-win="${w.id}"]`);
    if (!pane) continue;
    const content = pane.querySelector(".content");
    if (!content) continue;

    const zoom = v.pdfZoom || 1.25;
    const cacheKey = makePdfCacheKey(v);
    const cached = state.pdfCache.get(w.id);

    if (cached && cached.key === cacheKey && cached.el){
      content.appendChild(cached.el);
      continue;
    }

    dropPdfCache(w.id);
    renderPdfInto(w.id, content, v.pdfBlob, zoom, cacheKey);
  }
}

function updateModePill(){
  document.getElementById("modePill").textContent = state.mode.toUpperCase();
}

function renderNode(node){
  if (node.type === "leaf"){
    const w = state.windows.get(node.winId);
    return renderPane(w);
  }

  const el = document.createElement("div");
  el.className = `split ${node.dir}`;
  const childA = renderNode(node.a);
  const childB = renderNode(node.b);

  // flex-grow weights control how much space each side gets
  childA.style.flexGrow = String(node.wA ?? 1);
  childB.style.flexGrow = String(node.wB ?? 1);

  el.appendChild(childA);
  el.appendChild(childB);
  return el;
}

function focusPaneByWinId(winId) {
  requestAnimationFrame(() => {
    const pane = document.querySelector(`[data-win="${winId}"]`);
    if (pane) pane.focus();
  });
}

function renderPane(w){
  const pane = document.createElement("div");
  pane.tabIndex = 0;
  pane.className = "pane" + (w.id === state.focusId ? " focused" : "");
  pane.dataset.win = String(w.id);

  // click focus
  pane.addEventListener("mousedown", () => {
    if (state.focusId !== w.id){
      state.focusId = w.id;
      render();
    }
  });

  const status = document.createElement("div");
  status.className = "statusline";

  const left = document.createElement("div");
  left.className = "statusLeft";

  const wid = document.createElement("div");
  wid.className = "wid";
  wid.textContent = String(w.id);

  const wtype = document.createElement("div");
  wtype.className = "wtype " + w.kind;
  wtype.textContent =
    w.kind === "explorer" ? "EXPLORER" :
    w.kind === "viewer" ? "VIEWER" :
    w.kind === "editor" ? "EDITOR" : "EMPTY";

  const title = document.createElement("div");
  title.className = "wtitle";

  if (w.kind === "explorer"){
    title.textContent = w.explorer.cwd;
  } else if (w.kind === "viewer"){
    title.textContent = w.viewer.path || "No file";
  } else if (w.kind === "editor"){
    title.textContent = w.editor.path || "New note";
  } else {
    title.textContent = "No buffer";
  }

  left.appendChild(wid);
  left.appendChild(wtype);
  left.appendChild(title);

  const right = document.createElement("div");
  right.className = "statusRight";
  right.innerHTML = `<span>${state.focusId === w.id ? "FOCUS" : ""}</span>`;

  status.appendChild(left);
  status.appendChild(right);

  const content = document.createElement("div");
  content.className = "content" + (w.kind === "editor" ? " editorMode" : "");

  if (w.kind === "empty"){
    content.innerHTML = `
      <div class="emptyMsg">
        <div style="margin-bottom:10px;"><strong>Empty window</strong></div>
        <div style="margin-bottom:8px;">Try:</div>
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
          <span class="kbd">Ctrl+N</span> <span class="kbd">:</span> <span class="kbd">vspl</span> <span class="kbd">spl</span> <span class="kbd">q</span>
        </div>
        <div>Focus windows with <span class="kbd">Ctrl+1</span>…<span class="kbd">Ctrl+9</span>.</div>
      </div>
    `;
  }

  if (w.kind === "explorer"){
    const ex = w.explorer;
    const header = document.createElement("div");
    header.className = "explorerHeader";
    header.innerHTML = `
      <div class="cwd">${escapeHtml(ex.cwd)}</div>
      <div class="smallHint">${ex.loading ? "loading…" : (ex.err ? "error" : "j/k, Enter")}</div>
    `;

    content.appendChild(header);

    if (ex.err){
      const err = document.createElement("div");
      err.className = "emptyMsg";
      err.style.borderColor = "rgba(239,68,68,0.35)";
      err.innerHTML = `<div style="color: rgba(239,68,68,0.9); font-weight:700; margin-bottom:6px;">Explorer error</div>
                       <div style="white-space:pre-wrap;">${escapeHtml(ex.err)}</div>`;
      content.appendChild(err);
    } else if (ex.loading && ex.items.length === 0){
      const msg = document.createElement("div");
      msg.className = "emptyMsg";
      msg.textContent = "Loading directory…";
      content.appendChild(msg);
    } else if (ex.items.length === 0){
      const msg = document.createElement("div");
      msg.className = "emptyMsg";
      msg.textContent = "Empty directory.";
      content.appendChild(msg);
    } else {
      const list = document.createElement("div");
      list.className = "list";

      ex.items.forEach((it, idx) => {
        const row = document.createElement("div");
        row.className = "entry" + (idx === ex.cursor ? " selected" : "");
        const iconText = it.type === "dir" ? "DIR" : "FILE";
        row.innerHTML = `
          <div class="icon ${it.type}">${iconText}</div>
          <div class="name">${escapeHtml(it.name)}</div>
          <div class="meta">${it.type}</div>
        `;

        // mouse click selects + double click enters/opens
        row.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ex.cursor = idx;
          state.focusId = w.id;
          render();
        });
        row.addEventListener("dblclick", async () => {
          ex.cursor = idx;
          state.focusId = w.id;
          render();
          await explorerEnter();
        });

        list.appendChild(row);
      });

      content.appendChild(list);
    }
  }

  if (w.kind === "viewer") {
    const v = w.viewer;
    const ct = (v.contentType || "").toLowerCase();

    if (ct.includes("application/pdf")) {
      // Leave content empty here; render() will call renderPdfInto()
      // once the whole layout is built.
    } else if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || v.text) {
      const pre = document.createElement("pre");
      pre.textContent = v.text || "";
      content.appendChild(pre);
    } else if (v.objectUrl) {
      const frame = document.createElement("iframe");
      frame.title = "File preview";
      frame.src = v.objectUrl;
      frame.tabIndex = -1;
      content.appendChild(frame);
    } else {
      const msg = document.createElement("div");
      msg.className = "emptyMsg";
      msg.textContent = "No preview available.";
      content.appendChild(msg);
    }
  }

  if (w.kind === "editor"){
    const ed = w.editor;
    ensureVimState(ed);
    const wrap = document.createElement("div");
    wrap.className = "noteEditorWrap";

    const info = document.createElement("div");
    info.className = "noteEditorInfo";
    info.innerHTML = `
      <div class="notePath">${escapeHtml(ed.path || "(new note)")}</div>
      <div class="noteHint">Esc → command · :w saves · :wq saves & closes</div>
    `;
    wrap.appendChild(info);

    if (ed.err){
      const err = document.createElement("div");
      err.className = "noteEditorError";
      err.textContent = ed.err;
      wrap.appendChild(err);
    }

    const textarea = document.createElement("textarea");
    textarea.className = "noteEditor";
    textarea.value = ed.text || "";
    textarea.spellcheck = false;

    textarea.addEventListener("input", () => {
      ed.text = textarea.value;
      ed.dirty = true;
      ed.selectionStart = textarea.selectionStart;
      ed.selectionEnd = textarea.selectionEnd;
      ensureVimState(ed).desiredCol = null;
    });

    const recordSelection = () => {
      ed.selectionStart = textarea.selectionStart;
      ed.selectionEnd = textarea.selectionEnd;
    };

    textarea.addEventListener("select", recordSelection);
    textarea.addEventListener("keyup", recordSelection);
    textarea.addEventListener("click", recordSelection);
    textarea.addEventListener("scroll", () => {
      ed.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener("focus", () => {
      const vim = ensureVimState(ed);
      if (vim.mode === "insert"){
        setMode("insert");
        setGlobalHint("EDITOR INSERT — Esc returns to NORMAL");
      } else {
        setMode("normal");
        setGlobalHint("EDITOR NORMAL — i insert · : command");
      }
    });

    textarea.addEventListener("blur", () => {
      const vim = ensureVimState(ed);
      vim.countBuffer = "";
      vim.pendingKey = "";
      vim.desiredCol = null;
      if (state.mode !== "command" && state.mode !== "search"){
        setMode("normal");
        setGlobalHint("");
      }
    });

    textarea.addEventListener("keydown", (ev) => {
      handleEditorKeydown(ev, textarea, ed, w.id);
    });

    wrap.appendChild(textarea);
    content.appendChild(wrap);

    requestAnimationFrame(() => {
      if (ed.shouldFocus){
        textarea.focus();
        ed.shouldFocus = false;
      }
      if (typeof ed.selectionStart === "number" && typeof ed.selectionEnd === "number"){
        textarea.selectionStart = ed.selectionStart;
        textarea.selectionEnd = ed.selectionEnd;
      }
      if (typeof ed.scrollTop === "number"){
        textarea.scrollTop = ed.scrollTop;
      }
    });
  }

  pane.appendChild(status);
  pane.appendChild(content);
  return pane;
}

// =========================
// Command execution
// =========================
function commandError(msg){
  state.cmdErr = msg;
  updateCmdline();
  setGlobalHint(msg);
}

async function execCommand(raw){
  const cmd = (raw || "").trim();
  state.cmdErr = "";
  updateCmdline();

  if (!cmd){
    setGlobalHint("");
    return;
  }

  // Simple commands: q, spl, vspl
  if (cmd === "q"){
    removeFocusedWindow();
    return;
  }
  if (cmd === "spl"){
    splitFocused("h");
    return;
  }
  if (cmd === "vspl"){
    splitFocused("v");
    return;
  }

  // Numeric command: focus window by ID
  if (/^\d+$/.test(cmd)){
    const id = Number(cmd);
    if (state.windows.has(id)){
      focusWindow(id);
      setMode("normal");
      setGlobalHint(`Jumped to window ${id}`);
      return;
    }
    commandError(`E94: No window ${id}`);
    return;
  }

  const parts = cmd.split(/\s+/);
  const name = parts[0];
  const rest = parts.slice(1).join(" ").trim();

  if (name === "note"){
    try{
      await runNoteCommand(rest);
    } catch (err){
      commandError(err.message || "Failed to create note");
    }
    return;
  }

  if (name === "e"){
    try{
      await runEditCommand(rest);
    } catch (err){
      commandError(err.message || "Failed to open file");
    }
    return;
  }

  if (name === "w" && parts.length === 1){
    try{
      await runWriteCommand();
    } catch (err){
      commandError(err.message || "Failed to write file");
    }
    return;
  }

  if (name === "wq" && parts.length === 1){
    try{
      await runWriteCommand({ exitAfterSave: true });
    } catch (err){
      commandError(err.message || "Failed to write file");
    }
    return;
  }

  commandError(`E492: Not an editor command: ${cmd}`);
}

function getFocusedExplorerForCommand(){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer"){
    throw new Error("E348: Focus an explorer window first");
  }
  return w;
}

function parseNoteArg(raw){
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"")){
    if (trimmed.length < 2 || !trimmed.endsWith("\"")){
      throw new Error("E114: Missing closing quote for note name");
    }
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
  }
  return trimmed;
}

async function runNoteCommand(arg){
  const w = getFocusedExplorerForCommand();
  const cwd = w.explorer.cwd;
  const name = parseNoteArg(arg);
  if (!name){
    throw new Error("E471: Missing note name");
  }
  if (name && /[\\/]/.test(name)){
    throw new Error("E208: Note name must not include path separators");
  }
  setGlobalHint("Creating note…");
  const created = await createNoteOnServer(cwd, name || undefined);
  openEditorInWindow(w, created.path, "", cwd);
}

async function runEditCommand(arg){
  const w = getFocusedExplorerForCommand();
  const targetName = (arg || "").trim();
  if (!targetName){
    throw new Error("E471: Missing filename");
  }
  if (/[\\/]/.test(targetName)){
    throw new Error("E208: Use filenames from the current directory only");
  }
  if (!targetName.toLowerCase().endsWith(".txt")){
    throw new Error("Only .txt files can be edited");
  }
  const absPath = joinPath(w.explorer.cwd, targetName);
  setGlobalHint(`Opening ${absPath}`);
  const { blob } = await fetchFile(absPath);
  const text = await blob.text();
  openEditorInWindow(w, absPath, text, w.explorer.cwd);
}

async function runWriteCommand(options = {}){
  const { exitAfterSave = false } = options;
  const w = getFocusedWin();
  if (!w || w.kind !== "editor"){
    throw new Error("E13: Nothing to write");
  }
  if (w.editor.saving){
    return;
  }
  const path = w.editor.path;
  if (!path){
    throw new Error("Missing file path");
  }
  const text = w.editor.text ?? "";
  w.editor.saving = true;
  w.editor.err = "";
  setGlobalHint(`Writing ${path}…`);
  try{
    await writeTextFile(path, text);
    w.editor.saving = false;
    w.editor.dirty = false;
    w.editor.err = "";
    setGlobalHint(exitAfterSave ? `Wrote ${path} and closed editor` : `Wrote ${path}`);
    if (exitAfterSave){
      await exitEditorToExplorer(w);
    } else {
      render();
    }
  } catch (err){
    w.editor.saving = false;
    w.editor.err = err.message || "Failed to save";
    render();
    throw err;
  }
}

function longestCommonPrefix(strings){
  if (!strings.length) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length && prefix; i++){
    const current = strings[i];
    let j = 0;
    const max = Math.min(prefix.length, current.length);
    while (j < max && prefix[j] === current[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

function tryCompleteEditCommand(){
  const cmd = state.cmd;
  if (!cmd || !cmd.startsWith("e")) return false;
  const match = cmd.match(/^e\s+([^\s]*)$/);
  if (!match) return false;
  const partial = match[1] || "";
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer"){
    setGlobalHint("Focus an explorer to use :e completion.");
    return true;
  }
  const items = Array.isArray(w.explorer?.items) ? w.explorer.items : [];
  if (!items.length){
    setGlobalHint("Explorer list not loaded yet.");
    return true;
  }
  const partialLc = partial.toLowerCase();
  const matches = items.filter(it =>
    it.type === "file" &&
    it.name.toLowerCase().endsWith(".txt") &&
    it.name.toLowerCase().startsWith(partialLc)
  );
  if (!matches.length){
    setGlobalHint("No matching files.");
    return true;
  }
  const names = matches.map(it => it.name);
  let completion = "";
  if (matches.length === 1){
    completion = matches[0].name;
  } else {
    const prefix = longestCommonPrefix(names);
    if (prefix && prefix.length > partial.length){
      completion = prefix;
    } else {
      const preview = matches.slice(0, 5).map(it => it.name).join(", ");
      const suffix = matches.length > 5 ? ", …" : "";
      setGlobalHint(`Matches: ${preview}${suffix}`);
      return true;
    }
  }
  state.cmd = `e ${completion}`;
  updateCmdline();
  setGlobalHint(matches.length === 1 ? `Completed ${completion}` : `${matches.length} matches`);
  return true;
}

// =========================
// Key handling
// =========================
function isTypingTarget(ev){
  // We don't use inputs, but keep this for safety
  const t = ev.target;
  if (!t) return false;
  const tag = (t.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || t.isContentEditable;
}

window.addEventListener("keydown", async (ev) => {
  // Don't hijack keys while user is in a text input (future-proof)
  if (isTypingTarget(ev)) return;

  if (state.mode === "search"){
    ev.preventDefault();

    if (ev.key === "Escape"){
      state.search = "";
      state.searchErr = "";
      setMode("normal");
      setGlobalHint("");
      return;
    }

    if (ev.key === "Enter"){
      const w = getFocusedWin();
      if (!w || w.kind !== "explorer") return;

      const query = state.search.trim();
      state.search = "";
      setMode("normal");

      if (!query){
        setGlobalHint("Empty search");
        return;
      }

      await runExplorerSearch(w, query);
      return;
    }

    if (ev.key === "Backspace"){
      state.search = state.search.slice(0, -1);
      updateCmdline();
      return;
    }

    if (ev.key.length === 1){
      state.search += ev.key;
      updateCmdline();
      return;
    }

    return;
  }

  // Command mode behavior
  if (state.mode === "command"){
    ev.preventDefault();

    if (ev.key === "Tab"){
      tryCompleteEditCommand();
      return;
    }
    if (ev.key === "Escape"){
      state.cmd = "";
      state.cmdErr = "";
      setMode("normal");
      setGlobalHint("");
      return;
    }
    if (ev.key === "Enter"){
      const toRun = state.cmd;
      state.cmd = "";
      setMode("normal");
      await execCommand(toRun);
      return;
    }
    if (ev.key === "Backspace"){
      state.cmd = state.cmd.slice(0, -1);
      updateCmdline();
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey){
      state.cmd += ev.key;
      updateCmdline();
      return;
    }

    return;
  }

  // Normal mode
  // Focus window with Ctrl+1..9
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey){
    const digit = ev.key;
    if (digit >= "1" && digit <= "9"){
      ev.preventDefault();
      focusWindow(Number(digit));
      return;
    }
  }

  const isPlainKey = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
  if (state.awaitingSecondG && (!isPlainKey || ev.key !== "g")){
    state.awaitingSecondG = false;
  }

  // "/" → enter recursive search (explorer only)
  if (isPlainKey && ev.key === "/"){
    const w = getFocusedWin();
    if (!w || w.kind !== "explorer") return;

    ev.preventDefault();
    state.search = "";
    state.searchErr = "";
    setMode("search");
    setGlobalHint("Search (recursive)");
    return;
  }

  // gg / G explorer jumps
  if (isPlainKey && ev.key === "g"){
    const w = getFocusedWin();
    if (!w || w.kind !== "explorer"){
      state.awaitingSecondG = false;
      return;
    }

    ev.preventDefault();
    if (state.awaitingSecondG){
      state.awaitingSecondG = false;
      explorerJumpToEdge("start");
    } else {
      state.awaitingSecondG = true;
    }
    return;
  }
  if (isPlainKey && ev.key === "G"){
    const w = getFocusedWin();
    if (!w || w.kind !== "explorer") return;

    ev.preventDefault();
    state.awaitingSecondG = false;
    explorerJumpToEdge("end");
    return;
  }

  if (isPlainKey && ev.key === "Escape"){
    const w = getFocusedWin();
    if (w && w.kind === "explorer" && w.lastViewerPath){
      ev.preventDefault();
      state.awaitingSecondG = false;
      await openFileInWindow(w.id, w.lastViewerPath);
      return;
    }
  }

  // Ctrl+N: open explorer in focused window
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "n" || ev.key === "N")){
    ev.preventDefault();
    await ensureExplorerInFocused();
    return;
  }

  // Ctrl+B: go up (explorer only)
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "b" || ev.key === "B")){
    ev.preventDefault();
    const w = getFocusedWin();
    if (!w) return;

    if (w.kind === "explorer") {
      await explorerUp();
    } else if (w.kind === "viewer") {
      await viewerBackToExplorer();
    }
    return;
  }

  // ":" enters command mode
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === ":"){
    ev.preventDefault();
    state.cmd = "";
    state.cmdErr = "";
    setMode("command");
    setGlobalHint("COMMAND");
    return;
  }

  // Zoom PDF viewer: "+" to zoom in, "-" to zoom out
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey &&
      (ev.key === "+" || ev.key === "-" || ev.key === "=")) {
    console.log("ehlloe");

    const w = getFocusedWin();
    if (!w || w.kind !== "viewer") return;

    const ct = (w.viewer?.contentType || "").toLowerCase();
    if (!ct.includes("application/pdf")) return; // only for PDFs

    ev.preventDefault();

    // Normal keyboards send "=" with Shift for "+"; treat "=" with Shift as "+"
    const isPlus = (ev.key === "+") || (ev.key === "=" && ev.shiftKey);
    const isMinus = (ev.key === "-");

    let zoom = w.viewer.pdfZoom || 1.25;
    const step = 0.25;

    if (isPlus) {
      zoom = Math.min(zoom + step, 4.0);  // max 4x
    } else if (isMinus) {
      zoom = Math.max(zoom - step, 0.5);  // min 0.5x
    } else {
      return;
    }

    w.viewer.pdfZoom = zoom;
    setGlobalHint(`PDF zoom: ${zoom.toFixed(2)}x`);
    render(); // re-render layout and PDF at new zoom
    return;
  }

  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey &&
      (ev.key === "h" || ev.key === "j" || ev.key === "k" || ev.key === "l")) {

    const w = getFocusedWin();
    if (!w) return;

    // Explorer: only j/k move selection
    if (w.kind === "explorer"){
      if (ev.key === "j" || ev.key === "k") {
        ev.preventDefault();
        await explorerMove(ev.key === "j" ? +1 : -1);
      }
      return;
    }

    // Viewer: h/j/k/l scroll
    if (w.kind === "viewer"){
      ev.preventDefault();

      const vStep = 48;  // pixels per j/k
      const hStep = 64;  // pixels per h/l

      if (ev.key === "j") scrollFocusedViewerXY(0, +vStep);
      if (ev.key === "k") scrollFocusedViewerXY(0, -vStep);
      if (ev.key === "l") scrollFocusedViewerXY(+hStep, 0);
      if (ev.key === "h") scrollFocusedViewerXY(-hStep, 0);

      return;
    }

    return;
  }

  // Resize keymaps: require Shift (so Shift+j => "J"), not Caps Lock.
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.shiftKey &&
      (ev.key === "H" || ev.key === "L" || ev.key === "J" || ev.key === "K")) {

    ev.preventDefault();
    const step = 0.15;

    if (ev.key === "H") resizeFocused("v", -step);
    if (ev.key === "L") resizeFocused("v", +step);
    if (ev.key === "J") resizeFocused("h", -step);
    if (ev.key === "K") resizeFocused("h", +step);

    return;
  }

  // Enter (explorer only)
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === "Enter"){
    const w = getFocusedWin();
    if (w && w.kind === "explorer"){
      ev.preventDefault();
      await explorerEnter();
    }
    return;
  }
});

function clearViewerNode(viewerEl) {
  // remove old canvases / content
  viewerEl.innerHTML = "";
}

function makePdfContainer() {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.alignItems = "center";   // center pages
  wrap.style.gap = "12px";
  wrap.style.padding = "10px";
  wrap.style.width = "fit-content";
  wrap.style.maxWidth = "none";
  return wrap;
}

async function renderPdfInto(winId, viewerEl, pdfBlob, zoom, cacheKey) {
  clearViewerNode(viewerEl);
  viewerEl.style.overflow = "auto";

  const pdfWrap = makePdfContainer();
  viewerEl.appendChild(pdfWrap);
  state.pdfCache.set(winId, { key: cacheKey, el: pdfWrap });

  const loading = document.createElement("div");
  loading.textContent = "Rendering PDF…";
  loading.style.fontFamily = "var(--mono)";
  loading.style.color = "rgba(255,255,255,0.65)";
  loading.style.padding = "6px 2px";
  pdfWrap.appendChild(loading);

  const arrayBuffer = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  loading.textContent = `PDF loaded (${pdf.numPages} pages). Rendering…`;

  const scale = zoom || 1.25;   // <--- use zoom argument

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);


    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.style.border = "1px solid rgba(255,255,255,0.12)";
    canvas.style.borderRadius = "10px";
    canvas.style.background = "rgba(0,0,0,0.12)";

    const label = document.createElement("div");
    label.textContent = `Page ${pageNum}/${pdf.numPages}`;
    label.style.fontFamily = "var(--mono)";
    label.style.fontSize = "12px";
    label.style.color = "rgba(255,255,255,0.55)";
    label.style.margin = "2px 2px -2px";

    const pageWrap = document.createElement("div");
    pageWrap.className = "pdfPage";
    pageWrap.style.width = `${viewport.width}px`;
    pageWrap.style.height = `${viewport.height}px`;

    pageWrap.appendChild(canvas);

    pdfWrap.appendChild(label);
    pdfWrap.appendChild(pageWrap);

    await page.render({ canvasContext: ctx, viewport }).promise;
    await new Promise(requestAnimationFrame);
  }

  loading.remove();
}

async function viewerBackToExplorer() {
  const w = getFocusedWin();
  if (!w || w.kind !== "viewer") return;

  const filePath = w.viewer?.path || "/";
  const dir = parentPath(filePath); // uses your existing parentPath()
  if (w.viewer?.path){
    w.lastViewerPath = w.viewer.path;
  }

  // Cleanup any blob url
  if (w.viewer?.pdfBlob) {
    w.viewer.pdfBlob = null;
  }
  dropPdfCache(w.id);

  // Convert to explorer at the file's directory
  w.kind = "explorer";
  w.title = "Explorer";
  w.explorer = { cwd: dir, items: [], cursor: 0, loading: false, err: "" };
  delete w.viewer;

  render();
  focusPaneByWinId(w.id);
  await loadExplorerListing(w, dir);
}

async function runExplorerSearch(win, query){
  win.explorer.loading = true;
  win.explorer.err = "";
  render();

  try{
    const { path: listedPath, items } = await fetchListing(win.explorer.cwd);
    const normalized = (query || "").toLowerCase();
    const basePath = listedPath ?? win.explorer.cwd;

    const sorted = Array.isArray(items) ? [...items] : [];
    sorted.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

    const matches = sorted
      .filter(it => String(it.name).toLowerCase().includes(normalized))
      .map(it => ({
        ...it,
        fullPath: joinPath(basePath, it.name),
      }));

    win.explorer.items = matches;
    win.explorer.cursor = matches.length ? 0 : 0;
    win.explorer.loading = false;

    const hint = matches.length
      ? `${matches.length} match(es) in ${basePath}`
      : `No matches in ${basePath}`;
    setGlobalHint(hint);
    render();
  } catch (err){
    win.explorer.loading = false;
    win.explorer.err = err.message || "Search failed";
    render();
    setGlobalHint(`Search error: ${win.explorer.err}`);
  }
}

function setPrompt(ch){
  const p = document.getElementById("cmdprompt");
  if (p) p.textContent = ch;
}

// =========================
// Init
// =========================
function init(){
  // Start with one empty window
  const w = makeWindow("empty");
  state.root = makeLeaf(w.id);
  state.focusId = w.id;

  setGlobalHint("Ready. Ctrl+N to open explorer. ':' for commands.");
  render();
}

init();
