# RefBoard Architecture Context

Scope: source inspected with dependencies, build outputs, caches, and generated artifacts excluded. “Confirmed” means directly evidenced by source; “Assumption” identifies an expected runtime effect that was not profiled.

## 1. Stack and Electron architecture

**Confirmed.** RefBoard 1.0.6 is an Electron 37 desktop application built with `electron-builder`; runtime dependency is `electron-updater` (`package.json`). The main process (`main.js`) creates one frameless `BrowserWindow` in `createWindow()` with `contextIsolation: true`, `nodeIntegration: false`, and `preload.js`. `preload.js` exposes a narrow `window.RefBoardAPI` IPC facade. The renderer is a large vanilla HTML/CSS/ES-module application in `index.html`, importing only `scripts/note-dom.mjs`; it uses Canvas 2D, contenteditable, IndexedDB, localStorage, Clipboard APIs, and local-font access. User symptom: startup and most interaction performance are governed by one renderer thread.

## 2. Important files

- **Confirmed — `index.html`:** UI markup/styles plus nearly all renderer behavior: state, canvas rendering, editing, persistence, history, imports/exports, and pointer/keyboard handlers. Key entry is `init()`.
- **Confirmed — `main.js`:** lifecycle (`app.whenReady()`, `createWindow()`), file dialogs/I/O (`setupIpc()`), recent-work metadata/thumbnails, close handshake, updates, single-instance/file-open routing, and Windows thumbnail-handler registration.
- **Confirmed — `preload.js`:** `contextBridge` bindings between renderer and main IPC.
- **Confirmed — `scripts/note-dom.mjs`:** note markdown/link/list DOM hydration and serialization used by the live editor.
- **Confirmed — `scripts/test-group-model.mjs`, `test-note-roundtrip.mjs`, `test-note-parsers.mjs`:** current automated model/parser coverage; there is no automated Electron interaction suite.
- **Confirmed — `build/thumbnail-handler/RefBoardThumbnailHandler.cs` and `scripts/register-thumb-handler.ps1`:** Explorer `.refboard` thumbnail integration.

## 3. Startup flow

**Confirmed.** `main.js` acquires a single-instance lock, then `app.whenReady()` calls `setupIpc()`, awaits `createWindow()`/`loadFile('index.html')`, runs `registerFileTypeIntegration()`, and configures updates with `setupAutoUpdate()`. Renderer `init()` applies theme/settings, wires controls, opens IndexedDB via `openDB()`, calls `restoreSession()`, starts `tick()`, then shows the landing page. File arguments and second-instance opens flow through `extractArgvBoardPath()`, `get-pending-open-path`, and `open-board-path`. User symptom: recovery decoding occurs before the normal landing experience is ready, although `restoreSessionImages()` yields between batches.

## 4. Canvas rendering

**Confirmed.** `tick()` runs continuously with `requestAnimationFrame`, but `draw()` executes only when `dirty` is set by `invalidate()`. `draw()` clears the viewport, draws workspace/grid, applies `state.view` translation/scale, collects visible objects, and paints groups, images, notes, then arrows in passes through `drawBoardItem()`. Selection UI is painted afterward in screen coordinates. Notes are Canvas text except during live contenteditable editing. `resize()` sizes the backing canvas by device-pixel ratio.

**Confirmed — culling.** `collectVisibleItems()` uses `isItemVisible()` against a viewport expanded by 200 screen pixels. Off-screen objects are not painted. However, visibility collection remains an O(n) scan, and `itemAt()`, marquee selection, and `snapTargets()` also scan `state.items`. User symptom: fewer raster draws off-screen, but very large boards can still make pointer movement and redraw preparation slower.

## 5. Image lifecycle

**Confirmed.** File picker, drop, paste, and URL fetch converge on `addImages()`. `registerBlob()` calls `decodeToBitmap()`, retains the original `Blob`, a full-resolution `ImageBitmap`, dimensions/type/name, and stores the blob in IndexedDB. `decodeToBitmap()` prefers `createImageBitmap`; its fallback decodes through `<img>` and a full-size temporary canvas. `drawBoardItem()` crops/transforms and draws either the full bitmap or an LOD returned by `getImageLodForDraw()`.

**Confirmed.** `queueImageLod()`/`runImageLodJob()` generate 0.5–0.0625 downsampled bitmaps on the renderer thread, one job at a time. `evictImageLods()` caps LOD storage at 40 million pixels, but LODs supplement rather than replace originals.

**Confirmed — full resolution.** Every referenced image remains in `images` with both its full decoded bitmap and compressed blob, including off-screen images. `releaseAllImages()` closes them only when replacing/resetting the board. User symptom: boards containing many high-megapixel images can consume substantial RAM/GPU memory even when zoomed out or off-screen.

## 6. Interaction flow

**Confirmed.** `state.view` uses `screen = board * s + translation`; `zoomAt()` zooms around the pointer and `panView()`/pointer `mode: 'pan'` update translation. `pointerdown` performs crop/handle/item hit testing and creates a mode (`move`, `resize`, `groupResize`, `marquee`, crop, draw, arrow). `pointermove` mutates item geometry, applies snapping through `applySnap()`/`snapItemResize()`/`snapGroupResize()`, and invalidates. `pointerup` finalizes grouping, selection, or creation. `rotateSelection()`, `applyProportionalResize()`, and `applyGroupProportionalResize()` handle rotation/scaling. Single-click note selection opens toolbar-only mode; double-click opens `startNoteEdit()` live editing.

## 7. State management

**Confirmed.** There is no framework/store. `state` holds items, view, selection, board options; many module-global variables hold tools, overlays, editing sessions, dirty flags, image records, queues, and timers. Mutations are direct, followed manually by combinations of `invalidateWorkspaceBBox()`, `updateSelBar()`, `scheduleSave()`, and `invalidate()`. Settings/theme live in localStorage. User symptom: a missed companion call can leave rendering, persistence, selection UI, or dirty state inconsistent.

## 8. Save, autosave, load, recovery

**Confirmed.** `scheduleSave()` debounces `persistBoardNow()` by 400 ms. Recovery metadata goes to IndexedDB `meta/board`; image blobs are stored separately in `blobs`. `runAutosaveTick()` periodically persists recovery and, when a named board is dirty, invokes `saveBoardFile({silent:true})`. Manual/file autosave uses `buildBoardPayload()`: every used blob becomes a data URL embedded in one JSON `.refboard`, plus a generated preview; main-process `save-board-file` performs `fs.writeFile`. `applyBoardPayload()` decodes embedded images sequentially, normalizes items, replaces live images/state, clears history, and schedules recovery persistence. `restoreSession()` rebuilds from IndexedDB with decode concurrency three. Close protection uses `boardFileDirty`, `resolveUnsavedChanges()`, and the main-process close handshake.

**Assumption.** Large saves will visibly pause because base64 conversion, preview composition, and `JSON.stringify()` occur in the renderer. The code is asynchronous around some operations, but these individual CPU/allocation steps are not offloaded.

## 9. Undo/redo

**Confirmed.** `pushUndo()` stores a JSON snapshot of all item metadata and board options; `undoStack`/`redoStack` are bounded by the configurable limit. Bitmap edits additionally retain a blob in history through `captureUndoState()`/`restoreBitmapSnap()`. `undo()` and `redo()` capture the current inverse state, then asynchronously call `applyUndoEntry()`. Note editing has separate session stacks (`noteEditPushUndo()`, `undoNoteEdit()`, `redoNoteEdit()`); `finishNoteEdit()` bridges one changed session into board history. `discardNoteEditForBoardHistory()` closes the editor before board restoration.

## 10. Main-thread work and memory risks

**Confirmed.** Renderer-thread work includes all painting, hit testing, snapping, note parsing/measurement, LOD resampling canvases, annotation canvases, composite/export/thumbnail canvases, data-URL conversion, JSON serialization/parsing, and board normalization. Main-process filesystem APIs are asynchronous; PowerShell shell registration runs in a child process.

**Confirmed memory risks.** `images` holds blob + full bitmap + optional LODs; drawing temporarily holds two full-size canvases plus a pristine bitmap (`startDrawSession()`); exports can allocate up to 16,000×16,000 canvases; undo stores repeated whole-board JSON and sometimes image blobs. `deleteSelection()` removes items but does not remove unreferenced entries from `images` or IndexedDB; cleanup occurs on new/open/reset, so delete-heavy sessions retain memory/storage. User symptom: RAM may not fall after deleting images.

## 11. Performance bottlenecks (ranked)

1. **Highest — confirmed:** `buildBoardPayload()`, `compositeBlob()`, `captureBoardPreviewStrip()`, and `doExportPNG()` perform full-board rasterization/base64/JSON work. Symptom: save/export stalls and memory spikes on large boards.
2. **Confirmed:** permanent full-resolution bitmap/blob residency plus LOD duplication (`registerBlob()`, `restoreSessionImages()`, `runImageLodJob()`). Symptom: high RAM/GPU usage and possible process termination.
3. **Confirmed:** O(n) scans in `collectVisibleItems()`, `itemAt()`, marquee logic, `snapTargets()`, selection collection, and several draw passes. Symptom: drag/hover/redraw latency with thousands of objects.
4. **Confirmed:** note rendering repeatedly parses text and calls `measureText` through `layoutNoteLines()`, `drawNoteText()`, link/check hit regions, and editor metrics. Symptom: text-heavy boards redraw more slowly, especially while zooming/editing.
5. **Confirmed:** whole-board JSON snapshots in `snap()` for undo and debounced recovery metadata serialization in `persistBoardNow()`. Symptom: action latency and growing memory on large item graphs.

## 12. Architecture/reliability risks (ranked)

1. **Confirmed:** the monolithic renderer and global mutable state require manual synchronization. Symptom: unrelated features can regress selection, dirty state, editor state, or rendering.
2. **Confirmed:** `.refboard` saving is a single non-atomic `fs.writeFile` of a potentially huge JSON string. Symptom: interrupted writes can leave the only board file truncated/corrupt.
3. **Confirmed:** deleted images remain in memory and IndexedDB until broader board cleanup. Symptom: long sessions accumulate RAM and recovery-store data.
4. **Confirmed:** `undo()`/`redo()` launch asynchronous bitmap restoration without an operation queue/lock. **Assumption:** rapid history commands involving annotated images may complete out of order. Symptom: bitmap content may not match the final history position.
5. **Confirmed:** automated tests cover group and note parsing/model behavior, not Electron IPC, save/recovery, contenteditable events, or pointer interaction. Symptom: integration regressions depend on manual testing.

## 13. Minimum inspection set for another assistant

Read, in order: `package.json`; `main.js` (`createWindow()`, `setupIpc()`); `preload.js`; `index.html` sections for `state`, image LOD/persistence, undo, `addImages()`, save/load, `draw()`/`tick()`, hit testing and pointer handlers; then `scripts/note-dom.mjs` for note work. Add the three `scripts/test-*.mjs` files before modifying tested note/group behavior.
