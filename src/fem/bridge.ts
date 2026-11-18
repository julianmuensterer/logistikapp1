/**
 * Simplified 2D finite element model of the Viaduc de Millau.
 *
 * Two plane models are combined:
 *  1. Vertical (elevation) model: deck, pylons and piers as beams, stays as trusses.
 *     Load cases: self-weight G and a unit traffic area load Q = 1 kN/m².
 *  2. Lateral (plan) model: the deck as a continuous beam bending about its vertical
 *     axis, resting on the piers, which act as lateral springs (stepped cantilevers).
 *     Load case: unit wind pressure 1 kN/m².
 *
 * Everything is linear, so results for any traffic load q and wind speed v are a
 * superposition of the unit cases. This makes the sliders real-time and lets us
 * compute the tolerable traffic load exactly.
 *
 * All section properties are rounded teaching values, not design data.
 */
import { Frame2D, type ElementLoad, type Solution } from './frame2d';

// ---------- Geometry (real values, rounded) ----------
export const SPANS = [204, 342, 342, 342, 342, 342, 342, 204];
export const PIER_HEIGHTS = [94.5, 245.0, 221.1, 144.2, 136.4, 111.9, 77.6]; // P1..P7 [m]
export const PIER_X: number[] = (() => {
  const xs: number[] = [];
  let x = 0;
  for (let k = 0; k < SPANS.length - 1; k++) {
    x += SPANS[k];
    xs.push(x);
  }
  return xs;
})();
export const BRIDGE_LENGTH = SPANS.reduce((a, b) => a + b, 0); // 2460 m
export const PYLON_HEIGHT = 87; // above deck [m]
export const DECK_WIDTH = 32; // [m]
export const DECK_DEPTH = 4.2; // [m]
/** Width of the deck that carries the traffic area load (4 lanes + hard shoulders). */
export const TRAFFIC_WIDTH = 24; // [m]
export const STAYS_PER_SIDE = 11;
/** Horizontal distance of stay anchor k from its pylon [m]. */
export const stayAnchorOffset = (k: number) => 30 + 12.5 * k;
/** Height of stay anchor k on the pylon above the deck [m]. */
export const stayPylonHeight = (k: number) => 55 + 3 * k;
/** Number of 150 mm² strands in stay k (real: 55 to 91 strands). */
export const stayStrands = (k: number) => Math.round(55 + (36 * k) / (STAYS_PER_SIDE - 1));
/** Length of the split upper part of a pier [m]. */
export const splitLength = (H: number) => Math.min(90, 0.4 * H);

// ---------- Materials ----------
export const STEEL = { E: 210e6, fy: 355e3, gamma: 78.5 }; // kN/m², kN/m², kN/m³
export const STRAND = { E: 195e6, fuk: 1860e3 };
export const CONCRETE = { E: 38e6, fck: 60e3, gamma: 25 };

// ---------- Sections (rounded teaching values) ----------
export const SECTIONS = {
  deck: { A: 1.5, I: 4.5, W: 1.8, Iz: 70, Wz: 4.4 },
  pylon: { A: 1.0, I: 20, W: 4, Wtr: 1.5 },
  pierLower: { A: 55, I: 2500, W: 300, Itr: 4000, Wtr: 350, windWidth: 17 },
  pierSplit: { A: 30, I: 80, W: 40, Itr: 600, Wtr: 110, windWidth: 12 },
};

// ---------- Permanent loads ----------
/** Deck self-weight incl. surfacing, barriers and wind screens [kN/m]. */
export const DECK_DEAD_LOAD = 200;
export const PYLON_DEAD_LOAD = 74; // 4,600 t / 7 / 87 m ≈ 7.5 t/m

// ---------- Wind ----------
export const AIR_DENSITY = 1.25; // kg/m³
export const CD = { deck: 1.5, pylon: 2.0, pier: 1.5 };
/** Height exposed to wind: deck + vehicles / wind screens [m] */
export const DECK_WIND_HEIGHT = 6.2;
export const PYLON_WIND_WIDTH = 4;
/** Wind pressure [kN/m²] for a wind speed in km/h. */
export const windPressure = (kmh: number) => (0.5 * AIR_DENSITY * (kmh / 3.6) ** 2) / 1000;

// ---------- Safety factors ----------
export const FACTORS = {
  on: { G: 1.35, Q: 1.5, W: 1.5, steel: 1.0, strand: 1.5, concrete: 1.5 / 0.85 },
  off: { G: 1, Q: 1, W: 1, steel: 1, strand: 1, concrete: 1 },
};

export const G_ACC = 9.81;
export const kNtoTonnes = (kN: number) => kN / G_ACC;

export type Part = 'deck' | 'stay' | 'pylon' | 'pier';

export interface ModelElement {
  index: number; // element index in the vertical model
  part: Part;
  label: string;
  /** For stays: pylon number (0-based), side (-1 left, +1 right) and stay number k */
  stay?: { pylon: number; side: -1 | 1; k: number };
  pier?: { pier: number; zTopI: number; zTopJ: number; split: boolean };
  pylon?: { pylon: number; hI: number; hJ: number };
  deckIndex?: number; // element index in the lateral model
}

interface CheckPoint {
  element: number;
  where: 'i' | 'm' | 'j';
  /** stress per unit load case, for the two extreme fibres (+W and -W side) */
  sG: [number, number];
  sQ: [number, number];
  /** lateral stress magnitude per kN/m² wind pressure */
  sW: number;
  material: 'steel' | 'strand' | 'concrete';
  tensionOnly: boolean;
}

export interface Evaluation {
  /** utilization per element (max over its check points) */
  eta: Float64Array;
  maxEta: number;
  governing: number; // element index
  /** tolerable characteristic traffic area load at the current wind [kN/m²] */
  qMax: number;
  qMaxGoverning: number;
  /** vertical displacement field for current loads (characteristic) */
  displacement: (dof: number) => number;
}

export class BridgeModel {
  vertical = new Frame2D();
  lateral = new Frame2D();
  elements: ModelElement[] = [];
  deckNodes: number[] = []; // vertical model node indices along the deck (sorted by x)
  pylonTopNodes: number[] = [];
  solG!: Solution;
  solQ!: Solution;
  solW!: Solution;
  checks: CheckPoint[] = [];
  /** lateral reactions at the piers per unit wind pressure (deck only) [kN] */
  pierReactionW: number[] = [];

  constructor() {
    this.buildVertical();
    this.buildLateral();
    this.solveUnitCases();
    this.buildChecks();
  }

  private buildVertical(): void {
    const m = this.vertical;
    // --- deck node positions: abutments, piers, stay anchors, max 15 m apart
    const xs = new Set<number>([0, BRIDGE_LENGTH, ...PIER_X]);
    for (const xp of PIER_X)
      for (let k = 0; k < STAYS_PER_SIDE; k++) {
        xs.add(xp - stayAnchorOffset(k));
        xs.add(xp + stayAnchorOffset(k));
      }
    let sorted = [...xs].sort((a, b) => a - b);
    const refined: number[] = [];
    for (let t = 0; t < sorted.length; t++) {
      if (t > 0) {
        const gap = sorted[t] - sorted[t - 1];
        const parts = Math.ceil(gap / 15);
        for (let p = 1; p < parts; p++) refined.push(sorted[t - 1] + (gap * p) / parts);
      }
      refined.push(sorted[t]);
    }
    sorted = refined;
    const nodeAtX = new Map<number, number>();
    for (const x of sorted) {
      const n = m.addNode(x, 0);
      nodeAtX.set(x, n);
      this.deckNodes.push(n);
    }
    const d = SECTIONS.deck;
    for (let t = 0; t < this.deckNodes.length - 1; t++) {
      const idx = m.addElement({ type: 'beam', i: this.deckNodes[t], j: this.deckNodes[t + 1], E: STEEL.E, A: d.A, I: d.I });
      const xm = (sorted[t] + sorted[t + 1]) / 2;
      this.elements.push({ index: idx, part: 'deck', label: `Deck segment at x = ${xm.toFixed(0)} m`, deckIndex: t });
    }
    // supports at abutments
    m.supports.push({ node: this.deckNodes[0], ux: true, uy: true });
    m.supports.push({ node: this.deckNodes[this.deckNodes.length - 1], uy: true });

    PIER_X.forEach((xp, p) => {
      const deckNode = nodeAtX.get(xp)!;
      // --- pylon
      const heights = [0, 20, 40];
      for (let k = 0; k < STAYS_PER_SIDE; k++) heights.push(stayPylonHeight(k));
      heights.push(PYLON_HEIGHT);
      const pyNodes = [deckNode];
      for (const h of heights.slice(1)) pyNodes.push(m.addNode(xp, h));
      this.pylonTopNodes.push(pyNodes[pyNodes.length - 1]);
      const ps = SECTIONS.pylon;
      for (let t = 0; t < pyNodes.length - 1; t++) {
        const idx = m.addElement({ type: 'beam', i: pyNodes[t], j: pyNodes[t + 1], E: STEEL.E, A: ps.A, I: ps.I });
        this.elements.push({
          index: idx, part: 'pylon', label: `Pylon P${p + 1}, ${heights[t].toFixed(0)}–${heights[t + 1].toFixed(0)} m above deck`,
          pylon: { pylon: p, hI: heights[t], hJ: heights[t + 1] },
        });
      }
      // --- stays
      for (const side of [-1, 1] as const)
        for (let k = 0; k < STAYS_PER_SIDE; k++) {
          const anchor = nodeAtX.get(xp + side * stayAnchorOffset(k))!;
          const top = pyNodes[3 + k];
          const A = stayStrands(k) * 150e-6;
          const idx = m.addElement({ type: 'truss', i: anchor, j: top, E: STRAND.E, A, I: 0 });
          this.elements.push({
            index: idx, part: 'stay', label: `Stay cable P${p + 1} ${side < 0 ? 'west' : 'east'} #${k + 1} (${stayStrands(k)} strands)`,
            stay: { pylon: p, side, k },
          });
        }
      // --- pier (z measured downwards from the deck)
      const H = PIER_HEIGHTS[p];
      const s = splitLength(H);
      const zs = [0, s / 3, (2 * s) / 3, s];
      for (let t = 1; t <= 5; t++) zs.push(s + ((H - s) * t) / 5);
      const pierNodes = [deckNode];
      for (const z of zs.slice(1)) pierNodes.push(m.addNode(xp, -z));
      for (let t = 0; t < pierNodes.length - 1; t++) {
        const split = zs[t + 1] <= s + 1e-6;
        const sec = split ? SECTIONS.pierSplit : SECTIONS.pierLower;
        const idx = m.addElement({ type: 'beam', i: pierNodes[t], j: pierNodes[t + 1], E: CONCRETE.E, A: sec.A, I: sec.I });
        this.elements.push({
          index: idx, part: 'pier', label: `Pier P${p + 1}, ${split ? 'split upper legs' : 'main shaft'}, ${zs[t].toFixed(0)}–${zs[t + 1].toFixed(0)} m below deck`,
          pier: { pier: p, zTopI: zs[t], zTopJ: zs[t + 1], split },
        });
      }
      m.supports.push({ node: pierNodes[pierNodes.length - 1], ux: true, uy: true, rz: true });
    });
  }

  private buildLateral(): void {
    const m = this.lateral;
    const d = SECTIONS.deck;
    const nodes = this.deckNodes.map((n) => m.addNode(this.vertical.nodes[n].x, 0));
    for (let t = 0; t < nodes.length - 1; t++)
      m.addElement({ type: 'beam', i: nodes[t], j: nodes[t + 1], E: STEEL.E, A: d.A, I: d.Iz });
    m.supports.push({ node: nodes[0], ux: true, uy: true });
    m.supports.push({ node: nodes[nodes.length - 1], uy: true });
    // piers as lateral springs: stepped cantilever, tip flexibility
    PIER_X.forEach((xp, p) => {
      const H = PIER_HEIGHTS[p];
      const s = splitLength(H);
      const flex =
        s ** 3 / (3 * CONCRETE.E * SECTIONS.pierSplit.Itr) +
        (H ** 3 - s ** 3) / (3 * CONCRETE.E * SECTIONS.pierLower.Itr);
      const node = this.deckNodes.findIndex((n) => Math.abs(this.vertical.nodes[n].x - xp) < 1e-6);
      m.supports.push({ node: nodes[node], ky: 1 / flex });
    });
  }

  private solveUnitCases(): void {
    const v = this.vertical;
    const deckLoads = (q: number): ElementLoad[] =>
      this.elements.filter((e) => e.part === 'deck').map((e) => ({ element: e.index, qx: 0, qy: -q }));
    const g: ElementLoad[] = [...deckLoads(DECK_DEAD_LOAD)];
    for (const e of this.elements) {
      if (e.part === 'pylon') g.push({ element: e.index, qx: 0, qy: -PYLON_DEAD_LOAD });
      if (e.part === 'pier') {
        const sec = e.pier!.split ? SECTIONS.pierSplit : SECTIONS.pierLower;
        g.push({ element: e.index, qx: 0, qy: -sec.A * CONCRETE.gamma });
      }
    }
    // Self-weight: the real stays are pre-tensioned so that the deck sits in its target
    // shape. We mimic this by solving the dead-load case with very stiff stays.
    const stays = this.elements.filter((e) => e.part === 'stay').map((e) => v.elements[e.index]);
    const originalA = stays.map((s) => s.A);
    stays.forEach((s) => (s.A *= 50));
    [this.solG] = v.solve([{ distributed: g }]);
    stays.forEach((s, t) => (s.A = originalA[t]));
    [this.solQ] = v.solve([{ distributed: deckLoads(TRAFFIC_WIDTH * 1) }]);
    // Lateral: unit wind pressure on the deck
    const w = CD.deck * DECK_WIND_HEIGHT;
    const lat = this.lateral;
    [this.solW] = lat.solve([{ distributed: lat.elements.map((_, t) => ({ element: t, qx: 0, qy: w })) }]);
    this.pierReactionW = PIER_X.map((xp) => {
      const t = lat.nodes.findIndex((n) => Math.abs(n.x - xp) < 1e-6);
      return Math.abs(this.solW.reactions[t * 3 + 1]);
    });
  }

  /** Lateral moment in a pier at depth z below the deck per unit wind pressure [kNm]. */
  pierLateralMoment(p: number, z: number): number {
    const H = PIER_HEIGHTS[p];
    const s = splitLength(H);
    const ws = CD.pier * SECTIONS.pierSplit.windWidth;
    const wl = CD.pier * SECTIONS.pierLower.windWidth;
    const pylonShear = CD.pylon * PYLON_WIND_WIDTH * PYLON_HEIGHT;
    const pylonMoment = (CD.pylon * PYLON_WIND_WIDTH * PYLON_HEIGHT ** 2) / 2;
    const R = this.pierReactionW[p] + pylonShear;
    const wind = z <= s ? (ws * z * z) / 2 : ws * s * (z - s / 2) + (wl * (z - s) ** 2) / 2;
    return R * z + pylonMoment + wind;
  }

  private buildChecks(): void {
    const sec = SECTIONS;
    for (const e of this.elements) {
      const fG = this.solG.forces[e.index];
      const fQ = this.solQ.forces[e.index];
      if (e.part === 'stay') {
        const A = this.vertical.elements[e.index].A;
        this.checks.push({ element: e.index, where: 'm', sG: [fG.N / A, fG.N / A], sQ: [fQ.N / A, fQ.N / A], sW: 0, material: 'strand', tensionOnly: true });
        continue;
      }
      let A: number, W: number;
      let lat: (where: 'i' | 'm' | 'j') => number;
      let material: CheckPoint['material'] = 'steel';
      if (e.part === 'deck') {
        A = sec.deck.A; W = sec.deck.W;
        const fw = this.solW.forces[e.deckIndex!];
        lat = (wh) => Math.abs(wh === 'i' ? fw.Mi : wh === 'j' ? fw.Mj : fw.Mm) / sec.deck.Wz;
      } else if (e.part === 'pylon') {
        A = sec.pylon.A; W = sec.pylon.W;
        const { hI, hJ } = e.pylon!;
        const w = CD.pylon * PYLON_WIND_WIDTH;
        const m = (h: number) => (w * (PYLON_HEIGHT - h) ** 2) / 2 / sec.pylon.Wtr;
        lat = (wh) => m(wh === 'i' ? hI : wh === 'j' ? hJ : (hI + hJ) / 2);
      } else {
        const ps = e.pier!.split ? sec.pierSplit : sec.pierLower;
        A = ps.A; W = ps.W; material = 'concrete';
        const { pier, zTopI, zTopJ } = e.pier!;
        lat = (wh) => this.pierLateralMoment(pier, wh === 'i' ? zTopI : wh === 'j' ? zTopJ : (zTopI + zTopJ) / 2) / ps.Wtr;
      }
      for (const where of ['i', 'm', 'j'] as const) {
        const MG = where === 'i' ? fG.Mi : where === 'j' ? fG.Mj : fG.Mm;
        const MQ = where === 'i' ? fQ.Mi : where === 'j' ? fQ.Mj : fQ.Mm;
        this.checks.push({
          element: e.index, where,
          sG: [fG.N / A + MG / W, fG.N / A - MG / W],
          sQ: [fQ.N / A + MQ / W, fQ.N / A - MQ / W],
          sW: lat(where), material, tensionOnly: false,
        });
      }
    }
  }

  strength(material: CheckPoint['material'], safety: boolean): number {
    const f = safety ? FACTORS.on : FACTORS.off;
    if (material === 'steel') return STEEL.fy / f.steel;
    if (material === 'strand') return STRAND.fuk / f.strand;
    return CONCRETE.fck / f.concrete;
  }

  /** Evaluate utilizations for traffic load q [kN/m²] and wind speed [km/h]. */
  evaluate(q: number, windKmh: number, safety: boolean): Evaluation {
    const f = safety ? FACTORS.on : FACTORS.off;
    const pw = windPressure(windKmh);
    const eta = new Float64Array(this.vertical.elements.length);
    let qMax = Infinity;
    let qMaxGoverning = -1;
    for (const c of this.checks) {
      const fs = this.strength(c.material, safety);
      const C = f.W * pw * c.sW;
      for (let side = 0; side < 2; side++) {
        const a = f.G * c.sG[side];
        const b = f.Q * c.sQ[side];
        let s: number, lam: number;
        if (c.tensionOnly) {
          s = Math.max(0, a + q * b);
          lam = b > 0 ? (fs - a) / b : Infinity;
        } else {
          s = Math.abs(a + q * b) + C;
          if (Math.abs(a) + C >= fs) lam = 0;
          else lam = b === 0 ? Infinity : (fs - C - Math.sign(b) * a) / Math.abs(b);
        }
        lam = Math.max(0, lam);
        const u = s / fs;
        if (u > eta[c.element]) eta[c.element] = u;
        if (lam < qMax) { qMax = lam; qMaxGoverning = c.element; }
      }
    }
    let maxEta = 0, governing = 0;
    eta.forEach((v, i) => { if (v > maxEta) { maxEta = v; governing = i; } });
    if (qMax === 0) qMaxGoverning = governing;
    const gU = this.solG.u, qU = this.solQ.u;
    return { eta, maxEta, governing, qMax, qMaxGoverning, displacement: (dof) => gU[dof] + q * qU[dof] };
  }

  /** Lateral deck displacement for a wind speed [m] at deck node t (characteristic). */
  lateralDisplacement(t: number, windKmh: number): number {
    return this.solW.u[t * 3 + 1] * windPressure(windKmh);
  }

  element(index: number): ModelElement {
    return this.elements.find((e) => e.index === index)!;
  }

  /** Total traffic load on the deck for an area load q [kN]. */
  static trafficTotal(q: number): number {
    return q * TRAFFIC_WIDTH * BRIDGE_LENGTH;
  }
}
