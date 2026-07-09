/**
 * Stage 1: markdown <-> DOM for notes.
 * Parsers match index.html (parseNoteLine / parseNoteLinkSegments) exactly.
 * Run tests: node scripts/test-note-roundtrip.mjs
 */

// --- parsers (keep in sync with index.html) ---

export function parseNoteLine(line) {
  const raw = String(line ?? '');
  let m = raw.match(/^(\[[ xX]\])\s/);
  if (m) return { type: 'check', checked: m[1][1].toLowerCase() === 'x', body: raw.slice(m[0].length) };
  m = raw.match(/^(\d+)\.\s/);
  if (m) return { type: 'number', n: parseInt(m[1], 10), body: raw.slice(m[0].length) };
  m = raw.match(/^(?:•|-|\*)\s/);
  if (m) return { type: 'bullet', body: raw.slice(m[0].length) };
  return { type: 'plain', body: raw };
}

export function stripListPrefix(line) {
  return parseNoteLine(line).body;
}

export function parseNoteLinkSegments(text) {
  const src = String(text ?? '');
  const segs = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)|(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;
  let last = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) segs.push({ type: 'text', text: src.slice(last, m.index) });
    if (m[1] !== undefined) segs.push({ type: 'link', text: m[1], url: m[2], bare: false });
    else segs.push({ type: 'link', text: m[3], url: m[3], bare: true });
    last = re.lastIndex;
  }
  if (last < src.length) segs.push({ type: 'text', text: src.slice(last) });
  if (!segs.length) segs.push({ type: 'text', text: src });
  return segs;
}

/** Exact list/checkbox prefix as stored (same regexes as parseNoteLine). */
function noteLinePrefix(line) {
  const raw = String(line ?? '');
  let m = raw.match(/^(\[[ xX]\])\s/);
  if (m) return m[0];
  m = raw.match(/^(\d+)\.\s/);
  if (m) return m[0];
  m = raw.match(/^(?:•|-|\*)\s/);
  if (m) return m[0];
  return '';
}

// --- minimal DOM for Node (browser uses real document) ---

function createMiniDocument() {
  class MiniNode {
    constructor() {
      this.parentNode = null;
      this.childNodes = [];
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) {
        this.childNodes.splice(i, 1);
        child.parentNode = null;
      }
      return child;
    }
    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map(c => c.textContent).join('');
    }
    set textContent(v) {
      this.childNodes = [];
      if (v) this.appendChild(this.ownerDocument.createTextNode(String(v)));
    }
  }

  class MiniText extends MiniNode {
    constructor(doc, value) {
      super();
      this.ownerDocument = doc;
      this.nodeType = 3;
      this.nodeValue = String(value);
    }
  }

  class MiniElement extends MiniNode {
    constructor(doc, tag) {
      super();
      this.ownerDocument = doc;
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this._attrs = Object.create(null);
    }
    setAttribute(name, value) {
      this._attrs[String(name).toLowerCase()] = String(value);
    }
    getAttribute(name) {
      const v = this._attrs[String(name).toLowerCase()];
      return v === undefined ? null : v;
    }
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, String(name).toLowerCase());
    }
    removeAttribute(name) {
      delete this._attrs[String(name).toLowerCase()];
    }
    get children() {
      return this.childNodes.filter(c => c.nodeType === 1);
    }
  }

  class MiniFragment extends MiniNode {
    constructor(doc) {
      super();
      this.ownerDocument = doc;
      this.nodeType = 11;
    }
  }

  const doc = {
    createElement(tag) { return new MiniElement(doc, tag); },
    createTextNode(text) { return new MiniText(doc, text); },
    createDocumentFragment() { return new MiniFragment(doc); },
  };
  return doc;
}

function ownerDoc(doc) {
  if (doc) return doc;
  if (typeof globalThis.document !== 'undefined' && globalThis.document?.createElement) {
    return globalThis.document;
  }
  return createMiniDocument();
}

// --- hydrate ---

function appendSegments(doc, parent, body) {
  for (const seg of parseNoteLinkSegments(body)) {
    if (seg.type === 'link') {
      const a = doc.createElement('a');
      a.setAttribute('href', seg.url);
      if (seg.bare) a.setAttribute('data-bare', '1');
      a.appendChild(doc.createTextNode(seg.text));
      parent.appendChild(a);
    } else if (seg.text) {
      parent.appendChild(doc.createTextNode(seg.text));
    }
  }
}

function hydrateLine(doc, line) {
  const el = doc.createElement('div');
  el.setAttribute('data-note-line', '1');
  const parsed = parseNoteLine(line);
  el.setAttribute('data-type', parsed.type);
  const prefix = noteLinePrefix(line);
  if (prefix) el.setAttribute('data-prefix', prefix);
  if (parsed.type === 'check') el.setAttribute('data-checked', parsed.checked ? '1' : '0');
  if (parsed.type === 'number') el.setAttribute('data-n', String(parsed.n));
  appendSegments(doc, el, parsed.body);
  return el;
}

/**
 * Build a DocumentFragment of one <div data-note-line> per \n-separated line.
 * Links: <a href="url">label</a>; bare URLs get data-bare="1" so serialize can
 * round-trip `[url](url)` vs bare url.
 */
export function hydrateNoteDom(markdownString, doc) {
  const owner = ownerDoc(doc);
  const frag = owner.createDocumentFragment();
  const lines = String(markdownString ?? '').split('\n');
  for (const line of lines) frag.appendChild(hydrateLine(owner, line));
  return frag;
}

// --- serialize (whitelist only what hydrate produces) ---

function isElement(node) {
  return node && node.nodeType === 1;
}

function isText(node) {
  return node && node.nodeType === 3;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ');
}

function serializeInline(node) {
  if (!node) return '';
  if (isText(node)) return normalizeText(node.nodeValue);
  if (!isElement(node)) return '';

  const tag = String(node.tagName || '').toUpperCase();

  // Whitelisted link
  if (tag === 'A') {
    const href = node.getAttribute?.('href') || '';
    let label = '';
    for (const child of node.childNodes || []) {
      if (isText(child)) label += normalizeText(child.nodeValue);
      else if (isElement(child)) label += serializeInline(child); // unwrap nested junk inside <a>
    }
    if (node.getAttribute?.('data-bare') === '1') return href || label;
    return `[${label}](${href})`;
  }

  // BR and void junk → nothing (line breaks are block-level only)
  if (tag === 'BR' || tag === 'HR' || tag === 'IMG' || tag === 'INPUT') return '';

  // Unwrap everything else (span, b, div, font, …) — concatenate children
  let s = '';
  for (const child of node.childNodes || []) s += serializeInline(child);
  return s;
}

function serializeLine(el) {
  if (!isElement(el)) return '';
  const prefix = el.getAttribute?.('data-prefix') || '';
  let body = '';
  for (const child of el.childNodes || []) body += serializeInline(child);
  return prefix + body;
}

function lineElements(root) {
  if (!root) return [];
  // DocumentFragment or root container: direct data-note-line children
  const kids = root.childNodes ? [...root.childNodes] : [];
  const lines = kids.filter(n => isElement(n) && n.getAttribute?.('data-note-line') === '1');
  if (lines.length) return lines;
  // Single line element
  if (isElement(root) && root.getAttribute?.('data-note-line') === '1') return [root];
  // Fallback: any descendant lines (dirty contenteditable trees)
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (isElement(n) && n.getAttribute?.('data-note-line') === '1') {
      out.push(n);
      return;
    }
    for (const c of n.childNodes || []) walk(c);
  };
  walk(root);
  return out;
}

/**
 * Serialize a hydrateNoteDom result (or a dirty contenteditable tree) back to
 * the note markdown string. Only whitelisted structure is kept.
 */
export function serializeNoteDom(element) {
  const lines = lineElements(element);
  if (!lines.length) {
    // Empty fragment / empty editor → empty string
    if (!element || !(element.childNodes && element.childNodes.length)) return '';
    // No line markers: treat whole tree as one plain line (still strip junk)
    return serializeInline(element);
  }
  return lines.map(serializeLine).join('\n');
}
