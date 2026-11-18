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
import { Frame2D, type ElementLoad, type NodalLoad, type Solution } from './frame2d';
import { lowestModes, type Mode } from './modal';

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
export const stayPylonHeight = (k: number) => 40 + 3 * k;
/** The pylon stands on the deck with two inverted-Y legs, 38.5 m high, spread ±9 m at the deck. */
export const PYLON_LEG_HEIGHT = 38.5;
export const PYLON_LEG_SPREAD = 5.5;
/** The split upper part of a pier consists of two shafts at ±5.5 m, right below the pylon legs. */
export const PIER_SHAFT_SPREAD = 5.5;
/** Number of 150 mm² strands in stay k (real: 55 to 91 strands). */
export const stayStrands = (k: number) => Math.round(55 + (36 * k) / (STAYS_PER_SIDE - 1));
/** Length of the split upper part of a pier [m] (90 m; P7 is split over its full height). */
export const splitLength = (H: number) => Math.min(90, H);

// ---------- Materials ----------
export const STEEL = { E: 210e6, fy: 355e3, gamma: 78.5 }; // kN/m², kN/m², kN/m³
export const STRAND = { E: 195e6, fuk: 1860e3 };
export const CONCRETE = { E: 38e6, fck: 60e3, gamma: 25 };

// ---------- Sections (rounded teaching values) ----------
export const SECTIONS = {
  deck: { A: 1.5, I: 4.5, W: 1.8, Iz: 70, Wz: 4.4 },
  pylon: { A: 1.0, I: 20, W: 4, Wtr: 1.5 },
  /** one of the two inverted-Y legs */
  pylonLeg: { A: 0.6, I: 4, W: 1.2, Wtr: 0.9 },
  pierLower: { A: 80, I: 2500, W: 300, Itr: 4000, Wtr: 350, windWidth: 17 },
  /** both shafts of the split part together (each shaft has half of A, I and W) */
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
  pier?: { pier: number; zTopI: number; zTopJ: number; split: boolean; shaft?: -1 | 1; transition?: boolean };
  pylon?: { pylon: number; hI: number; hJ: number; leg?: boolean };
  deckIndex?: number; // element index in the lateral model
}

interface CheckPoint {
  element: number;
  where: 'i' | 'm' | 'j';
  /** stress per unit load case, for the two extreme fibres (+W and -W side) */
  sG: [number, number];
  /** part of sG caused by the stay pretension */
  sP: [number, number];
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
  /** pretension alone (part of solG); factored with γP = 1.0 instead of γG */
  solP!: Solution;
  solW!: Solution;
  checks: CheckPoint[] = [];
  /** stay pretension force per stay element [kN] */
  stayPretension = new Map<number, number>();
  /** lateral reactions at the piers per unit wind pressure (deck only) [kN] */
  pierReactionW: number[] = [];

  /** maximum element length [m] (mesh refinement) */
  readonly meshSize: number;
  /** stays removed with the scissors, keys "pylon:side:k" */
  readonly cutStays: ReadonlySet<string>;
  /** geometry of removed stays (for drawing the cut ends) */
  cutStayGeometry: { key: string; deckNode: number; topNode: number }[] = [];
  /** self-weight per unit length for every vertical-model element [kN/m] (for masses) */
  lineWeight: number[] = [];
  /** time needed to assemble and solve the unit load cases [ms] */
  solveMs = 0;

  constructor(options: { meshSize?: number; cutStays?: ReadonlySet<string> } = {}) {
    this.meshSize = options.meshSize ?? 15;
    this.cutStays = options.cutStays ?? new Set();
    const t0 = performance.now();
    this.buildVertical();
    this.buildLateral();
    this.solveUnitCases();
    this.solveMs = performance.now() - t0;
    this.buildChecks();
  }

  /**
   * Natural modes of both plane models (lumped masses from the self-weight).
   * Vertical model: in-plane (vertical/longitudinal) modes. Lateral model: sideways
   * deck modes; the piers contribute their stiffness and ~24 % of their mass.
   */
  modes(count = 4): { kind: 'vertical' | 'lateral'; mode: Mode }[] {
    if (this.modeCache) return this.modeCache;
    const v = this.vertical;
    const mv = new Float64Array(v.dofCount);
    v.elements.forEach((el, idx) => {
      const { L } = v.geometry(el);
      const half = (this.lineWeight[idx] * L) / G_ACC / 2; // [t]
      for (const node of [el.i, el.j]) {
        mv[node * 3] += half;
        mv[node * 3 + 1] += half;
      }
    });
    const lat = this.lateral;
    const ml = new Float64Array(lat.dofCount);
    lat.elements.forEach((el) => {
      const { L } = lat.geometry(el);
      const half = (DECK_DEAD_LOAD * L) / G_ACC / 2;
      ml[el.i * 3 + 1] += half;
      ml[el.j * 3 + 1] += half;
    });
    PIER_X.forEach((xp, p) => {
      const t = lat.nodes.findIndex((n) => Math.abs(n.x - xp) < 1e-6);
      const H = PIER_HEIGHTS[p];
      const sH = splitLength(H);
      const pierMass = (SECTIONS.pierSplit.A * sH + SECTIONS.pierLower.A * (H - sH)) * CONCRETE.gamma / G_ACC;
      ml[t * 3 + 1] += 0.24 * pierMass + (PYLON_DEAD_LOAD * PYLON_HEIGHT) / G_ACC;
    });
    this.modeCache = [
      ...lowestModes(v, mv, count).map((mode) => ({ kind: 'vertical' as const, mode })),
      ...lowestModes(lat, ml, count).map((mode) => ({ kind: 'lateral' as const, mode })),
    ].sort((a, b) => a.mode.f - b.mode.f);
    return this.modeCache;
  }

  private modeCache?: { kind: 'vertical' | 'lateral'; mode: Mode }[];

  static stayKey(pylon: number, side: number, k: number): string {
    return `${pylon}:${side}:${k}`;
  }

  /** Size of the global stiffness matrices (for the FEM info panel). */
  matrixStats() {
    const s = (f: Frame2D) => {
      const sys = f.factorize();
      return {
        nodes: f.nodes.length, elements: f.elements.length, dofs: f.dofCount, equations: sys.m,
        bandwidth: sys.b, nonZeros: sys.nonZeros, denseBytes: sys.m * sys.m * 8, bandBytes: sys.m * (sys.b + 1) * 8,
      };
    };
    return { vertical: s(this.vertical), lateral: s(this.lateral) };
  }

  private buildVertical(): void {
    const m = this.vertical;
    // --- deck node positions: abutments, piers, stay anchors, max 15 m apart
    const xs = new Set<number>([0, BRIDGE_LENGTH, ...PIER_X]);
    for (const xp of PIER_X) xs.add(xp - PYLON_LEG_SPREAD).add(xp + PYLON_LEG_SPREAD).add(xp - PIER_SHAFT_SPREAD).add(xp + PIER_SHAFT_SPREAD);
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
        const parts = Math.ceil(gap / this.meshSize - 1e-9);
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
      // --- pylon
      const base = [PYLON_LEG_HEIGHT];
      for (let k = 0; k < STAYS_PER_SIDE; k++) base.push(stayPylonHeight(k));
      base.push(PYLON_HEIGHT);
      // refine long pylon elements (below the lowest stay anchor) to the mesh size
      const heights = [PYLON_LEG_HEIGHT];
      for (let t = 1; t < base.length; t++) {
        const parts = Math.max(1, Math.ceil((base[t] - base[t - 1]) / this.meshSize - 1e-9));
        for (let q = 1; q <= parts; q++) heights.push(base[t - 1] + ((base[t] - base[t - 1]) * q) / parts);
      }
      const anchorIndex = (k: number) => heights.findIndex((h) => Math.abs(h - stayPylonHeight(k)) < 1e-6);
      const legTop = m.addNode(xp, PYLON_LEG_HEIGHT);
      for (const side of [-1, 1]) {
        const foot = nodeAtX.get(xp + side * PYLON_LEG_SPREAD)!;
        const ls = SECTIONS.pylonLeg;
        const idx = m.addElement({ type: 'beam', i: foot, j: legTop, E: STEEL.E, A: ls.A, I: ls.I });
        this.elements.push({
          index: idx, part: 'pylon', label: `Pylon P${p + 1}, ${side < 0 ? 'west' : 'east'} leg`,
          pylon: { pylon: p, hI: 0, hJ: PYLON_LEG_HEIGHT, leg: true },
        });
      }
      const pyNodes = [legTop];
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
          const top = pyNodes[anchorIndex(k)];
          if (this.cutStays.has(BridgeModel.stayKey(p, side, k))) {
            this.cutStayGeometry.push({ key: BridgeModel.stayKey(p, side, k), deckNode: anchor, topNode: top });
            continue;
          }
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
      const nSplit = Math.max(3, Math.ceil(s / this.meshSize - 1e-9));
      const nLower = H - s < 1e-6 ? 0 : Math.max(5, Math.ceil((H - s) / this.meshSize - 1e-9));
      const label = (what: string, z0: number, z1: number) => `Pier P${p + 1}, ${what}, ${z0.toFixed(0)}–${z1.toFixed(0)} m below deck`;
      // twin shafts of the split part, each with half of the split section
      const sp = SECTIONS.pierSplit;
      const shaftBottoms: number[] = [];
      for (const side of [-1, 1] as const) {
        const x = xp + side * PIER_SHAFT_SPREAD;
        let prev = nodeAtX.get(x)!;
        for (let t = 1; t <= nSplit; t++) {
          const z0 = (s * (t - 1)) / nSplit, z1 = (s * t) / nSplit;
          const node = m.addNode(x, -z1);
          // the deck rests on spherical bearings on the shaft heads: moment hinge at the top
          const idx = m.addElement({ type: 'beam', i: prev, j: node, E: CONCRETE.E, A: sp.A / 2, I: sp.I / 2, hingeI: t === 1 });
          this.elements.push({
            index: idx, part: 'pier', label: label(`${side < 0 ? 'west' : 'east'} shaft`, z0, z1),
            pier: { pier: p, zTopI: z0, zTopJ: z1, split: true, shaft: side },
          });
          prev = node;
        }
        shaftBottoms.push(prev);
      }
      if (nLower === 0) {
        for (const node of shaftBottoms) m.supports.push({ node, ux: true, uy: true, rz: true });
      } else {
        // transition zone: both shafts join the single main shaft
        const join = m.addNode(xp, -s);
        for (const [t, node] of shaftBottoms.entries()) {
          const idx = m.addElement({ type: 'beam', i: node, j: join, E: CONCRETE.E, A: 20, I: 200 });
          this.elements.push({
            index: idx, part: 'pier', label: `Pier P${p + 1}, transition to the main shaft (${t === 0 ? 'west' : 'east'})`,
            pier: { pier: p, zTopI: s, zTopJ: s, split: false, transition: true },
          });
        }
        let prev = join;
        const lo = SECTIONS.pierLower;
        for (let t = 1; t <= nLower; t++) {
          const z0 = s + ((H - s) * (t - 1)) / nLower, z1 = s + ((H - s) * t) / nLower;
          const node = m.addNode(xp, -z1);
          const idx = m.addElement({ type: 'beam', i: prev, j: node, E: CONCRETE.E, A: lo.A, I: lo.I });
          this.elements.push({ index: idx, part: 'pier', label: label('main shaft', z0, z1), pier: { pier: p, zTopI: z0, zTopJ: z1, split: false } });
          prev = node;
        }
        m.supports.push({ node: prev, ux: true, uy: true, rz: true });
      }
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
    this.lineWeight = new Array(v.elements.length).fill(0);
    for (const e of this.elements) {
      if (e.part === 'deck') this.lineWeight[e.index] = DECK_DEAD_LOAD;
      if (e.part === 'pylon') this.lineWeight[e.index] = e.pylon!.leg ? PYLON_DEAD_LOAD / 2 : PYLON_DEAD_LOAD;
      if (e.part === 'pier')
        this.lineWeight[e.index] = e.pier!.transition ? 0 : (e.pier!.split ? SECTIONS.pierSplit.A / 2 : SECTIONS.pierLower.A) * CONCRETE.gamma;
    }
    const g: ElementLoad[] = this.elements
      .filter((e) => this.lineWeight[e.index] > 0)
      .map((e) => ({ element: e.index, qx: 0, qy: -this.lineWeight[e.index] }));
    // Self-weight + stay pretension (G+PT). The real stays are tensioned so that the deck
    // sits in its target shape. Pretension forces follow from the classic "rigid supports"
    // method: the deck is solved as a continuous beam on rigid supports at every stay
    // anchor; the anchor reactions are the vertical components of the stay forces. Both
    // stays of a pair get the same force, so the pylons are balanced under dead load.
    this.stayPretension = this.computePretension();
    const pt: NodalLoad[] = [];
    for (const e of this.elements) {
      if (e.part !== 'stay') continue;
      const el = v.elements[e.index];
      const T = this.stayPretension.get(e.index)!;
      const { c, s } = v.geometry(el); // unit vector i (deck anchor) -> j (pylon)
      // the shortened stay pulls the anchor towards the pylon and the pylon towards the anchor
      pt.push({ node: el.i, fx: T * c, fy: T * s }, { node: el.j, fx: -T * c, fy: -T * s });
    }
    [this.solG, this.solP] = v.solve([{ distributed: g, nodal: pt }, { nodal: pt }]);
    // element force = elastic part + pretension
    for (const [idx, T] of this.stayPretension) {
      this.solG.forces[idx].N += T;
      this.solP.forces[idx].N += T;
    }
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

  /**
   * Stay pretension from the deck dead load: every stay lifts the deck weight of its
   * tributary length (half the distance to the neighbouring anchors; the 30 m next to a
   * pier are counted like a regular 12.5 m spacing, the pier carries the rest). Both
   * stays of a pair get the same force, so the pylons are balanced under dead load.
   */
  private computePretension(): Map<number, number> {
    const last = STAYS_PER_SIDE - 1;
    // free ends of the outermost stays' tributary lengths: abutments and outermost anchors
    const limits = [0, BRIDGE_LENGTH];
    PIER_X.forEach((xp) => limits.push(xp - stayAnchorOffset(last), xp + stayAnchorOffset(last)));
    const outward = (x: number, side: number) =>
      Math.min(...limits.filter((o) => (o - x) * side > 1e-6).map((o) => Math.abs(o - x))) / 2;
    const out = new Map<number, number>();
    for (const e of this.elements) {
      if (e.part !== 'stay') continue;
      const { pylon, k } = e.stay!;
      const xp = PIER_X[pylon], a = stayAnchorOffset(k);
      const len = (side: number) => 6.25 + (k < last ? 6.25 : outward(xp + side * a, side));
      const L = (len(-1) + len(1)) / 2;
      const sinA = stayPylonHeight(k) / Math.hypot(stayPylonHeight(k), a);
      out.set(e.index, (DECK_DEAD_LOAD * L) / sinA);
    }
    return out;
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
      const fP = this.solP.forces[e.index];
      const fQ = this.solQ.forces[e.index];
      if (e.part === 'stay') {
        const A = this.vertical.elements[e.index].A;
        this.checks.push({ element: e.index, where: 'm', sG: [fG.N / A, fG.N / A], sP: [fP.N / A, fP.N / A], sQ: [fQ.N / A, fQ.N / A], sW: 0, material: 'strand', tensionOnly: true });
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
        const { hI, hJ, leg } = e.pylon!;
        const ps = leg ? sec.pylonLeg : sec.pylon;
        A = ps.A; W = ps.W;
        const w = CD.pylon * PYLON_WIND_WIDTH;
        // transverse wind moment; below the leg junction it is shared by the two legs
        const m = (h: number) => (w * (PYLON_HEIGHT - h) ** 2) / 2 / ps.Wtr / (leg ? 2 : 1);
        lat = (wh) => m(wh === 'i' ? hI : wh === 'j' ? hJ : (hI + hJ) / 2);
      } else {
        if (e.pier!.transition) continue; // stiff stand-in for the 8 m transition zone, not checked
        const ps = e.pier!.split ? sec.pierSplit : sec.pierLower;
        const share = e.pier!.split ? 2 : 1; // each twin shaft has half of the split section
        A = ps.A / share; W = ps.W / share; material = 'concrete';
        const { pier, zTopI, zTopJ } = e.pier!;
        lat = (wh) => this.pierLateralMoment(pier, wh === 'i' ? zTopI : wh === 'j' ? zTopJ : (zTopI + zTopJ) / 2) / ps.Wtr;
      }
      for (const where of ['i', 'm', 'j'] as const) {
        const MG = where === 'i' ? fG.Mi : where === 'j' ? fG.Mj : fG.Mm;
        const MQ = where === 'i' ? fQ.Mi : where === 'j' ? fQ.Mj : fQ.Mm;
        const MP = where === 'i' ? fP.Mi : where === 'j' ? fP.Mj : fP.Mm;
        this.checks.push({
          element: e.index, where,
          sG: [fG.N / A + MG / W, fG.N / A - MG / W],
          sP: [fP.N / A + MP / W, fP.N / A - MP / W],
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
        // permanent: γG on self-weight, γP = 1.0 on the stay pretension
        const a = f.G * (c.sG[side] - c.sP[side]) + c.sP[side];
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
