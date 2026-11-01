/* RefBoard Viewer runtime.
 *
 * Inlined into an exported board .html by scripts/board-export-main.js. Reads
 * the payload from the JSON script element #rb-payload and the
 * images from the text/plain script elements [data-rb-img], and shows the board
 * read-only: drag to pan, wheel or pinch to zoom, F / 0 to fit, double-click
 * an image to zoom to it.
 *
 * Every user string reaches the page through textContent or a CSSOM property,
 * never through markup. With payload.print set (the PDF export) it draws the
 * board at a fixed scale on one page and shows no UI.
 *
 * window.__refboardViewerReady resolves once every image has decoded.
 */
(function () {
  'use strict';
  var doc = document;
  var root = doc.documentElement;
  var resolveReady;
  window.__refboardViewerReady = new Promise(function (r) { resolveReady = r; });

  var P;
  try {
    P = JSON.parse(doc.getElementById('rb-payload').textContent);
  } catch (err) {
    resolveReady({ ok: false, error: 'payload' });
    return;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  var stage = doc.getElementById('rb-stage');
  var board = doc.getElementById('rb-board');
  var B = P.bounds;
  var print = P.print || null;
  var bg = print ? print.bg : P.bg;
  doc.body.style.background = bg;
  root.style.background = bg;
  stage.style.background = bg;

  function el(tag, cls, parent) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function svgEl(tag, parent) {
    var n = doc.createElementNS(SVGNS, tag);
    if (parent) parent.appendChild(n);
    return n;
  }
  function rgba(hex, a) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
    var h = m ? m[1] : '15161c';
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
  }
  function safeHref(href) {
    return /^(https?:\/\/|mailto:)/i.test(String(href || '')) ? String(href) : null;
  }
  function place(n, it) {
    n.style.left = it.x + 'px';
    n.style.top = it.y + 'px';
    n.style.width = it.w + 'px';
    n.style.height = it.h + 'px';
  }

  /* ---------------- build ---------------- */
  var entries = [];          // { it, node, kind }
  var byId = Object.create(null);
  var imgNodes = [];         // per embedded image: [<img>, ...]
  for (var i = 0; i < P.images.length; i++) imgNodes.push([]);

  function buildImage(it) {
    var n = el('div', 'rb-it rb-img', board);
    place(n, it);
    var tf = [];
    if (it.rot) tf.push('rotate(' + it.rot + 'deg)');
    if (it.fx || it.fy) tf.push('scale(' + (it.fx ? -1 : 1) + ',' + (it.fy ? -1 : 1) + ')');
    if (tf.length) n.style.transform = tf.join(' ');
    if (it.gray || P.gray) n.classList.add('gray');
    var c = it.crop || [0, 0, 1, 1];
    var cw = Math.max(1e-6, c[2] - c[0]), ch = Math.max(1e-6, c[3] - c[1]);
    var img = el('img', '', n);
    img.alt = (P.images[it.img] && P.images[it.img].name) || '';
    img.draggable = false;
    img.decoding = 'async';
    img.style.width = (it.w / cw) + 'px';
    img.style.height = (it.h / ch) + 'px';
    img.style.left = (-c[0] / cw * it.w) + 'px';
    img.style.top = (-c[1] / ch * it.h) + 'px';
    if (imgNodes[it.img]) imgNodes[it.img].push(img);
    return n;
  }

  function checkbox(parent, box, checked, color, left, top) {
    var s = svgEl('svg', parent);
    s.setAttribute('class', 'rb-check');
    s.setAttribute('width', box);
    s.setAttribute('height', box);
    s.setAttribute('viewBox', '0 0 ' + box + ' ' + box);
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', checked ? 'checked' : 'unchecked');
    s.style.left = left + 'px';
    s.style.top = top + 'px';
    var sw = box * 0.1;
    var r = svgEl('rect', s);
    r.setAttribute('x', sw / 2); r.setAttribute('y', sw / 2);
    r.setAttribute('width', Math.max(0, box - sw)); r.setAttribute('height', Math.max(0, box - sw));
    r.setAttribute('fill', 'none'); r.setAttribute('stroke', color); r.setAttribute('stroke-width', sw);
    if (checked) {
      var c = box / 2;
      var p = svgEl('polyline', s);
      p.setAttribute('points', [
        c - box * 0.22, c + box * 0.02, c - box * 0.02, c + box * 0.24, c + box * 0.28, c - box * 0.22,
      ].join(' '));
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', box * 0.14);
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    }
  }

  function buildNote(it) {
    var n = el('div', 'rb-it rb-note', board);
    place(n, it);
    if (it.rot) n.style.transform = 'rotate(' + it.rot + 'deg)';
    n.style.background = rgba(it.bg, it.op == null ? 1 : it.op);
    var sk = it.size / 15;
    n.style.boxShadow = '0 calc(' + (3 * sk) + 'px * var(--px)) calc(' + (8 * sk) + 'px * var(--px)) rgba(0,0,0,.2)';
    if (P.gray) n.style.filter = 'grayscale(1)';
    if (it.underline) n.classList.add('u');

    // Glyphs are laid out at >= 4 px and scaled into board units, as the
    // board's canvas does for notes made at high zoom.
    var F = Math.max(it.size, 4);
    var k = it.size / F;
    var innerW = Math.max(1e-6, it.w - it.padX * 2);
    var innerH = Math.max(1e-6, it.h - it.padY * 2);
    var lineH = it.lineH;
    var maxLines = Math.max(1, Math.floor(innerH / lineH + 1e-3));
    var shown = it.lines.slice(0, maxLines);
    var L = lineH / k, G = it.gutter / k;
    var t = el('div', 'rb-note-text', n);
    t.style.font = (it.italic ? 'italic ' : 'normal ') + (it.bold ? '700 ' : '400 ') + F + 'px/' + L + 'px sans-serif';
    t.style.fontFamily = '"' + it.family + '", "Segoe UI", var(--font-display)';
    t.style.color = it.color;
    var box = F * 0.82;
    for (var li = 0; li < shown.length; li++) {
      var ln = shown[li];
      var row = el('div', 'rb-line', t);
      row.style.height = L + 'px';
      row.style.textAlign = it.align;
      var lc = el('span', 'rb-lc', row);
      if (ln.k !== 'plain') {
        var gut = el('span', 'rb-gut', lc);
        gut.style.width = G + 'px';
        gut.style.height = L + 'px';
        gut.style.verticalAlign = 'top';
        if (ln.k === 'check') {
          checkbox(gut, box, !!ln.checked, it.color, G * 0.38 - box / 2, L / 2 - box / 2);
        } else {
          var mark = el('span', '', gut);
          mark.style.userSelect = 'none';
          mark.textContent = ln.k === 'bullet' ? '•' : (ln.n + '.');
          if (ln.k === 'bullet') mark.style.paddingLeft = (G * 0.38) + 'px';
        }
      }
      var body = el('span', 'rb-body', lc);
      for (var si = 0; si < ln.segs.length; si++) {
        var seg = ln.segs[si];
        var href = seg.href ? safeHref(seg.href) : null;
        if (href) {
          var a = el('a', '', body);
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = seg.text;
        } else {
          body.appendChild(doc.createTextNode(seg.text));
        }
      }
    }
    var fit = { node: t, k: k, F: F, innerW: innerW, innerH: innerH, rows: shown.length, lineH: lineH, padX: it.padX, padY: it.padY };
    layoutNoteText(fit, 1);
    noteFits.push(fit);
    return n;
  }

  var noteFits = [];
  function layoutNoteText(f, shrink) {
    var blockH = f.rows * f.lineH * shrink;
    var y0 = Math.max(0, (f.innerH - blockH) / 2);
    f.node.style.left = f.padX + 'px';
    f.node.style.top = (f.padY + y0) + 'px';
    f.node.style.width = (f.innerW / (f.k * shrink)) + 'px';
    f.node.style.transform = 'scale(' + (f.k * shrink) + ')';
  }
  /* A system font on another machine can set a line wider than the board
     measured it. The board never spills text past a note's box, so shrink
     that note's text to fit rather than let it run under the edge. */
  function fitNotes() {
    for (var i = 0; i < noteFits.length; i++) {
      var f = noteFits[i];
      var widest = 0;
      var rows = f.node.children;
      for (var r = 0; r < rows.length; r++) {
        var lc = rows[r].firstChild;
        if (lc) widest = Math.max(widest, lc.offsetWidth);
      }
      var avail = f.innerW / f.k;
      layoutNoteText(f, widest > avail + 0.5 ? avail / widest : 1);
    }
  }

  function svgFor(it, cls) {
    var s = svgEl('svg', board);
    s.setAttribute('class', 'rb-it rb-svg' + (cls ? ' ' + cls : ''));
    s.style.left = it.x + 'px';
    s.style.top = it.y + 'px';
    s.style.width = it.w + 'px';
    s.style.height = it.h + 'px';
    return s;
  }
  function addPath(s, p) {
    var n = svgEl('path', s);
    n.setAttribute('d', p.d);
    if (p.fill) { n.setAttribute('fill', p.fill); }
    else {
      n.setAttribute('fill', 'none');
      n.setAttribute('stroke', p.stroke);
      n.setAttribute('stroke-width', p.width);
      n.setAttribute('stroke-linecap', 'round');
      n.setAttribute('stroke-linejoin', 'round');
      if (p.dash) n.setAttribute('stroke-dasharray', p.dash.join(' '));
    }
  }
  function buildArrow(it) {
    var s = svgFor(it);
    s.setAttribute('viewBox', [it.x, it.y, it.w, it.h].join(' '));
    for (var i = 0; i < it.paths.length; i++) addPath(s, it.paths[i]);
    return [s];
  }
  function buildInk(it) {
    var layers = it.highlighter ? [['rb-hl', 0.85], ['rb-hl2', 0.18]] : [['', 1]];
    var out = [];
    for (var l = 0; l < layers.length; l++) {
      var s = svgFor(it, layers[l][0]);
      s.setAttribute('viewBox', '0 0 ' + it.bw + ' ' + it.bh);
      s.setAttribute('preserveAspectRatio', 'none');
      if (it.rot) s.style.transform = 'rotate(' + it.rot + 'deg)';
      if (layers[l][1] !== 1) s.style.opacity = layers[l][1];
      for (var i = 0; i < it.paths.length; i++) addPath(s, it.paths[i]);
      out.push(s);
    }
    return out;
  }
  function buildGroup(it) {
    var n = el('div', 'rb-it rb-group' + (it.locked ? ' locked' : ''), board);
    n.style.setProperty('--gx', it.x);
    n.style.setProperty('--gy', it.y);
    n.style.setProperty('--gw', it.w);
    n.style.setProperty('--gh', it.h);
    n.style.background = rgba(it.color, 0.06);
    n.style.borderColor = rgba(it.color, 0.22);
    if (it.name) {
      var name = el('div', 'rb-group-name', n);
      name.style.color = rgba(it.color, 0.9);
      name.textContent = it.name;
    }
    return n;
  }

  for (var e = 0; e < P.items.length; e++) {
    var it = P.items[e];
    var nodes;
    if (it.t === 'img') nodes = [buildImage(it)];
    else if (it.t === 'note') nodes = [buildNote(it)];
    else if (it.t === 'group') nodes = [buildGroup(it)];
    else if (it.t === 'arrow') nodes = buildArrow(it);
    else if (it.t === 'ink') nodes = buildInk(it);
    else continue;
    var entry = { it: it, nodes: nodes };
    nodes[0].setAttribute('data-rb-index', String(e));
    if (it.id) { nodes[0].setAttribute('data-rb-id', it.id); byId[it.id] = entry; }
    entries.push(entry);
  }

  /* ---------------- images ---------------- */
  var blobUrls = [];
  var blobs = [];
  function decodeBlock(block) {
    var bin = atob(block.textContent || '');
    var n = bin.length;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    block.textContent = '';
    return new Blob([bytes], { type: block.getAttribute('data-mime') || 'application/octet-stream' });
  }
  function loadImages() {
    var blocks = doc.querySelectorAll('script[data-rb-img]');
    var decodes = [];
    var idx = 0;
    return new Promise(function (resolve) {
      function step() {
        var started = performance.now();
        while (idx < blocks.length && performance.now() - started < 24) {
          var block = blocks[idx++];
          var at = Number(block.getAttribute('data-rb-img'));
          var blob;
          try { blob = decodeBlock(block); } catch (err) { continue; }
          var url = URL.createObjectURL(blob);
          blobs[at] = blob;
          blobUrls[at] = url;
          var list = imgNodes[at] || [];
          for (var j = 0; j < list.length; j++) {
            list[j].src = url;
            decodes.push(list[j].decode().catch(function () { return null; }));
          }
        }
        if (idx < blocks.length) setTimeout(step, 0);
        else resolve(Promise.all(decodes));
      }
      step();
    });
  }

  /* ---------------- print (PDF) ---------------- */
  if (print) {
    root.classList.add('rb-print');
    var css = el('style', '', doc.head);
    css.textContent = '@page{size:' + print.wPx + 'px ' + print.hPx + 'px;margin:0}'
      + 'html,body{width:' + print.wPx + 'px;height:' + print.hPx + 'px}';
    stage.style.width = print.wPx + 'px';
    stage.style.height = print.hPx + 'px';
    var s0 = print.scale;
    board.style.transform = 'translate(' + (-B.x * s0) + 'px,' + (-B.y * s0) + 'px) scale(' + s0 + ')';
    board.style.setProperty('--inv', String(1 / Math.max(s0, 0.01)));
    board.style.setProperty('--px', String(1 / s0));
    loadImages().then(function (results) {
      var fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
      return fonts.then(function () {
        fitNotes();
        var failed = results.filter(function (r) { return r === null; }).length;
        resolveReady({ ok: true, images: results.length, failed: failed });
      });
    }, function (err) { resolveReady({ ok: false, error: String(err) }); });
    return;
  }

  /* ---------------- interactive view ---------------- */
  var view = { s: 1, tx: 0, ty: 0 };
  var MAX_S = 32;
  var minS = 0.01;
  var pctBtn;

  function applyView() {
    board.style.transform = 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.s + ')';
    board.style.setProperty('--inv', String(1 / Math.max(view.s, 0.01)));
    board.style.setProperty('--px', String(1 / view.s));
    if (pctBtn) pctBtn.textContent = Math.round(view.s * 100) + '%';
    hideSave();
  }
  function viewport() { return { w: stage.clientWidth || window.innerWidth, h: stage.clientHeight || window.innerHeight }; }
  function viewFor(box, margin) {
    var vp = viewport();
    var m = margin == null ? Math.min(48, Math.min(vp.w, vp.h) * 0.06) : margin;
    var s = Math.min((vp.w - m * 2) / box.w, (vp.h - m * 2) / box.h);
    s = Math.max(1e-4, Math.min(MAX_S, s));
    return { s: s, tx: (vp.w - box.w * s) / 2 - box.x * s, ty: (vp.h - box.h * s) / 2 - box.y * s };
  }
  var anim = 0;
  function setView(v, animate) {
    cancelAnimationFrame(anim);
    if (!animate) { view = { s: v.s, tx: v.tx, ty: v.ty }; applyView(); return; }
    var from = { s: view.s, tx: view.tx, ty: view.ty };
    var t0 = performance.now(), dur = 220;
    // Interpolate in log-scale so the zoom feels even, keeping the screen
    // centre's board point on a straight line.
    var vp = viewport();
    var cx = vp.w / 2, cy = vp.h / 2;
    var bx0 = (cx - from.tx) / from.s, by0 = (cy - from.ty) / from.s;
    var bx1 = (cx - v.tx) / v.s, by1 = (cy - v.ty) / v.s;
    function frame(now) {
      var p = Math.min(1, (now - t0) / dur);
      var q = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      var s = Math.exp(Math.log(from.s) + (Math.log(v.s) - Math.log(from.s)) * q);
      var bx = bx0 + (bx1 - bx0) * q, by = by0 + (by1 - by0) * q;
      view = { s: s, tx: cx - bx * s, ty: cy - by * s };
      if (p >= 1) view = { s: v.s, tx: v.tx, ty: v.ty };
      applyView();
      if (p < 1) anim = requestAnimationFrame(frame);
    }
    anim = requestAnimationFrame(frame);
  }
  function fit(animate) {
    var v = viewFor(B);
    minS = Math.min(0.01, v.s * 0.5);
    zoomedItem = null;
    setView(v, animate);
  }
  function zoomAt(factor, cx, cy) {
    var s = Math.max(minS, Math.min(MAX_S, view.s * factor));
    var k = s / view.s;
    setView({ s: s, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k });
  }

  /* zoom to an image and back */
  var zoomedItem = null, zoomBack = null;
  function itemBox(node) {
    var r = node.getBoundingClientRect();
    return { x: (r.left - view.tx) / view.s, y: (r.top - view.ty) / view.s, w: r.width / view.s, h: r.height / view.s };
  }
  function toggleZoomTo(node) {
    if (!node) return;
    if (zoomedItem === node && zoomBack) {
      var back = zoomBack;
      zoomedItem = null; zoomBack = null;
      setView(back, true);
      return;
    }
    if (!zoomedItem) zoomBack = { s: view.s, tx: view.tx, ty: view.ty };
    zoomedItem = node;
    setView(viewFor(itemBox(node)), true);
  }

  /* UI */
  var title = el('div', 'rb-ui', doc.body);
  title.id = 'rb-title';
  title.textContent = P.name;
  title.title = P.name;
  var brand = el('div', 'rb-ui', doc.body);
  brand.id = 'rb-brand';
  brand.textContent = 'Made with RefBoard';
  var zoom = el('div', 'rb-ui', doc.body);
  zoom.id = 'rb-zoom';
  function zbtn(label, aria, fn) {
    var b = el('button', '', zoom);
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.title = aria;
    b.addEventListener('click', fn);
    return b;
  }
  zbtn('−', 'Zoom out', function () { var vp = viewport(); zoomAt(1 / 1.25, vp.w / 2, vp.h / 2); });
  pctBtn = zbtn('100%', 'Zoom to 100%', function () { var vp = viewport(); zoomAt(1 / view.s, vp.w / 2, vp.h / 2); });
  pctBtn.id = 'rb-zpct';
  zbtn('+', 'Zoom in', function () { var vp = viewport(); zoomAt(1.25, vp.w / 2, vp.h / 2); });
  zbtn('Fit', 'Fit the board (F)', function () { fit(true); }).id = 'rb-zfit';

  /* labels */
  var activeTag = -1;
  var labelButtons = [];
  function applyFilter() {
    var pass = Object.create(null);
    for (var i = 0; i < entries.length; i++) {
      var it = entries[i].it;
      if (activeTag >= 0 && it.tags && it.tags.indexOf(activeTag) >= 0) pass[i] = true;
    }
    for (var g = 0; g < entries.length; g++) {
      var gi = entries[g].it;
      if (gi.t !== 'group' || activeTag < 0) continue;
      for (var c = 0; c < gi.kids.length; c++) {
        var kid = byId[gi.kids[c]];
        if (kid && pass[entries.indexOf(kid)]) { pass[g] = true; break; }
      }
    }
    for (var j = 0; j < entries.length; j++) {
      var dim = activeTag >= 0 && !pass[j];
      for (var n = 0; n < entries[j].nodes.length; n++) entries[j].nodes[n].classList.toggle('rb-dim', dim);
    }
    for (var b = 0; b < labelButtons.length; b++) {
      labelButtons[b].classList.toggle('on', b === activeTag);
      labelButtons[b].setAttribute('aria-pressed', b === activeTag ? 'true' : 'false');
    }
  }
  if (P.tags && P.tags.length) {
    var panel = el('div', 'rb-ui', doc.body);
    panel.id = 'rb-labels';
    var head = el('button', 'rb-lab-head', panel);
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');
    var headText = el('span', '', head);
    headText.textContent = 'Labels';
    var caret = el('span', '', head);
    caret.textContent = '▾';
    var list = el('div', 'rb-lab-list', panel);
    head.addEventListener('click', function () {
      var collapsed = panel.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      caret.textContent = collapsed ? '▸' : '▾';
    });
    if (window.innerWidth < 520) {
      panel.classList.add('collapsed');
      head.setAttribute('aria-expanded', 'false');
      caret.textContent = '▸';
    }
    P.tags.forEach(function (tag, i) {
      var b = el('button', 'rb-lab', list);
      b.type = 'button';
      b.setAttribute('data-rb-tag', String(i));
      var dot = el('span', 'rb-dot', b);
      if (tag.color) dot.style.background = tag.color;
      var nm = el('span', 'rb-lab-name', b);
      nm.textContent = tag.name;
      var ct = el('span', 'rb-count', b);
      ct.textContent = String(tag.count);
      b.addEventListener('click', function () {
        activeTag = activeTag === i ? -1 : i;
        applyFilter();
      });
      labelButtons.push(b);
    });
  }

  /* save an image */
  var saveBtn = null, saveFor = null;
  if (P.allowSave) {
    saveBtn = el('button', '', doc.body);
    saveBtn.id = 'rb-save';
    saveBtn.type = 'button';
    saveBtn.title = 'Save image';
    saveBtn.setAttribute('aria-label', 'Save image');
    var icon = svgEl('svg', saveBtn);
    icon.setAttribute('viewBox', '0 0 24 24');
    var ip = svgEl('path', icon);
    ip.setAttribute('d', 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14');
    saveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!saveFor) return;
      var it = saveFor.it;
      var meta = P.images[it.img] || {};
      var blob = blobs[it.img];
      if (!blob) return;
      var ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' }[blob.type] || 'img';
      var stem = String(meta.name || 'image').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'image';
      var a = doc.createElement('a');
      a.href = blobUrls[it.img];
      a.download = stem + '.' + ext;
      doc.body.appendChild(a);
      a.click();
      a.remove();
    });
  }
  function showSaveFor(node) {
    if (!saveBtn) return;
    var entry = entries[Number(node.getAttribute('data-rb-index'))];
    if (!entry || !blobs[entry.it.img]) return;
    saveFor = entry;
    var r = node.getBoundingClientRect();
    var vp = viewport();
    var x = Math.min(vp.w - 40, Math.max(8, r.right - 40));
    var y = Math.min(vp.h - 40, Math.max(8, r.top + 8));
    saveBtn.style.left = x + 'px';
    saveBtn.style.top = y + 'px';
    saveBtn.classList.add('show');
  }
  function hideSave() {
    if (!saveBtn) return;
    saveBtn.classList.remove('show');
    saveFor = null;
  }

  /* ---------------- input ---------------- */
  var pointers = new Map();
  var gesture = null;
  var lastTap = null;
  function imageAt(target) { return target && target.closest ? target.closest('.rb-img') : null; }
  function startGesture() {
    var pts = Array.from(pointers.values());
    if (pts.length >= 2) {
      var a = pts[0], b = pts[1];
      gesture = {
        kind: 'pinch', s: view.s, tx: view.tx, ty: view.ty,
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      };
    } else if (pts.length === 1) {
      gesture = { kind: 'pan', x: pts[0].x, y: pts[0].y, tx: view.tx, ty: view.ty };
    } else gesture = null;
  }
  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // A mouse drag that starts on a note selects its text, as on a page.
    if (e.pointerType === 'mouse' && e.target.closest && e.target.closest('.rb-note')) return;
    cancelAnimationFrame(anim);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), type: e.pointerType, target: e.target });
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    stage.classList.add('panning');
    startGesture();
  });
  stage.addEventListener('pointermove', function (e) {
    var p = pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && !e.buttons) {
        var node = imageAt(e.target);
        if (node) showSaveFor(node);
        else if (saveBtn && e.target !== saveBtn) hideSave();
      }
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;
    if (gesture.kind === 'pan') {
      view.tx = gesture.tx + (p.x - gesture.x);
      view.ty = gesture.ty + (p.y - gesture.y);
      applyView();
    } else {
      var pts = Array.from(pointers.values());
      var a = pts[0], b = pts[1];
      var dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var s = Math.max(minS, Math.min(MAX_S, gesture.s * dist / gesture.dist));
      var bx = (gesture.mx - gesture.tx) / gesture.s, by = (gesture.my - gesture.ty) / gesture.s;
      view = { s: s, tx: mx - bx * s, ty: my - by * s };
      applyView();
    }
  });
  function endPointer(e) {
    var p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    var moved = Math.hypot(p.x - p.x0, p.y - p.y0);
    var wasTap = e.type === 'pointerup' && moved < 8 && performance.now() - p.t0 < 350 && !pointers.size && gesture && gesture.kind === 'pan';
    startGesture();
    if (!pointers.size) stage.classList.remove('panning');
    if (!wasTap || p.type === 'mouse') return;
    var node = imageAt(p.target);
    var now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      lastTap = null;
      toggleZoomTo(node);
      return;
    }
    lastTap = { t: now, x: p.x, y: p.y };
    if (node) showSaveFor(node); else hideSave();
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('dblclick', function (e) {
    // Pointer capture retargets the click to the stage; ask what is under it.
    var node = imageAt(doc.elementFromPoint(e.clientX, e.clientY)) || imageAt(e.target);
    if (node) { e.preventDefault(); toggleZoomTo(node); }
  });
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    var factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(factor, e.clientX, e.clientY);
  }, { passive: false });
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    var vp = viewport();
    if (k === 'f' || k === 'F' || k === '0') { e.preventDefault(); fit(true); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomAt(1.25, vp.w / 2, vp.h / 2); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomAt(1 / 1.25, vp.w / 2, vp.h / 2); }
  });
  var lastVp = viewport();
  window.addEventListener('resize', function () {
    var vp = viewport();
    // Keep the board point at the centre where it was.
    view.tx += (vp.w - lastVp.w) / 2;
    view.ty += (vp.h - lastVp.h) / 2;
    lastVp = vp;
    applyView();
  });
  doc.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  window.__refboardViewer = {
    view: function () { return { s: view.s, tx: view.tx, ty: view.ty }; },
    setView: function (s, tx, ty) { zoomedItem = null; setView({ s: s, tx: tx, ty: ty }); },
    fit: function () { fit(false); },
    filter: function (i) { activeTag = i; applyFilter(); },
  };

  fit(false);
  loadImages().then(function (results) {
    var fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
    return fonts.then(function () {
      fitNotes();
      resolveReady({ ok: true, images: results.length, failed: results.filter(function (r) { return r === null; }).length });
    });
  }, function (err) { resolveReady({ ok: false, error: String(err) }); });
})();
