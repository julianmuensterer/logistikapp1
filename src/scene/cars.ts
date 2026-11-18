import * as THREE from 'three';
import { BRIDGE_LENGTH } from '../fem/bridge';
import { toon } from './world';
import type { Bridge3D } from './bridge3d';

/** Toy vehicles are oversized on purpose so they are visible from far away. */
const SLOT_SPACING = 13;
const LANES = [-9.5, -4.5, 4.5, 9.5];
/** Lanes move at slightly different speeds so the traffic looks natural. */
const LANE_SPEED = [1.0, 0.86, 0.93, 1.07];
const LEVEL_HEIGHT = 5;
/** Vehicles drive in a loop: across the bridge and on along the approach roads. */
const APPROACH = 300;
const LOOP = BRIDGE_LENGTH + 2 * APPROACH;
const SLOTS_PER_LANE = Math.floor(LOOP / SLOT_SPACING);
const LOOP_EXACT = SLOTS_PER_LANE * SLOT_SPACING;
export const SLOTS_PER_LAYER = SLOTS_PER_LANE * LANES.length;
/** One full layer of toy vehicles represents 1 kN/m² of traffic area load. */
export const VEHICLES_PER_KN_M2 = SLOTS_PER_LAYER;
export const MAX_Q = 25;
const MAX_VEHICLES = Math.ceil(MAX_Q * VEHICLES_PER_KN_M2);
const ROAD_TOP = -0.5; // top of the approach roads

const rand = (k: number) => {
  const s = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// ---------- vehicle types (local x = driving direction, y = up) ----------
interface Part {
  geo: THREE.BufferGeometry;
  color: string;
  /** use the per-vehicle colour from the palette */
  tinted?: boolean;
}
interface VehicleType {
  id: VehicleKind;
  label: string;
  /** real mass of the vehicle it represents [t] (for the info text only) */
  tonnes: number;
  palette: string[];
  parts: Part[];
}
export type VehicleKind = 'car' | 'truck' | 'tank';

const box = (l: number, h: number, w: number, x: number, y: number, z = 0) =>
  new THREE.BoxGeometry(l, h, w).translate(x, y, z);

const VEHICLES: VehicleType[] = [
  {
    id: 'car', label: 'car', tonnes: 1.5,
    palette: ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#b197fc', '#ffa94d', '#f783ac', '#38d9a9'],
    parts: [
      { geo: box(9, 2.2, 4, 0, 1.6), color: '#ffffff', tinted: true },
      { geo: box(4.8, 1.8, 3.4, -0.6, 3.5), color: '#e8f4ff' },
    ],
  },
  {
    id: 'truck', label: 'truck', tonnes: 40,
    palette: ['#e03131', '#1971c2', '#f08c00', '#2f9e44', '#5f3dc4'],
    parts: [
      { geo: box(2.8, 3.4, 4.2, 4.6, 2.3), color: '#ffffff', tinted: true }, // cab
      { geo: box(1.2, 1.2, 3.6, 4.4, 3.4), color: '#cfe8ff' }, // windscreen strip
      { geo: box(8.6, 4.2, 4.4, -1.4, 2.9), color: '#f1f3f5' }, // trailer box
      { geo: box(11.4, 0.7, 3.8, 0, 0.6), color: '#343a40' }, // chassis
    ],
  },
  {
    id: 'tank', label: 'toy tank', tonnes: 60,
    palette: ['#6b7d3a', '#5c6b32', '#7a8a45', '#4f5d2b'],
    parts: [
      { geo: box(9, 1.8, 3.6, 0, 1.7), color: '#ffffff', tinted: true }, // hull
      { geo: box(9.6, 1.5, 1.1, 0, 0.8, 2.0), color: '#2b2b2b' }, // track left
      { geo: box(9.6, 1.5, 1.1, 0, 0.8, -2.0), color: '#2b2b2b' }, // track right
      { geo: box(4.2, 1.5, 3.2, -0.6, 3.3), color: '#ffffff', tinted: true }, // turret
      { geo: new THREE.CylinderGeometry(0.3, 0.3, 6, 6).rotateZ(Math.PI / 2).translate(4.2, 3.4, 0), color: '#3d4422' }, // barrel
    ],
  },
];

export const VEHICLE_MIXES: Record<string, { label: string; weights: Record<VehicleKind, number> }> = {
  mixed: { label: 'Mixed traffic', weights: { car: 0.6, truck: 0.3, tank: 0.1 } },
  car: { label: 'Cars only', weights: { car: 1, truck: 0, tank: 0 } },
  truck: { label: 'Trucks only', weights: { car: 0, truck: 1, tank: 0 } },
  tank: { label: 'Toy tanks only', weights: { car: 0, truck: 0, tank: 1 } },
};

/**
 * The statics use a uniform area load. Visually, vehicles fill the lanes in random
 * order and then pile up in layers, one layer per kN/m².
 */
export class Cars {
  private meshes: THREE.InstancedMesh[][] = [];
  private order: number[];
  private count = 0;
  private kinds = new Uint8Array(MAX_VEHICLES);
  /** distance travelled per lane [m], grows continuously (no jumps) */
  private travelled = LANES.map(() => 0);

  constructor(scene: THREE.Scene) {
    const c = new THREE.Color();
    for (const type of VEHICLES) {
      const meshes = type.parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geo, toon(part.color), MAX_VEHICLES);
        if (part.tinted)
          for (let i = 0; i < MAX_VEHICLES; i++) mesh.setColorAt(i, c.set(type.palette[Math.floor(rand(i) * type.palette.length)]));
        mesh.count = 0;
        mesh.frustumCulled = false;
        scene.add(mesh);
        return mesh;
      });
      this.meshes.push(meshes);
    }
    // random fill order of the slots in one layer
    this.order = [...Array(SLOTS_PER_LAYER).keys()];
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(rand(i + 999) * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    this.setMix('mixed');
  }

  setMix(mix: string): void {
    const w = VEHICLE_MIXES[mix].weights;
    for (let i = 0; i < MAX_VEHICLES; i++) {
      const r = rand(i + 4242);
      this.kinds[i] = r < w.car ? 0 : r < w.car + w.truck ? 1 : 2;
    }
  }

  setLoad(q: number): void {
    this.count = Math.min(MAX_VEHICLES, Math.round(q * VEHICLES_PER_KN_M2));
  }

  /** Number of vehicles of each kind currently shown. */
  census(): Record<VehicleKind, number> {
    const n = { car: 0, truck: 0, tank: 0 };
    for (let i = 0; i < this.count; i++) n[VEHICLES[this.kinds[i]].id]++;
    return n;
  }

  /**
   * Vehicles always drive. The more traffic, the slower they get (stop-and-go in a
   * jam), but every vehicle moves continuously along its lane.
   */
  tick(dt: number, q: number): boolean {
    const speed = 30 / (1 + 0.6 * q); // m/s: 108 km/h on an empty bridge
    this.travelled = this.travelled.map((d, l) => (d + speed * LANE_SPEED[l] * dt) % LOOP_EXACT);
    return this.count > 0;
  }

  update(bridge: Bridge3D, scale: number, wind: number): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const off = new THREE.Vector3();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const used = VEHICLES.map(() => 0);
    for (let i = 0; i < this.count; i++) {
      const layer = Math.floor(i / SLOTS_PER_LAYER);
      const slot = this.order[i % SLOTS_PER_LAYER];
      const lane = slot % LANES.length;
      const dir = LANES[lane] > 0 ? 1 : -1;
      const n = Math.floor(slot / LANES.length);
      // position along the loop; piles ride on top of the vehicle below them
      let along = (n * SLOT_SPACING + dir * this.travelled[lane]) % LOOP_EXACT;
      if (along < 0) along += LOOP_EXACT;
      const x = along - APPROACH;
      const onBridge = x >= 0 && x <= BRIDGE_LENGTH;
      if (onBridge) bridge.deckOffset(x, scale, wind, off);
      else off.set(0, ROAD_TOP, 0);
      const pile = layer ? 1 : 0;
      p.set(x - BRIDGE_LENGTH / 2 + pile * (rand(i) - 0.5) * 3, off.y + layer * LEVEL_HEIGHT,
        LANES[lane] + off.z + pile * (rand(i + 7) - 0.5) * 2);
      e.set((rand(i + 3) - 0.5) * 0.25 * pile, (dir > 0 ? 0 : Math.PI) + (rand(i + 5) - 0.5) * 0.9 * pile, (rand(i + 9) - 0.5) * 0.25 * pile);
      q.setFromEuler(e);
      m.compose(p, q, s);
      const k = this.kinds[i];
      const idx = used[k]++;
      for (const mesh of this.meshes[k]) mesh.setMatrixAt(idx, m);
    }
    this.meshes.forEach((meshes, k) =>
      meshes.forEach((mesh) => {
        mesh.count = used[k];
        mesh.instanceMatrix.needsUpdate = true;
      }),
    );
  }
}

export { VEHICLES };
