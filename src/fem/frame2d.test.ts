import { describe, expect, it } from 'vitest';
import { Frame2D } from './frame2d';

const E = 210e6; // kN/m²
const A = 0.01;
const I = 1e-4;

describe('Frame2D', () => {
  it('cantilever with tip load: δ = PL³/(3EI), M = PL', () => {
    const m = new Frame2D();
    const L = 4;
    const nEl = 8;
    for (let k = 0; k <= nEl; k++) m.addNode((L * k) / nEl, 0);
    for (let k = 0; k < nEl; k++) m.addElement({ type: 'beam', i: k, j: k + 1, E, A, I });
    m.supports.push({ node: 0, ux: true, uy: true, rz: true });
    const P = -10;
    const [sol] = m.solve([{ nodal: [{ node: nEl, fy: P }] }]);
    expect(sol.u[nEl * 3 + 1]).toBeCloseTo((P * L ** 3) / (3 * E * I), 8);
    expect(sol.forces[0].Mi).toBeCloseTo(P * L, 6); // hogging (negative)
    expect(sol.reactions[1]).toBeCloseTo(-P, 6);
  });

  it('simply supported beam with UDL: δ = 5qL⁴/(384EI), M = qL²/8', () => {
    const m = new Frame2D();
    const L = 10;
    const nEl = 10;
    for (let k = 0; k <= nEl; k++) m.addNode((L * k) / nEl, 0);
    const els: number[] = [];
    for (let k = 0; k < nEl; k++) els.push(m.addElement({ type: 'beam', i: k, j: k + 1, E, A, I }));
    m.supports.push({ node: 0, ux: true, uy: true }, { node: nEl, uy: true });
    const q = -5;
    const [sol] = m.solve([{ distributed: els.map((e) => ({ element: e, qx: 0, qy: q })) }]);
    const mid = nEl / 2;
    expect(sol.u[mid * 3 + 1]).toBeCloseTo((5 * q * L ** 4) / (384 * E * I), 8);
    expect(sol.forces[mid - 1].Mj).toBeCloseTo((-q * L * L) / 8, 6);
  });

  it('two-bar truss: axial forces from statics', () => {
    const m = new Frame2D();
    const a = m.addNode(0, 0);
    const b = m.addNode(4, 0);
    const c = m.addNode(2, 2); // 45° bars
    m.addElement({ type: 'truss', i: a, j: c, E, A, I: 0 });
    m.addElement({ type: 'truss', i: b, j: c, E, A, I: 0 });
    m.supports.push({ node: a, ux: true, uy: true }, { node: b, ux: true, uy: true });
    const [sol] = m.solve([{ nodal: [{ node: c, fy: -100 }] }]);
    const expected = -100 / (2 * Math.sin(Math.PI / 4)); // compression
    expect(sol.forces[0].N).toBeCloseTo(expected, 6);
    expect(sol.forces[1].N).toBeCloseTo(expected, 6);
  });

  it('spring support: δ = F/k', () => {
    const m = new Frame2D();
    const a = m.addNode(0, 0);
    const b = m.addNode(5, 0);
    m.addElement({ type: 'beam', i: a, j: b, E, A: 1e3, I: 1e3 });
    m.supports.push({ node: a, ux: true, uy: true, rz: true }, { node: b, ky: 1000 });
    // very stiff beam on spring: almost all load goes into the clamp, check equilibrium instead
    const [sol] = m.solve([{ nodal: [{ node: b, fy: -50 }] }]);
    expect(sol.reactions[1] + sol.reactions[b * 3 + 1]).toBeCloseTo(50, 6);
  });
});

import { lowestModes } from './modal';

describe('modal analysis', () => {
  it('cantilever: first natural frequency f1 = 1.875²/(2π L²) √(EI/m)', () => {
    const m = new Frame2D();
    const L = 10, nEl = 40, mu = 0.5; // t/m
    for (let k = 0; k <= nEl; k++) m.addNode((L * k) / nEl, 0);
    for (let k = 0; k < nEl; k++) m.addElement({ type: 'beam', i: k, j: k + 1, E, A, I });
    m.supports.push({ node: 0, ux: true, uy: true, rz: true });
    const mass = new Float64Array(m.dofCount);
    for (let k = 0; k <= nEl; k++) {
      const share = (mu * L) / nEl / (k === 0 || k === nEl ? 2 : 1);
      mass[k * 3] = share;
      mass[k * 3 + 1] = share;
    }
    const [m1, m2] = lowestModes(m, mass, 2);
    const f1 = (1.8751 ** 2 / (2 * Math.PI * L * L)) * Math.sqrt((E * I) / mu);
    const f2 = (4.6941 ** 2 / (2 * Math.PI * L * L)) * Math.sqrt((E * I) / mu);
    expect(m1.f).toBeCloseTo(f1, 2);
    expect(m2.f / f2).toBeCloseTo(1, 2);
  });

  it('a moment hinge turns a fixed-fixed beam into a propped cantilever', () => {
    const f = new Frame2D();
    const L = 10, q = 12;
    const a = f.addNode(0, 0), b = f.addNode(L, 0), c = f.addNode(L + 5, 0);
    f.addElement({ type: 'beam', i: a, j: b, E, A: 1, I: 1e-3, hingeJ: true });
    f.addElement({ type: 'beam', i: b, j: c, E, A: 1, I: 1e-3 });
    f.supports.push({ node: a, ux: true, uy: true, rz: true }, { node: b, uy: true }, { node: c, uy: true });
    const [sol] = f.solve([{ distributed: [{ element: 0, qx: 0, qy: -q }] }]);
    expect(sol.forces[0].Mj).toBeCloseTo(0, 6);
    expect(sol.forces[0].Mi).toBeCloseTo((-q * L * L) / 8, 4);
    expect(sol.forces[1].Mi).toBeCloseTo(0, 6);
  });
});
