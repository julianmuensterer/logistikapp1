/**
 * Minimal 2D frame / truss finite element solver.
 *
 * Every node has 3 degrees of freedom: u (x), v (y), theta (rotation about z).
 * Beam elements: Euler-Bernoulli with axial stiffness (6x6 local stiffness matrix).
 * Truss elements: axial stiffness only (bending DOFs not connected).
 *
 * K u = f is solved with a dense Cholesky factorization. The bridge model has a
 * few hundred nodes, which is small enough for a dense solver in the browser and
 * keeps the code easy to read.
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
    }
    return k;
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
    } else {
      f[1] = (py * L) / 2;
      f[4] = (py * L) / 2;
    }
    return f;
  }

  /** Assemble the global stiffness matrix (dense, n x n). */
  assemble(): Float64Array {
    const n = this.dofCount;
    const K = new Float64Array(n * n);
    for (const e of this.elements) {
      const kg = this.elementGlobalStiffness(e);
      const dofs = this.elementDofs(e);
      for (let r = 0; r < 6; r++)
        for (let q = 0; q < 6; q++) K[dofs[r] * n + dofs[q]] += kg[r * 6 + q];
    }
    for (const s of this.supports) {
      if (s.kx) K[(s.node * 3) * n + s.node * 3] += s.kx;
      if (s.ky) K[(s.node * 3 + 1) * n + s.node * 3 + 1] += s.ky;
    }
    // Truss-only nodes have no rotational stiffness: add a tiny value to keep K regular.
    for (let d = 2; d < n; d += 3) if (K[d * n + d] === 0) K[d * n + d] = 1;
    return K;
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

  /** Solve several load cases with one factorization. */
  solve(cases: LoadCase[]): Solution[] {
    const n = this.dofCount;
    const K = this.assemble();
    const fixed = this.fixedDofs();
    const free: number[] = [];
    for (let d = 0; d < n; d++) if (!fixed.has(d)) free.push(d);
    const m = free.length;
    const Kff = new Float64Array(m * m);
    for (let r = 0; r < m; r++)
      for (let q = 0; q < m; q++) Kff[r * m + q] = K[free[r] * n + free[q]];
    choleskyInPlace(Kff, m);

    return cases.map((lc) => {
      const f = this.loadVector(lc);
      const rhs = new Float64Array(m);
      for (let r = 0; r < m; r++) rhs[r] = f[free[r]];
      choleskySolve(Kff, m, rhs);
      const u = new Float64Array(n);
      for (let r = 0; r < m; r++) u[free[r]] = rhs[r];
      // reactions R = K u - f
      const reactions = new Float64Array(n);
      for (const d of fixed) {
        let v = 0;
        for (let q = 0; q < n; q++) v += K[d * n + q] * u[q];
        reactions[d] = v - f[d];
      }
      for (const s of this.supports) {
        if (s.kx) reactions[s.node * 3] = -s.kx * u[s.node * 3];
        if (s.ky) reactions[s.node * 3 + 1] = -s.ky * u[s.node * 3 + 1];
      }
      return { u, forces: this.elementForces(u, lc), reactions };
    });
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

/** In-place dense Cholesky: A = L Lᵀ, L stored in the lower triangle. */
export function choleskyInPlace(A: Float64Array, n: number): void {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] ** 2;
    if (d <= 0) throw new Error(`Stiffness matrix not positive definite at DOF ${j} (mechanism?)`);
    const ljj = Math.sqrt(d);
    A[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let v = A[i * n + j];
      const rowI = i * n;
      const rowJ = j * n;
      for (let k = 0; k < j; k++) v -= A[rowI + k] * A[rowJ + k];
      A[i * n + j] = v / ljj;
    }
  }
}

export function choleskySolve(Lm: Float64Array, n: number, b: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let v = b[i];
    for (let k = 0; k < i; k++) v -= Lm[i * n + k] * b[k];
    b[i] = v / Lm[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let v = b[i];
    for (let k = i + 1; k < n; k++) v -= Lm[k * n + i] * b[k];
    b[i] = v / Lm[i * n + i];
  }
}
