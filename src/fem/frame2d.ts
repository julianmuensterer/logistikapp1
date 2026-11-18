/**
 * Minimal 2D frame / truss finite element solver.
 *
 * Every node has 3 degrees of freedom: u (x), v (y), theta (rotation about z).
 * Beam elements: Euler-Bernoulli with axial stiffness (6x6 local stiffness matrix).
 * Truss elements: axial stiffness only (bending DOFs not connected).
 *
 * K u = f is solved with a banded Cholesky factorization after renumbering the
 * nodes along the bridge, so even fine meshes solve in a fraction of a second.
 */

export interface Node2D {
  x: number;
  y: number;
}

export type ElementType = 'beam' | 'truss';

export interface Element2D {
  type: ElementType;
  i: number; // node index
  j: number; // node index
  E: number; // Young's modulus [kN/m²]
  A: number; // area [m²]
  I: number; // second moment of area [m⁴] (ignored for trusses)
  /** moment hinge at end i / end j (beam only), e.g. a bearing */
  hingeI?: boolean;
  hingeJ?: boolean;
}

export interface Support {
  node: number;
  ux?: boolean;
  uy?: boolean;
  rz?: boolean;
  /** optional spring stiffnesses instead of a fixed support [kN/m] / [kNm/rad] */
  kx?: number;
  ky?: number;
}

/** Uniformly distributed load in GLOBAL directions, per unit length of the element [kN/m]. */
export interface ElementLoad {
  element: number;
  qx: number;
  qy: number;
}

export interface NodalLoad {
  node: number;
  fx?: number;
  fy?: number;
  mz?: number;
}

export interface LoadCase {
  nodal?: NodalLoad[];
  distributed?: ElementLoad[];
}

/** Element end forces in LOCAL coordinates (sign convention: forces acting on the element). */
export interface ElementForces {
  /** axial force, tension positive [kN] */
  N: number;
  /** bending moment at end i, at midspan and at end j [kNm], sagging positive */
  Mi: number;
  Mm: number;
  Mj: number;
  /** shear at end i [kN] */
  Vi: number;
}

export interface Solution {
  /** displacement vector, 3 entries per node */
  u: Float64Array;
  forces: ElementForces[];
  reactions: Float64Array;
}

export class Frame2D {
  nodes: Node2D[] = [];
  elements: Element2D[] = [];
  supports: Support[] = [];

  addNode(x: number, y: number): number {
    this.nodes.push({ x, y });
    return this.nodes.length - 1;
  }

  addElement(e: Element2D): number {
    this.elements.push(e);
    return this.elements.length - 1;
  }

  get dofCount(): number {
    return this.nodes.length * 3;
  }

  geometry(e: Element2D) {
    const a = this.nodes[e.i];
    const b = this.nodes[e.j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    return { L, c: dx / L, s: dy / L };
  }

  /** Local stiffness matrix (6x6, row-major). */
  static localStiffness(e: Element2D, L: number): number[] {
    const k = new Array(36).fill(0);
    const EA = (e.E * e.A) / L;
    k[0 * 6 + 0] = EA;
    k[0 * 6 + 3] = -EA;
    k[3 * 6 + 0] = -EA;
    k[3 * 6 + 3] = EA;
    if (e.type === 'beam') {
      const EI = e.E * e.I;
      const a = (12 * EI) / L ** 3;
      const b = (6 * EI) / L ** 2;
      const c = (4 * EI) / L;
      const d = (2 * EI) / L;
      const set = (r: number, cidx: number, v: number) => (k[r * 6 + cidx] = v);
      set(1, 1, a); set(1, 2, b); set(1, 4, -a); set(1, 5, b);
      set(2, 1, b); set(2, 2, c); set(2, 4, -b); set(2, 5, d);
      set(4, 1, -a); set(4, 2, -b); set(4, 4, a); set(4, 5, -b);
      set(5, 1, b); set(5, 2, d); set(5, 4, -b); set(5, 5, c);
      // moment hinges: static condensation of the released rotation
      for (const r of Frame2D.released(e)) {
        const krr = k[r * 6 + r];
        const row = k.slice(r * 6, r * 6 + 6);
        const col = [0, 1, 2, 3, 4, 5].map((q) => k[q * 6 + r]);
        for (let q = 0; q < 6; q++) for (let t = 0; t < 6; t++) k[q * 6 + t] -= (col[q] * row[t]) / krr;
      }
    }
    return k;
  }

  /** local DOF indices of released end rotations */
  static released(e: Element2D): number[] {
    const r: number[] = [];
    if (e.type === 'beam' && e.hingeI) r.push(2);
    if (e.type === 'beam' && e.hingeJ) r.push(5);
    return r;
  }

  /** Transformation matrix T (6x6) so that u_local = T u_global. */
  static transformation(c: number, s: number): number[] {
    const T = new Array(36).fill(0);
    for (const o of [0, 3]) {
      T[(o + 0) * 6 + o + 0] = c;
      T[(o + 0) * 6 + o + 1] = s;
      T[(o + 1) * 6 + o + 0] = -s;
      T[(o + 1) * 6 + o + 1] = c;
      T[(o + 2) * 6 + o + 2] = 1;
    }
    return T;
  }

  private elementDofs(e: Element2D): number[] {
    return [e.i * 3, e.i * 3 + 1, e.i * 3 + 2, e.j * 3, e.j * 3 + 1, e.j * 3 + 2];
  }

  /** Global stiffness matrix k_g = Tᵀ k_l T for one element. */
  elementGlobalStiffness(e: Element2D): number[] {
    const { L, c, s } = this.geometry(e);
    const kl = Frame2D.localStiffness(e, L);
    const T = Frame2D.transformation(c, s);
    const tmp = new Array(36).fill(0);
    const kg = new Array(36).fill(0);
    for (let r = 0; r < 6; r++)
      for (let q = 0; q < 6; q++) {
        let v = 0;
        for (let m = 0; m < 6; m++) v += kl[r * 6 + m] * T[m * 6 + q];
        tmp[r * 6 + q] = v;
      }
    for (let r = 0; r < 6; r++)
      for (let q = 0; q < 6; q++) {
        let v = 0;
        for (let m = 0; m < 6; m++) v += T[m * 6 + r] * tmp[m * 6 + q];
        kg[r * 6 + q] = v;
      }
    return kg;
  }

  /** Fixed-end forces in local coordinates for a uniform load (local components px, py). */
  static fixedEndForces(e: Element2D, L: number, px: number, py: number): number[] {
    const f = [px * L / 2, 0, 0, px * L / 2, 0, 0];
    if (e.type === 'beam') {
      f[1] = (py * L) / 2;
      f[2] = (py * L * L) / 12;
      f[4] = (py * L) / 2;
      f[5] = (-py * L * L) / 12;
      // a hinge redistributes its fixed-end moment (propped cantilever / simple beam)
      if (e.hingeI && e.hingeJ) {
        f[2] = 0; f[5] = 0;
      } else if (e.hingeJ) {
        f[1] = (5 * py * L) / 8; f[2] = (py * L * L) / 8; f[4] = (3 * py * L) / 8; f[5] = 0;
      } else if (e.hingeI) {
        f[1] = (3 * py * L) / 8; f[2] = 0; f[4] = (5 * py * L) / 8; f[5] = (-py * L * L) / 8;
      }
    } else {
      f[1] = (py * L) / 2;
      f[4] = (py * L) / 2;
    }
    return f;
  }

  /**
   * Assemble and factorize the global stiffness matrix.
   *
   * Nodes are renumbered by their x coordinate so that coupled DOFs are close to each
   * other. The free DOFs then form a banded matrix: only the band (half-bandwidth b)
   * is stored and factorized, which costs ~ n·b²/2 instead of n³/6 operations.
   */
  factorize(): BandedSystem {
    if (this.system) return this.system;
    const n = this.dofCount;
    const fixed = this.fixedDofs();
    const order = this.nodes.map((_, i) => i).sort((a, b) => this.nodes[a].x - this.nodes[b].x || this.nodes[a].y - this.nodes[b].y);
    const eq = new Int32Array(n).fill(-1); // global DOF → equation number (−1 = fixed)
    let m = 0;
    for (const node of order)
      for (let k = 0; k < 3; k++) if (!fixed.has(node * 3 + k)) eq[node * 3 + k] = m++;
    // half-bandwidth
    let b = 0;
    const pairs = new Set<number>();
    for (const e of this.elements) {
      const dofs = this.elementDofs(e).map((d) => eq[d]).filter((d) => d >= 0);
      for (const r of dofs) for (const c of dofs) {
        b = Math.max(b, Math.abs(r - c));
        pairs.add(r * m + c);
      }
    }
    const K = new BandMatrix(m, b);
    for (const e of this.elements) {
      const kg = this.elementGlobalStiffness(e);
      const dofs = this.elementDofs(e);
      for (let r = 0; r < 6; r++) {
        const er = eq[dofs[r]];
        if (er < 0) continue;
        for (let q = 0; q < 6; q++) {
          const eqq = eq[dofs[q]];
          if (eqq < 0 || eqq > er) continue; // lower triangle only
          K.add(er, eqq, kg[r * 6 + q]);
        }
      }
    }
    for (const s of this.supports) {
      if (s.kx && eq[s.node * 3] >= 0) K.add(eq[s.node * 3], eq[s.node * 3], s.kx);
      if (s.ky && eq[s.node * 3 + 1] >= 0) K.add(eq[s.node * 3 + 1], eq[s.node * 3 + 1], s.ky);
    }
    // Truss-only nodes have no rotational stiffness: add a tiny value to keep K regular.
    for (let node = 0; node < this.nodes.length; node++) {
      const d = eq[node * 3 + 2];
      if (d >= 0 && K.get(d, d) === 0) K.add(d, d, 1);
    }
    for (let i = 0; i < m; i++) pairs.add(i * m + i);
    const L = K.clone();
    L.cholesky();
    this.system = { n, m, b, eq, K, L, nonZeros: pairs.size };
    return this.system;
  }

  private system?: BandedSystem;

  /** Drop the cached factorization (call after changing the model). */
  invalidate(): void {
    this.system = undefined;
  }

  fixedDofs(): Set<number> {
    const fixed = new Set<number>();
    for (const s of this.supports) {
      if (s.ux) fixed.add(s.node * 3);
      if (s.uy) fixed.add(s.node * 3 + 1);
      if (s.rz) fixed.add(s.node * 3 + 2);
    }
    return fixed;
  }

  loadVector(lc: LoadCase): Float64Array {
    const f = new Float64Array(this.dofCount);
    for (const p of lc.nodal ?? []) {
      f[p.node * 3] += p.fx ?? 0;
      f[p.node * 3 + 1] += p.fy ?? 0;
      f[p.node * 3 + 2] += p.mz ?? 0;
    }
    for (const d of lc.distributed ?? []) {
      const e = this.elements[d.element];
      const { L, c, s } = this.geometry(e);
      const px = c * d.qx + s * d.qy;
      const py = -s * d.qx + c * d.qy;
      const fl = Frame2D.fixedEndForces(e, L, px, py);
      const T = Frame2D.transformation(c, s);
      const dofs = this.elementDofs(e);
      for (let r = 0; r < 6; r++) {
        let v = 0;
        for (let m = 0; m < 6; m++) v += T[m * 6 + r] * fl[m];
        f[dofs[r]] += v;
      }
    }
    return f;
  }

  /** Solve K u = f for a global load vector (fixed DOFs get u = 0). */
  solveVector(f: Float64Array): Float64Array {
    const sys = this.factorize();
    const rhs = new Float64Array(sys.m);
    for (let d = 0; d < sys.n; d++) if (sys.eq[d] >= 0) rhs[sys.eq[d]] = f[d];
    sys.L.solve(rhs);
    const u = new Float64Array(sys.n);
    for (let d = 0; d < sys.n; d++) if (sys.eq[d] >= 0) u[d] = rhs[sys.eq[d]];
    return u;
  }

  /** Solve several load cases with one factorization. */
  solve(cases: LoadCase[]): Solution[] {
    const n = this.dofCount;
    const sys = this.factorize();
    return cases.map((lc) => {
      const f = this.loadVector(lc);
      const u = this.solveVector(f);
      // reactions R = K u − f at the supports, assembled element by element
      const reactions = new Float64Array(n);
      for (const e of this.elements) {
        const kg = this.elementGlobalStiffness(e);
        const dofs = this.elementDofs(e);
        for (let r = 0; r < 6; r++) {
          if (sys.eq[dofs[r]] >= 0) continue;
          let v = 0;
          for (let q = 0; q < 6; q++) v += kg[r * 6 + q] * u[dofs[q]];
          reactions[dofs[r]] += v;
        }
      }
      for (let d = 0; d < n; d++) if (sys.eq[d] < 0) reactions[d] -= f[d];
      for (const s of this.supports) {
        if (s.kx) reactions[s.node * 3] = -s.kx * u[s.node * 3];
        if (s.ky) reactions[s.node * 3 + 1] = -s.ky * u[s.node * 3 + 1];
      }
      return { u, forces: this.elementForces(u, lc), reactions };
    });
  }

  /** y = K x for global vectors (used by the eigenvalue solver). */
  multiplyK(x: Float64Array): Float64Array {
    const sys = this.factorize();
    const xr = new Float64Array(sys.m);
    for (let d = 0; d < sys.n; d++) if (sys.eq[d] >= 0) xr[sys.eq[d]] = x[d];
    const yr = sys.K.multiply(xr);
    const y = new Float64Array(sys.n);
    for (let d = 0; d < sys.n; d++) if (sys.eq[d] >= 0) y[d] = yr[sys.eq[d]];
    return y;
  }

  elementForces(u: Float64Array, lc: LoadCase): ElementForces[] {
    const loadsByElement = new Map<number, { qx: number; qy: number }>();
    for (const d of lc.distributed ?? []) {
      const prev = loadsByElement.get(d.element) ?? { qx: 0, qy: 0 };
      loadsByElement.set(d.element, { qx: prev.qx + d.qx, qy: prev.qy + d.qy });
    }
    return this.elements.map((e, idx) => {
      const { L, c, s } = this.geometry(e);
      const T = Frame2D.transformation(c, s);
      const kl = Frame2D.localStiffness(e, L);
      const dofs = this.elementDofs(e);
      const ug = dofs.map((d) => u[d]);
      const ul = new Array(6).fill(0);
      for (let r = 0; r < 6; r++) for (let m = 0; m < 6; m++) ul[r] += T[r * 6 + m] * ug[m];
      const fl = new Array(6).fill(0);
      for (let r = 0; r < 6; r++) for (let m = 0; m < 6; m++) fl[r] += kl[r * 6 + m] * ul[m];
      const q = loadsByElement.get(idx);
      let py = 0;
      if (q) {
        const px = c * q.qx + s * q.qy;
        py = -s * q.qx + c * q.qy;
        const fe = Frame2D.fixedEndForces(e, L, px, py);
        for (let r = 0; r < 6; r++) fl[r] -= fe[r];
      }
      // fl = forces acting on the element at its ends (local).
      const N = fl[3]; // tension positive
      const Vi = fl[1];
      // Beam convention: sagging positive. End moment at i acting on element is fl[2] (ccw).
      const Mi = -fl[2];
      const Mj = fl[5];
      // midspan moment from equilibrium of the left half
      const Mm = Mi + Vi * (L / 2) + (py * (L / 2) ** 2) / 2;
      return e.type === 'truss' ? { N, Mi: 0, Mm: 0, Mj: 0, Vi: 0 } : { N, Mi, Mm, Mj, Vi };
    });
  }
}

export interface BandedSystem {
  /** number of DOFs incl. fixed ones */
  n: number;
  /** number of equations (free DOFs) = size of the global matrix */
  m: number;
  /** half-bandwidth after renumbering */
  b: number;
  /** global DOF → equation number (−1 = fixed) */
  eq: Int32Array;
  /** global stiffness matrix (band, lower triangle) */
  K: BandMatrix;
  /** its Cholesky factor */
  L: BandMatrix;
  /** non-zero entries of the full symmetric matrix */
  nonZeros: number;
}

/** Symmetric band matrix, lower triangle stored row by row: entry (i, j) with i−b ≤ j ≤ i. */
export class BandMatrix {
  readonly n: number;
  readonly b: number;
  readonly data: Float64Array;
  constructor(n: number, b: number, data?: Float64Array) {
    this.n = n;
    this.b = b;
    this.data = data ?? new Float64Array(n * (b + 1));
  }
  private idx(i: number, j: number): number {
    return i * (this.b + 1) + (j - i + this.b);
  }
  get(i: number, j: number): number {
    if (j > i) [i, j] = [j, i];
    return i - j > this.b ? 0 : this.data[this.idx(i, j)];
  }
  add(i: number, j: number, v: number): void {
    if (j > i) [i, j] = [j, i];
    this.data[this.idx(i, j)] += v;
  }
  clone(): BandMatrix {
    return new BandMatrix(this.n, this.b, this.data.slice());
  }
  /** In-place Cholesky factorization A = L Lᵀ (band is preserved). */
  cholesky(): void {
    const { n, b, data } = this;
    const w = b + 1;
    for (let j = 0; j < n; j++) {
      const rowJ = j * w - j + b; // data[rowJ + k] = L(j, k)
      let d = data[rowJ + j];
      const k0 = Math.max(0, j - b);
      for (let k = k0; k < j; k++) d -= data[rowJ + k] ** 2;
      if (d <= 0) throw new Error(`Stiffness matrix not positive definite at equation ${j} (mechanism?)`);
      const ljj = Math.sqrt(d);
      data[rowJ + j] = ljj;
      const iMax = Math.min(n - 1, j + b);
      for (let i = j + 1; i <= iMax; i++) {
        const rowI = i * w - i + b;
        let v = data[rowI + j];
        for (let k = Math.max(0, i - b); k < j; k++) v -= data[rowI + k] * data[rowJ + k];
        data[rowI + j] = v / ljj;
      }
    }
  }
  /** Solve L Lᵀ x = rhs in place (after cholesky()). */
  solve(x: Float64Array): void {
    const { n, b, data } = this;
    const w = b + 1;
    for (let i = 0; i < n; i++) {
      const rowI = i * w - i + b;
      let v = x[i];
      for (let k = Math.max(0, i - b); k < i; k++) v -= data[rowI + k] * x[k];
      x[i] = v / data[rowI + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let v = x[i];
      const kMax = Math.min(n - 1, i + b);
      for (let k = i + 1; k <= kMax; k++) v -= data[k * w - k + b + i] * x[k];
      x[i] = v / data[i * w - i + b + i];
    }
  }
  /** y = A x for the full symmetric matrix. */
  multiply(x: Float64Array): Float64Array {
    const { n, b, data } = this;
    const w = b + 1;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const rowI = i * w - i + b;
      for (let j = Math.max(0, i - b); j <= i; j++) {
        const a = data[rowI + j];
        y[i] += a * x[j];
        if (j !== i) y[j] += a * x[i];
      }
    }
    return y;
  }
}
