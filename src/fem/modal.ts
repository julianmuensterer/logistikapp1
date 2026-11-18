/**
 * Natural frequencies and mode shapes: K φ = ω² M φ.
 *
 * Subspace iteration (Bathe): start with p vectors, repeatedly solve K X̄ = M X,
 * project K and M onto the subspace, solve the small eigenproblem with the Jacobi
 * method and continue with the improved vectors. It reuses the Cholesky factor of K,
 * so it is cheap even for a few thousand DOFs.
 */
import type { Frame2D } from './frame2d';

export interface Mode {
  /** natural frequency [Hz] */
  f: number;
  /** period [s] */
  T: number;
  /** mode shape (global DOF vector), scaled so that max |translation| = 1 */
  shape: Float64Array;
}

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Eigenvalues/vectors of a small symmetric matrix (cyclic Jacobi). Returns [values, vectors(columns)]. */
export function jacobiEigen(A: number[][]): [number[], number[][]] {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const V: number[][] = A.map((_, i) => A.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return [a.map((r, i) => r[i]), V];
}

/**
 * Lowest `count` modes of a frame with a lumped (diagonal) mass vector `mass`
 * (one entry per global DOF, [t]).
 */
export function lowestModes(frame: Frame2D, mass: Float64Array, count: number): Mode[] {
  const n = mass.length;
  const sys = frame.factorize();
  const free = (d: number) => sys.eq[d] >= 0;
  const p = Math.min(count * 2, count + 8);
  // start vectors: mass-weighted, alternating patterns along the structure
  let X: Float64Array[] = [];
  for (let j = 0; j < p; j++) {
    const x = new Float64Array(n);
    for (let d = 0; d < n; d++) if (free(d) && mass[d] > 0) x[d] = mass[d] * (j === 0 ? 1 : Math.sin(((j + 1) * (d + 1) * 0.6180339887) % 6.283));
    X.push(x);
  }
  let lambdas: number[] = [];
  for (let iter = 0; iter < 60; iter++) {
    // X̄ = K⁻¹ M X
    const Xb = X.map((x) => {
      const f = new Float64Array(n);
      for (let d = 0; d < n; d++) f[d] = mass[d] * x[d];
      return frame.solveVector(f);
    });
    // projected matrices
    const KX = Xb.map((x) => frame.multiplyK(x));
    const MX = Xb.map((x) => x.map((v, d) => v * mass[d]));
    const Kr = Xb.map((xi) => KX.map((kxj) => dot(xi, kxj)));
    const Mr = Xb.map((xi) => MX.map((mxj) => dot(xi, mxj)));
    // generalized → standard problem with Cholesky of Mr
    const L = cholSmall(Mr);
    const Linv = invLower(L);
    const C = mul(mul(Linv, Kr), transpose(Linv));
    for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) C[i][j] = C[j][i] = (C[i][j] + C[j][i]) / 2;
    const [vals, vecs] = jacobiEigen(C);
    const Q = mul(transpose(Linv), vecs);
    const orderIdx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    X = orderIdx.map((col) => {
      const x = new Float64Array(n);
      for (let j = 0; j < p; j++) {
        const q = Q[j][col];
        if (q !== 0) for (let d = 0; d < n; d++) x[d] += q * Xb[j][d];
      }
      return x;
    });
    const newL = orderIdx.map((i) => vals[i]);
    const converged = lambdas.length > 0 && newL.slice(0, count).every((l, i) => Math.abs(l - lambdas[i]) <= 1e-8 * Math.abs(l));
    lambdas = newL;
    if (converged) break;
  }
  return lambdas.slice(0, count).map((lam, i) => {
    const shape = X[i];
    let max = 0;
    for (let d = 0; d < n; d++) if (d % 3 !== 2) max = Math.max(max, Math.abs(shape[d]));
    // sign convention: largest translation positive
    let sign = 1;
    for (let d = 0; d < n; d++) if (d % 3 !== 2 && Math.abs(shape[d]) === max) { sign = Math.sign(shape[d]); break; }
    const s = shape.map((v) => (v * sign) / (max || 1));
    const omega = Math.sqrt(Math.max(lam, 0));
    const f = omega / (2 * Math.PI);
    return { f, T: 1 / f, shape: s };
  });
}

function cholSmall(A: number[][]): number[][] {
  const n = A.length;
  const L = A.map(() => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    let d = A[j][j];
    for (let k = 0; k < j; k++) d -= L[j][k] ** 2;
    L[j][j] = Math.sqrt(Math.max(d, 1e-300));
    for (let i = j + 1; i < n; i++) {
      let v = A[i][j];
      for (let k = 0; k < j; k++) v -= L[i][k] * L[j][k];
      L[i][j] = v / L[j][j];
    }
  }
  return L;
}
function invLower(L: number[][]): number[][] {
  const n = L.length;
  const X = L.map(() => new Array(n).fill(0));
  for (let c = 0; c < n; c++)
    for (let i = 0; i < n; i++) {
      let v = i === c ? 1 : 0;
      for (let k = 0; k < i; k++) v -= L[i][k] * X[k][c];
      X[i][c] = v / L[i][i];
    }
  return X;
}
const transpose = (A: number[][]) => A[0].map((_, j) => A.map((r) => r[j]));
const mul = (A: number[][], B: number[][]) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
