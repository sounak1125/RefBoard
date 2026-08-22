'use strict';
/* Shift labelling: the coarse layout stage that seeds PatchMatch.
 *
 * A handful of whole-image translations are proposed, every hole pixel picks
 * one, and the choice is made globally: a pixel pays for disagreeing with the
 * real content it touches, and two neighbours on different translations pay for
 * how visible the seam between them would be. Minimising that lands on a few
 * large regions with their boundaries routed through places where the two
 * sources already look alike, so the layout is made of contiguous pieces of the
 * photograph rather than thousands of two-pixel fragments.
 *
 * Measured by the previous implementation over ten ground-truth regions of real
 * photographs, using this as the *whole* fill scored mean RMSE 30.6 -> 20.3
 * against per-pixel synthesis. Here it is not the whole fill: it initialises the
 * nearest-neighbour field at the coarsest pyramid level, and PatchMatch then
 * refines a layout that already starts coherent instead of discovering one from
 * noise. Large-scale placement comes from labelling; texture comes from
 * matching.
 *
 * Two bugs are fixed relative to the version this is ported from. Coarse and
 * reserve candidates were pushed without their `sector`/`sectorCost` fields, so
 * (a) the per-sector seed sort was a NaN comparator and its `perSector[undefined]`
 * guard never skipped anything, promoting *every* coarse candidate to a seed and
 * degenerating the refine stage into the full-space sweep the comments say was
 * removed for costing 82% of runtime; and (b) the reserve ceiling compared
 * `undefined > ceiling` and so never rejected anything, which is how a strip of
 * frame edge ends up pasted through the middle of a fill.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};

  const GC_CAND_STEP = 4;
  const GC_CAND_COARSE = 16;
  const GC_CAND_SEEDS = 60;
  const GC_BAND_STRIDE = 6;
  const GC_CAND_KEEP = 24;
  // How many of the best candidates get a pixel-accurate polish pass.
  const GC_CAND_POLISH = 8;
  const GC_CAND_RESERVE = 12;
  const GC_CAND_MIN_SHIFT = 10;
  const GC_RESERVE_MAX_RATIO = 2.0;
  const GC_SECTORS = 8;
  const GC_SECTOR_MIN = 24;
  const GC_SEEDS_PER_SECTOR = 10;
  const GC_SECTOR_EXTRAS = 2;
  const GC_CAND_CLEAR = 0.6;
  const GC_BAND = 6;
  const GC_SMOOTH = 1.0;
  const GC_SWEEPS = 2;
  const GC_BIG = 1e7;
  const GC_MAX_LABEL_PX = 60000;

  /* Dedup key for a candidate translation.
   *
   * The previous encoding, (dx + 4096) * 8192 + (dy + 4096), silently collides
   * as soon as a shift can exceed 4096 px — the sweep runs to +/-max(width,
   * height), so any image larger than that is affected: (0, 4096) and
   * (1, -4096) both hash to 33562624, and one of the two translations is then
   * dropped as "already seen". SHIFT_SPAN covers any plausible image and the
   * product stays far inside the exact-integer range.
   */
  const SHIFT_SPAN = 32768;
  const shiftKey = (dx, dy) => (dx + SHIFT_SPAN) * (SHIFT_SPAN * 2 + 1) + (dy + SHIFT_SPAN);

  /* Dinic max-flow. The DFS uses an explicit stack; a recursive one overflows on
   * the graphs a large hole produces. */
  function flowGraph(n) {
    return {
      n,
      head: new Int32Array(n).fill(-1),
      to: [], cap: [], nxt: [],
      addNode() {
        const i = this.n++;
        if (i >= this.head.length) {
          const h = new Int32Array(Math.max(8, this.head.length * 2)).fill(-1);
          h.set(this.head);
          this.head = h;
        }
        this.head[i] = -1;
        return i;
      },
      edge(u, v, c, rc) {
        this.to.push(v); this.cap.push(c); this.nxt.push(this.head[u]); this.head[u] = this.to.length - 1;
        this.to.push(u); this.cap.push(rc || 0); this.nxt.push(this.head[v]); this.head[v] = this.to.length - 1;
      },
      mincut(s, t) {
        const { to, cap, nxt } = this;
        const level = new Int32Array(this.n), it = new Int32Array(this.n);
        const q = new Int32Array(this.n);
        const stack = new Int32Array(this.n + 2);
        for (;;) {
          level.fill(-1);
          let qh = 0, qt = 0;
          q[qt++] = s; level[s] = 0;
          while (qh < qt) {
            const u = q[qh++];
            for (let e = this.head[u]; e !== -1; e = nxt[e]) {
              if (cap[e] > 0 && level[to[e]] < 0) { level[to[e]] = level[u] + 1; q[qt++] = to[e]; }
            }
          }
          if (level[t] < 0) break;
          for (let i = 0; i < this.n; i++) it[i] = this.head[i];
          for (;;) {
            let sp = 0;
            stack[sp++] = s;
            while (sp > 0) {
              const u = stack[sp - 1];
              if (u === t) break;
              let advanced = false;
              for (; it[u] !== -1; it[u] = nxt[it[u]]) {
                const e = it[u], v = to[e];
                if (cap[e] > 0 && level[v] === level[u] + 1) { stack[sp++] = v; advanced = true; break; }
              }
              if (!advanced) { level[u] = -1; sp--; }
            }
            if (sp === 0) break;
            let f = Infinity;
            for (let i = 0; i + 1 < sp; i++) f = Math.min(f, cap[it[stack[i]]]);
            for (let i = 0; i + 1 < sp; i++) {
              const u = stack[i], e = it[u];
              cap[e] -= f; cap[e ^ 1] += f;
              if (cap[e] === 0) sp = i + 1;
            }
          }
        }
        const side = new Uint8Array(this.n);
        let qh = 0, qt = 0;
        q[qt++] = s; side[s] = 1;
        while (qh < qt) {
          const u = q[qh++];
          for (let e = this.head[u]; e !== -1; e = nxt[e]) {
            if (cap[e] > 0 && !side[to[e]]) { side[to[e]] = 1; q[qt++] = to[e]; }
          }
        }
        return side;
      },
    };
  }

  /* Known pixels within `width` of the hole: the ring the candidate shifts are
   * scored against. */
  function boundaryBand(w, h, mask, width) {
    const band = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mask[i]) continue;
        let near = false;
        for (let dy = -width; dy <= width && !near; dy++) {
          for (let dx = -width; dx <= width; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (mask[ny * w + nx]) { near = true; break; }
          }
        }
        if (near) band.push(i);
      }
    }
    return band;
  }

  /* Candidate translations, ranked by how well sliding the image by them makes
   * the ring around the hole agree with itself.
   *
   * The clearance rule is what makes them mean anything. Scoring on the ring
   * alone prefers near-identity shifts, because a twelve pixel slide makes
   * locally smooth content agree with itself almost perfectly — and then drags
   * the erased object's own silhouette back into the fill. Requiring a shift to
   * move the hole most of its own width or height off itself is what turns a
   * candidate into "bring content from somewhere else".
   *
   * `allowed` is the sampling mask (§17): a shift may only draw on pixels the
   * user left available, not merely on pixels outside the hole. */
  function candidates(w, h, img, mask, allowed, band, bbox, hole) {
    const clearX = bbox.width * GC_CAND_CLEAR, clearY = bbox.height * GC_CAND_CLEAR;
    const maxShift = Math.max(w, h);
    const bx = [], by = [];
    for (let k = 0; k < band.length; k += GC_BAND_STRIDE) { bx.push(band[k] % w); by.push((band[k] / w) | 0); }
    const bn = bx.length;
    const minOverlap = bn / 6;

    /* The ring around a hole is not one thing. A hole cutting through a horizon
     * has sky along its top edge and ground along its bottom, and a shift that
     * explains the sky perfectly explains the ground not at all. Scored against
     * the whole ring at once that shift averages out to mediocre and loses to
     * something mediocre everywhere, so the translations that would actually
     * rebuild each part never enter the candidate set.
     *
     * So the ring is cut into angular sectors and every shift is scored per
     * sector. Each sector contributes its own best shifts, and the labelling
     * assigns them per pixel — the unary compares a hole pixel against its own
     * known neighbours, so a pixel on the sky side prefers the sky shift without
     * being told which side it is on. */
    const cx = bbox.x0 + bbox.width / 2, cy = bbox.y0 + bbox.height / 2;
    const sector = new Int32Array(bn);
    const sectorN = new Int32Array(GC_SECTORS);
    for (let k = 0; k < bn; k++) {
      let a = Math.atan2(by[k] - cy, bx[k] - cx) / (2 * Math.PI);
      if (a < 0) a += 1;
      const s = Math.min(GC_SECTORS - 1, (a * GC_SECTORS) | 0);
      sector[k] = s;
      sectorN[s]++;
    }

    const errBuf = new Float64Array(GC_SECTORS), cntBuf = new Int32Array(GC_SECTORS);
    const score = (dx, dy) => {
      errBuf.fill(0); cntBuf.fill(0);
      let total = 0;
      for (let k = 0; k < bn; k++) {
        const qx = bx[k] + dx, qy = by[k] + dy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        if (!allowed[q]) continue;
        const a = (by[k] * w + bx[k]) * 4, b = q * 4;
        const dr = img[a] - img[b], dg = img[a + 1] - img[b + 1], db = img[a + 2] - img[b + 2];
        const s = sector[k];
        errBuf[s] += Math.sqrt(dr * dr + dg * dg + db * db);
        cntBuf[s]++;
        total++;
      }
      if (!total) return null;
      let all = 0, best = Infinity, bestSector = -1;
      for (let s = 0; s < GC_SECTORS; s++) {
        all += errBuf[s];
        if (cntBuf[s] < Math.max(GC_SECTOR_MIN, sectorN[s] / 4)) continue;
        const c = errBuf[s] / cntBuf[s];
        if (c < best) { best = c; bestSector = s; }
      }
      /* Two costs, and keeping them apart matters. `cost` is the whole ring, and
       * everything that guards against nonsense — ranking, the reserve ceiling —
       * uses it. `sectorCost` is the one sector this shift explains best, and it
       * is only ever used to make sure each region around the hole gets some
       * candidates of its own.
       *
       * Ranking on sectorCost instead was tried and measured much worse (mean
       * RMSE 18.2 -> 34.9): a shift that suits one narrow sector and nothing else
       * looks cheap, enters the pool ahead of genuinely good translations, and
       * slips under the ceiling. Per-sector candidates have to be an addition to
       * the pool, never a reordering of it. */
      return {
        cost: all / total,
        sectorCost: bestSector >= 0 ? best : all / total,
        sector: bestSector,
        thin: total < minOverlap,
      };
    };

    // Coarse sweep, then refine around the promising ones. Sweeping the whole
    // shift space at full step was 82% of this path's runtime for no quality.
    const coarse = [];
    const reserve = [];
    for (let dy = -maxShift; dy <= maxShift; dy += GC_CAND_COARSE) {
      for (let dx = -maxShift; dx <= maxShift; dx += GC_CAND_COARSE) {
        if (dx * dx + dy * dy < GC_CAND_MIN_SHIFT * GC_CAND_MIN_SHIFT) continue;
        const c = score(dx, dy);
        if (c === null) continue;
        const clears = Math.abs(dx) >= clearX || Math.abs(dy) >= clearY;
        // FIX: sector and sectorCost must travel with the candidate. Without
        // them the per-sector seeding below is a no-op and the reserve ceiling
        // never fires.
        const entry = { dx, dy, cost: c.cost, sectorCost: c.sectorCost, sector: c.sector };
        if (clears && !c.thin) coarse.push(entry);
        else reserve.push({ ...entry, cost: c.cost + (c.thin ? 1000 : 0) });
      }
    }
    coarse.sort((a, b) => a.cost - b.cost);
    reserve.sort((a, b) => a.cost - b.cost);

    // Globally best seeds, then a few more per sector on top. The extras are
    // what give a hole spanning several regions something to rebuild each of
    // them from; the global head still decides the bulk of the pool.
    const seeds = coarse.slice(0, GC_CAND_SEEDS);
    const seen = new Set(seeds.map(s => shiftKey(s.dx, s.dy)));
    const perSector = new Int32Array(GC_SECTORS);
    const bySectorCost = coarse.slice().sort((a, b) => a.sectorCost - b.sectorCost);
    for (const s of bySectorCost) {
      const sec = s.sector;
      if (sec < 0 || perSector[sec] >= GC_SEEDS_PER_SECTOR) continue;
      const key = shiftKey(s.dx, s.dy);
      if (seen.has(key)) continue;
      seen.add(key);
      perSector[sec]++;
      seeds.push(s);
    }

    const scored = [];
    const seenShift = new Set();
    for (const s of seeds) {
      for (let dy = s.dy - GC_CAND_COARSE; dy <= s.dy + GC_CAND_COARSE; dy += GC_CAND_STEP) {
        for (let dx = s.dx - GC_CAND_COARSE; dx <= s.dx + GC_CAND_COARSE; dx += GC_CAND_STEP) {
          if (Math.abs(dx) < clearX && Math.abs(dy) < clearY) continue;
          const key = shiftKey(dx, dy);
          if (seenShift.has(key)) continue;
          seenShift.add(key);
          const c = score(dx, dy);
          if (c !== null && !c.thin) scored.push({ dx, dy, cost: c.cost, sectorCost: c.sectorCost, sector: c.sector });
        }
      }
    }
    scored.sort((a, b) => a.cost - b.cost);

    /* Pixel-accurate polish on the best few.
     *
     * Everything above quantises translations to GC_CAND_STEP, which cannot
     * express a shift that is not a multiple of it — and periodic architecture
     * is precisely where this path should be strongest. A facade whose bays
     * repeat every 37 px has no multiple-of-four translation that lines the
     * mortar up, so the labelling settles one pixel out and the vertical line
     * arrives in the hole visibly broken. Measured on the reference facade that
     * showed as a straight-splice score of 34.4.
     *
     * Only the head of the list is polished, and only over a +/-3 window, so
     * this is a few hundred extra evaluations rather than the full-resolution
     * sweep whose cost the coarse/refine split exists to avoid. */
    const polished = [];
    for (const s of scored.slice(0, GC_CAND_POLISH)) {
      for (let dy = s.dy - GC_CAND_STEP + 1; dy <= s.dy + GC_CAND_STEP - 1; dy++) {
        for (let dx = s.dx - GC_CAND_STEP + 1; dx <= s.dx + GC_CAND_STEP - 1; dx++) {
          if (Math.abs(dx) < clearX && Math.abs(dy) < clearY) continue;
          const key = shiftKey(dx, dy);
          if (seenShift.has(key)) continue;
          seenShift.add(key);
          const c = score(dx, dy);
          if (c !== null && !c.thin) polished.push({ dx, dy, cost: c.cost, sectorCost: c.sectorCost, sector: c.sector });
        }
      }
    }
    if (polished.length) {
      scored.push(...polished);
      scored.sort((a, b) => a.cost - b.cost);
    }

    const spread = (GC_CAND_STEP * 2.5) * (GC_CAND_STEP * 2.5);
    const picked = [];
    const tooClose = s => {
      for (const p of picked) {
        if ((p.dx - s.dx) * (p.dx - s.dx) + (p.dy - s.dy) * (p.dy - s.dy) < spread) return true;
      }
      return false;
    };
    for (const s of scored) {
      if (picked.length >= GC_CAND_KEEP) break;
      if (!tooClose(s)) picked.push(s);
    }
    /* Then a couple of specialists per sector: the translations that rebuild one
     * region of a mixed hole — the sky above a horizon, say — which would never
     * survive whole-ring ranking. Appended, so they extend what the labelling may
     * choose from without displacing anything that earned its place. */
    const perSectorPicked = new Int32Array(GC_SECTORS);
    const bySectorScore = scored.slice().sort((a, b) => a.sectorCost - b.sectorCost);
    for (const s of bySectorScore) {
      if (picked.length >= GC_CAND_KEEP + GC_SECTOR_EXTRAS * GC_SECTORS) break;
      const sec = s.sector;
      if (sec < 0 || perSectorPicked[sec] >= GC_SECTOR_EXTRAS) continue;
      if (tooClose(s)) continue;
      perSectorPicked[sec]++;
      picked.push(s);
    }
    picked.sort((a, b) => a.cost - b.cost);

    /* Every hole pixel needs at least one translation that lands it on legal
     * content, or the labelling has nothing to assign. Cheapest shifts first
     * leaves awkward corners uncovered, so the coarse list is walked as a
     * reserve until nothing is stranded — but not at any price. A reserve shift
     * that disagrees with the surroundings far more than the best candidate is
     * not continuing the scene, it is importing something unrelated. */
    const covers = (s, p) => {
      const x = p % w + s.dx, y = ((p / w) | 0) + s.dy;
      return x >= 0 && y >= 0 && x < w && y < h && allowed[y * w + x];
    };
    const uncovered = [];
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      let ok = false;
      for (const s of picked) if (covers(s, p)) { ok = true; break; }
      if (!ok) uncovered.push(p);
    }
    if (uncovered.length) {
      let bestSector = Infinity;
      for (const p of picked) if (p.sectorCost < bestSector) bestSector = p.sectorCost;
      const ceiling = picked.length ? bestSector * GC_RESERVE_MAX_RATIO : Infinity;
      for (const s of coarse.concat(reserve)) {
        if (!uncovered.length || picked.length >= GC_CAND_KEEP + GC_CAND_RESERVE) break;
        // FIX: sectorCost is now present, so this ceiling actually rejects.
        if (s.sectorCost > ceiling) continue;
        let gain = 0;
        for (const p of uncovered) if (covers(s, p)) gain++;
        if (!gain) continue;
        picked.push(s);
        for (let i = uncovered.length - 1; i >= 0; i--) if (covers(s, uncovered[i])) uncovered.splice(i, 1);
      }
      if (uncovered.length) return [];      // no translation reaches part of this hole
    }
    return picked;
  }

  // How visible a seam between p and q would be if p took shift a and q took shift b.
  function pairCost(w, h, img, allowed, p, q, a, b, shifts) {
    if (a === b) return 0;
    const sa = shifts[a], sb = shifts[b];
    let c = 0;
    for (let t = 0; t < 2; t++) {
      const r = t === 0 ? p : q;
      const x = r % w, y = (r / w) | 0;
      const ax = x + sa.dx, ay = y + sa.dy, bx = x + sb.dx, by = y + sb.dy;
      if (ax < 0 || ay < 0 || ax >= w || ay >= h || bx < 0 || by < 0 || bx >= w || by >= h) { c += 255; continue; }
      const ia = ay * w + ax, ib = by * w + bx;
      if (!allowed[ia] || !allowed[ib]) { c += 255; continue; }
      const u = ia * 4, v = ib * 4;
      const dr = img[u] - img[v], dg = img[u + 1] - img[v + 1], db = img[u + 2] - img[v + 2];
      c += Math.sqrt(dr * dr + dg * dg + db * db);
    }
    return c;
  }

  /* Alpha-expansion over the shift labels. The `lp !== lq` case is non-submodular,
   * so it gets the standard auxiliary node. */
  function label(w, h, img, allowed, hole, shifts) {
    const L = shifts.length, n = hole.length;
    if (!L || !n) return null;
    const idx = new Int32Array(w * h).fill(-1);
    for (let k = 0; k < n; k++) idx[hole[k]] = k;

    const valid = new Uint8Array(n * L);
    const unary = new Float32Array(n * L);
    for (let k = 0; k < n; k++) {
      const p = hole[k], x = p % w, y = (p / w) | 0;
      for (let l = 0; l < L; l++) {
        const qx = x + shifts[l].dx, qy = y + shifts[l].dy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h || !allowed[qy * w + qx]) { unary[k * L + l] = GC_BIG; continue; }
        valid[k * L + l] = 1;
        let c = 0;
        for (let t = 0; t < 4; t++) {
          const nx = x + (t === 0 ? -1 : t === 1 ? 1 : 0);
          const ny = y + (t === 2 ? -1 : t === 3 ? 1 : 0);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const r = ny * w + nx;
          if (!allowed[r]) continue;
          const sx = nx + shifts[l].dx, sy = ny + shifts[l].dy;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h || !allowed[sy * w + sx]) { c += 255; continue; }
          const a = r * 4, b = (sy * w + sx) * 4;
          const dr = img[a] - img[b], dg = img[a + 1] - img[b + 1], db = img[a + 2] - img[b + 2];
          c += Math.sqrt(dr * dr + dg * dg + db * db);
        }
        unary[k * L + l] = c;
      }
    }

    const labels = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      let best = -1, bc = Infinity;
      for (let l = 0; l < L; l++) if (valid[k * L + l] && unary[k * L + l] < bc) { bc = unary[k * L + l]; best = l; }
      if (best < 0) return null;              // this pixel has no usable translation
      labels[k] = best;
    }

    const pa = [], pb = [];
    for (let k = 0; k < n; k++) {
      const p = hole[k], x = p % w, y = (p / w) | 0;
      if (x + 1 < w) { const j = idx[y * w + x + 1]; if (j >= 0) { pa.push(k); pb.push(j); } }
      if (y + 1 < h) { const j = idx[(y + 1) * w + x]; if (j >= 0) { pa.push(k); pb.push(j); } }
    }

    for (let s = 0; s < GC_SWEEPS; s++) {
      let changed = 0;
      for (let alpha = 0; alpha < L; alpha++) {
        const f = flowGraph(n);
        const S = f.addNode(), T = f.addNode();
        for (let k = 0; k < n; k++) {
          f.edge(S, k, unary[k * L + labels[k]], 0);
          f.edge(k, T, valid[k * L + alpha] ? unary[k * L + alpha] : GC_BIG, 0);
        }
        for (let m = 0; m < pa.length; m++) {
          const k = pa[m], j = pb[m], p = hole[k], q = hole[j];
          const lp = labels[k], lq = labels[j];
          if (lp === lq) {
            if (lp === alpha) continue;
            const c = GC_SMOOTH * pairCost(w, h, img, allowed, p, q, lp, alpha, shifts);
            if (c > 0) f.edge(k, j, c, c);
          } else {
            const a = f.addNode();
            const cpa = GC_SMOOTH * pairCost(w, h, img, allowed, p, q, lp, alpha, shifts);
            const caq = GC_SMOOTH * pairCost(w, h, img, allowed, p, q, alpha, lq, shifts);
            const cpq = GC_SMOOTH * pairCost(w, h, img, allowed, p, q, lp, lq, shifts);
            f.edge(k, a, cpa, cpa);
            f.edge(a, j, caq, caq);
            f.edge(a, T, cpq, 0);
          }
        }
        const side = f.mincut(S, T);
        for (let k = 0; k < n; k++) {
          if (side[k] && labels[k] !== alpha && valid[k * L + alpha]) { labels[k] = alpha; changed++; }
        }
      }
      if (!changed) break;
    }
    return labels;
  }

  function downsampleBy(pixels, mask, allowed, w, h, f, nw, nh) {
    const out = new Uint8ClampedArray(nw * nh * 4);
    const om = new Uint8Array(nw * nh);
    const oa = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, n = 0, holeCount = 0, allowCount = 0, cells = 0;
        for (let dy = 0; dy < f; dy++) {
          const sy = y * f + dy;
          if (sy >= h) break;
          for (let dx = 0; dx < f; dx++) {
            const sx = x * f + dx;
            if (sx >= w) break;
            cells++;
            const i = sy * w + sx;
            if (allowed[i]) allowCount++;
            if (mask[i]) { holeCount++; continue; }
            const p = i * 4;
            r += pixels[p]; g += pixels[p + 1]; b += pixels[p + 2]; n++;
          }
        }
        const d = (y * nw + x) * 4;
        if (n) { out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; }
        out[d + 3] = 255;
        om[y * nw + x] = holeCount > cells / 2 ? 1 : 0;
        oa[y * nw + x] = (!om[y * nw + x] && allowCount > cells / 2) ? 1 : 0;
      }
    }
    return { pixels: out, mask: om, allowed: oa };
  }

  /* Solves the labelling on a reduced grid when the hole is large, then scales
   * the label map back. Labels are piecewise constant over big regions, so this
   * costs almost nothing in layout quality and keeps alpha-expansion off graphs
   * it cannot afford. */
  function labelScaled(w, h, img, mask, allowed, hole, shifts) {
    if (hole.length <= GC_MAX_LABEL_PX) return label(w, h, img, allowed, hole, shifts);
    const f = Math.ceil(Math.sqrt(hole.length / GC_MAX_LABEL_PX));
    const lw = Math.max(1, Math.ceil(w / f)), lh = Math.max(1, Math.ceil(h / f));
    const small = downsampleBy(img, mask, allowed, w, h, f, lw, lh);
    const sHole = [];
    for (let i = 0; i < lw * lh; i++) if (small.mask[i]) sHole.push(i);
    if (!sHole.length) return null;
    const sShifts = shifts.map(s => ({ dx: Math.round(s.dx / f), dy: Math.round(s.dy / f) }));
    const sLabel = label(lw, lh, small.pixels, small.allowed, sHole, sShifts);
    if (!sLabel) return null;
    const map = new Int32Array(lw * lh).fill(-1);
    for (let k = 0; k < sHole.length; k++) map[sHole[k]] = sLabel[k];
    const out = new Int32Array(hole.length);
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      const x = Math.min(lw - 1, ((p % w) / f) | 0);
      const y = Math.min(lh - 1, (((p / w) | 0) / f) | 0);
      const l = map[y * lw + x];
      out[k] = l >= 0 ? l : 0;
    }
    return out;
  }

  /* The public entry: propose translations, label the hole with them, and hand
   * back both so the NNF can be seeded. Returns null whenever the hole cannot be
   * covered, in which case PatchMatch starts from a random field instead. */
  function solve(w, h, img, mask, allowed, hole, bbox) {
    if (!hole.length) return null;
    const band = boundaryBand(w, h, mask, GC_BAND);
    if (band.length < 64) return null;
    const shifts = candidates(w, h, img, mask, allowed, band, bbox, hole);
    if (!shifts.length) return null;
    const labels = labelScaled(w, h, img, mask, allowed, hole, shifts);
    if (!labels) return null;
    return { shifts, labels, bandSize: band.length };
  }

  CAF.shiftLabeling = {
    GC_BAND,
    GC_SECTORS,
    GC_MAX_LABEL_PX,
    flowGraph,
    boundaryBand,
    candidates,
    pairCost,
    label,
    labelScaled,
    solve,
  };
})(typeof self !== 'undefined' ? self : globalThis);
