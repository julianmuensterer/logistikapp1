import * as THREE from 'three';
import {
  BRIDGE_LENGTH, PIER_HEIGHTS, PIER_X, PYLON_HEIGHT, splitLength, stayStrands,
  type BridgeModel, type ModelElement, type Part,
} from '../fem/bridge';
import { toon } from './world';

const BASE_COLORS: Record<Part, string> = {
  deck: '#f2f2f2',
  stay: '#ffd84d',
  pylon: '#fbfbfb',
  pier: '#d9cfc1',
};

const UP = new THREE.Vector3(0, 1, 0);
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

/** Utilization colour: green → yellow → red, dark red above 100 %. */
export function etaColor(eta: number, target = new THREE.Color()): THREE.Color {
  if (eta >= 1) return target.set('#b3001b');
  const g = new THREE.Color('#3cb371');
  const y = new THREE.Color('#ffd23f');
  const r = new THREE.Color('#ff4d3d');
  return eta < 0.5 ? target.copy(g).lerp(y, eta / 0.5) : target.copy(y).lerp(r, (eta - 0.5) / 0.5);
}

interface Piece {
  mesh: THREE.Mesh;
  /** offset of the piece relative to the element axis (e.g. pylon legs, pier legs) */
  offsetI: THREE.Vector3;
  offsetJ: THREE.Vector3;
}

export interface ElementVisual {
  element: ModelElement;
  pieces: Piece[];
  material: THREE.MeshToonMaterial;
}

/**
 * Stylized 3D bridge. Every finite element gets its own mesh(es), so the 3D view can
 * show the deformed shape and the utilization of each element.
 */
export class Bridge3D {
  group = new THREE.Group();
  visuals = new Map<number, ElementVisual>();
  /** lateral-model node index for each vertical-model node (deck and pylon nodes) */
  private lateralIndex = new Map<number, number>();
  private stubs: { mesh: THREE.Mesh; node: number; hang: THREE.Vector3 }[] = [];
  private pierShape = new Map<number, { lat: number; factor: number }>();
  private nodePositions: THREE.Vector3[] = [];
  private model: BridgeModel;

  constructor(model: BridgeModel) {
    this.model = model;
    const v = model.vertical;
    model.deckNodes.forEach((n, t) => this.lateralIndex.set(n, t));
    // pylon nodes follow the lateral displacement of their deck node
    for (const e of model.elements)
      if (e.part === 'pylon') {
        const el = v.elements[e.index];
        const deckNode = model.deckNodes.find((n) => Math.abs(v.nodes[n].x - PIER_X[e.pylon!.pylon]) < 1e-6)!;
        this.lateralIndex.set(el.i, this.lateralIndex.get(deckNode)!);
        this.lateralIndex.set(el.j, this.lateralIndex.get(deckNode)!);
      }
    // pier nodes: lateral displacement follows the bending line of a cantilever
    // loaded at its top (w = δ_top · ξ²(3 − ξ)/2, ξ = height above foundation / H)
    for (const e of model.elements)
      if (e.part === 'pier') {
        const { pier, zTopI, zTopJ } = e.pier!;
        const H = PIER_HEIGHTS[pier];
        const deckNode = model.deckNodes.find((n) => Math.abs(v.nodes[n].x - PIER_X[pier]) < 1e-6)!;
        const top = this.lateralIndex.get(deckNode)!;
        const el = v.elements[e.index];
        for (const [node, z] of [[el.i, zTopI], [el.j, zTopJ]] as const) {
          const xi = (H - z) / H;
          if (node !== deckNode) this.pierShape.set(node, { lat: top, factor: (xi * xi * (3 - xi)) / 2 });
        }
      }
    this.nodePositions = v.nodes.map((n) => new THREE.Vector3(n.x - BRIDGE_LENGTH / 2, n.y, 0));
    for (const e of model.elements) this.createVisual(e);
    this.addDecorations();
    // cut stays: two loose ends hang down from the pylon and from the deck
    const stubMat = toon('#ff7a59');
    for (const c of model.cutStayGeometry) {
      const side = Number(c.key.split(':')[1]);
      for (const [node, hang] of [
        [c.topNode, new THREE.Vector3(side * 4, -28, 0)],
        [c.deckNode, new THREE.Vector3(-side * 3, -10, 0)],
      ] as const) {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1, 6), stubMat);
        this.group.add(mesh);
        this.stubs.push({ mesh, node, hang });
      }
    }
  }

  private createVisual(e: ModelElement): void {
    const material = toon(BASE_COLORS[e.part]);
    const pieces: Piece[] = [];
    const add = (geo: THREE.BufferGeometry, oi = new THREE.Vector3(), oj = oi.clone()) => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.userData = { element: e.index, part: e.part };
      this.group.add(mesh);
      pieces.push({ mesh, offsetI: oi, offsetJ: oj });
    };
    if (e.part === 'deck') {
      // local Y = length, local X → vertical (downwards after rotation), local Z = width
      add(new THREE.BoxGeometry(4.2, 1, 32).translate(2.1, 0, 0));
      const road = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 27).translate(-0.1, 0, 0), toon('#5b6170'));
      road.userData = { element: e.index, part: e.part };
      this.group.add(road);
      pieces.push({ mesh: road, offsetI: new THREE.Vector3(), offsetJ: new THREE.Vector3() });
    } else if (e.part === 'stay') {
      const r = 0.25 + 0.012 * stayStrands(e.stay!.k);
      add(new THREE.CylinderGeometry(r, r, 1, 6));
    } else if (e.part === 'pylon') {
      const { hI, hJ } = e.pylon!;
      const spread = (h: number) => Math.max(0, 9 * (1 - h / 40));
      if (hJ <= 40) {
        // inverted-Y legs
        const geo = new THREE.BoxGeometry(3, 1, 4);
        add(geo, new THREE.Vector3(-spread(hI), 0, 0), new THREE.Vector3(-spread(hJ), 0, 0));
        add(geo.clone(), new THREE.Vector3(spread(hI), 0, 0), new THREE.Vector3(spread(hJ), 0, 0));
      } else {
        const w = 4 - (hI - 40) / 30;
        add(new THREE.BoxGeometry(w, 1, 4));
      }
    } else {
      const { pier, zTopI, zTopJ, split } = e.pier!;
      const H = PIER_HEIGHTS[pier];
      const s = splitLength(H);
      if (split) {
        const geo = new THREE.BoxGeometry(4, 1, 11);
        add(geo, new THREE.Vector3(-5, 0, 0));
        add(geo.clone(), new THREE.Vector3(5, 0, 0));
      } else {
        // tapered main shaft: bigger at the base
        const t0 = (zTopI - s) / (H - s);
        const t1 = (zTopJ - s) / (H - s);
        const size = (t: number) => ({ l: 14 + 6 * t * (H / 245), w: 12 + 13 * t * (H / 245) });
        const a = size(t0), b = size(t1);
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const pos = geo.attributes.position as THREE.BufferAttribute;
        for (let k = 0; k < pos.count; k++) {
          const top = pos.getY(k) < 0; // local -Y = end i (top) after the 180° rotation
          const sz = top ? a : b;
          pos.setX(k, pos.getX(k) * sz.l);
          pos.setZ(k, pos.getZ(k) * sz.w);
        }
        geo.computeVertexNormals();
        add(geo);
      }
    }
    this.visuals.set(e.index, { element: e, pieces, material });
  }

  private addDecorations(): void {
    // pier foundations and pylon tips
    PIER_X.forEach((x, p) => {
      const footing = new THREE.Mesh(new THREE.CylinderGeometry(20, 24, 8, 8), toon('#bdb3a5'));
      footing.position.set(x - BRIDGE_LENGTH / 2, -PIER_HEIGHTS[p] - 2, 0);
      this.group.add(footing);
    });
    // abutments
    for (const x of [0, BRIDGE_LENGTH]) {
      const ab = new THREE.Mesh(new THREE.BoxGeometry(30, 14, 40), toon('#bdb3a5'));
      ab.position.set(x - BRIDGE_LENGTH / 2 + (x === 0 ? -14 : 14), -11, 0);
      this.group.add(ab);
    }
    // approach roads
    for (const sgn of [-1, 1]) {
      const road = new THREE.Mesh(new THREE.BoxGeometry(900, 2, 27), toon('#5b6170'));
      road.position.set(sgn * (BRIDGE_LENGTH / 2 + 470), -1.5, 0);
      this.group.add(road);
    }
    void PYLON_HEIGHT;
  }

  /** Deformed position of a vertical-model node. */
  nodePosition(node: number, out: THREE.Vector3, scale: number): THREE.Vector3 {
    const ev = this.lastDisp;
    out.copy(this.nodePositions[node]);
    if (ev) {
      out.x += ev(node * 3) * scale;
      out.y += ev(node * 3 + 1) * scale;
      const lat = this.lateralIndex.get(node);
      if (lat !== undefined) out.z += this.lastLat(lat) * scale;
      const ps = this.pierShape.get(node);
      if (ps) out.z += this.lastLat(ps.lat) * ps.factor * scale;
    }
    return out;
  }

  private lastDisp?: (dof: number) => number;
  /** lateral deck displacement at lateral-model node t [m] */
  private lastLat: (t: number) => number = () => 0;

  /** Update geometry and colours. */
  update(disp: (dof: number) => number, lat: (t: number) => number, eta: Float64Array, scale: number, colorByEta: boolean): void {
    this.lastDisp = disp;
    this.lastLat = lat;
    const A = new THREE.Vector3();
    const B = new THREE.Vector3();
    const v = this.model.vertical;
    for (const vis of this.visuals.values()) {
      const el = v.elements[vis.element.index];
      this.nodePosition(el.i, A, scale);
      this.nodePosition(el.j, B, scale);
      for (const p of vis.pieces) placeBetween(p.mesh, A.clone().add(p.offsetI), B.clone().add(p.offsetJ));
      if (colorByEta) etaColor(eta[vis.element.index], vis.material.color);
      else vis.material.color.set(BASE_COLORS[vis.element.part]);
    }
    for (const st of this.stubs) {
      this.nodePosition(st.node, A, scale);
      placeBetween(st.mesh, A, A.clone().add(st.hang));
    }
  }

  /** Deck offset (deformation) at a coordinate x along the bridge [m from the west abutment]. */
  deckOffset(x: number, scale: number, out: THREE.Vector3): THREE.Vector3 {
    const nodes = this.model.deckNodes;
    const v = this.model.vertical;
    let lo = 0, hi = nodes.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (v.nodes[nodes[mid]].x <= x) lo = mid; else hi = mid;
    }
    const x0 = v.nodes[nodes[lo]].x, x1 = v.nodes[nodes[hi]].x;
    const t = THREE.MathUtils.clamp((x - x0) / (x1 - x0), 0, 1);
    const d = this.lastDisp;
    if (!d) return out.set(0, 0, 0);
    const y = (1 - t) * d(nodes[lo] * 3 + 1) + t * d(nodes[hi] * 3 + 1);
    const z = (1 - t) * this.lastLat(lo) + t * this.lastLat(hi);
    return out.set(0, y * scale, z * scale);
  }
}

/** Place a mesh whose geometry is aligned with local Y (length 1) between two points. */
export function placeBetween(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  dir.normalize();
  if (dir.y > -0.5) {
    mesh.quaternion.setFromUnitVectors(UP, dir);
  } else {
    // Pointing steeply downwards (piers): the shortest rotation from +Y to almost -Y is
    // unstable and makes the mesh spin around its axis. Flip first, then tilt.
    mesh.quaternion.setFromUnitVectors(UP, dir.negate()).multiply(FLIP);
  }
  mesh.scale.set(1, Math.max(len, 1e-3), 1);
}

/** Free GPU memory of a bridge that is replaced (mesh refinement, cut stays). */
export function disposeGroup(group: THREE.Object3D): void {
  group.removeFromParent();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
