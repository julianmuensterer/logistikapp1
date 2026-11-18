import * as THREE from 'three';
import { BRIDGE_LENGTH } from '../fem/bridge';
import { toon } from './world';
import type { Bridge3D } from './bridge3d';

/** Toy cars are oversized on purpose so they are visible from far away. */
const CAR_LENGTH = 9;
const SLOT_SPACING = 12;
const LANES = [-9.5, -4.5, 4.5, 9.5];
const LEVEL_HEIGHT = 4.2;
const SLOTS_PER_LANE = Math.floor((BRIDGE_LENGTH - 20) / SLOT_SPACING);
export const SLOTS_PER_LAYER = SLOTS_PER_LANE * LANES.length;
/** One full layer of toy cars represents 1 kN/m² of traffic area load. */
export const CARS_PER_KN_M2 = SLOTS_PER_LAYER;
export const MAX_Q = 25;
const MAX_CARS = Math.ceil(MAX_Q * CARS_PER_KN_M2);

const PALETTE = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#b197fc', '#ffa94d', '#f783ac', '#38d9a9'];

const rand = (k: number) => {
  const s = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * The statics use a uniform area load. Visually, cars fill the lanes in random order
 * and then pile up in layers, one layer per kN/m².
 */
export class Cars {
  body: THREE.InstancedMesh;
  cabin: THREE.InstancedMesh;
  private order: number[];
  private count = 0;
  private driveOffset = 0;

  constructor(scene: THREE.Scene) {
    const bodyGeo = new THREE.BoxGeometry(CAR_LENGTH, 2.2, 4).translate(0, 1.6, 0);
    const cabinGeo = new THREE.BoxGeometry(4.8, 1.8, 3.4).translate(-0.6, 3.5, 0);
    this.body = new THREE.InstancedMesh(bodyGeo, toon('#ffffff'), MAX_CARS);
    this.cabin = new THREE.InstancedMesh(cabinGeo, toon('#e8f4ff'), MAX_CARS);
    const c = new THREE.Color();
    for (let i = 0; i < MAX_CARS; i++) this.body.setColorAt(i, c.set(PALETTE[Math.floor(rand(i) * PALETTE.length)]));
    this.body.count = this.cabin.count = 0;
    this.body.frustumCulled = this.cabin.frustumCulled = false;
    scene.add(this.body, this.cabin);
    // random fill order of the slots in one layer
    this.order = [...Array(SLOTS_PER_LAYER).keys()];
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(rand(i + 999) * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
  }

  setLoad(q: number): void {
    this.count = Math.min(MAX_CARS, Math.round(q * CARS_PER_KN_M2));
    this.body.count = this.cabin.count = this.count;
  }

  /** Cars drive while the bridge is nearly empty and come to a standstill as traffic grows. */
  tick(dt: number, q: number): boolean {
    const speed = Math.max(0, 1 - q / 0.8) * 28; // m/s
    if (speed === 0) return false;
    this.driveOffset = (this.driveOffset + speed * dt) % SLOT_SPACING;
    return true;
  }

  update(bridge: Bridge3D, scale: number, wind: number): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const off = new THREE.Vector3();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < this.count; i++) {
      const layer = Math.floor(i / SLOTS_PER_LAYER);
      const slot = this.order[i % SLOTS_PER_LAYER];
      const lane = slot % LANES.length;
      const dir = LANES[lane] > 0 ? 1 : -1;
      const n = Math.floor(slot / LANES.length);
      let x = 10 + n * SLOT_SPACING + (layer === 0 ? dir * this.driveOffset : (rand(i) - 0.5) * 3);
      if (x > BRIDGE_LENGTH - 6) x -= BRIDGE_LENGTH - 16;
      if (x < 6) x += BRIDGE_LENGTH - 16;
      bridge.deckOffset(x, scale, wind, off);
      p.set(x - BRIDGE_LENGTH / 2, off.y + layer * LEVEL_HEIGHT, LANES[lane] + off.z + (layer ? (rand(i + 7) - 0.5) * 2 : 0));
      const jitter = layer ? 1 : 0;
      e.set((rand(i + 3) - 0.5) * 0.25 * jitter, (dir > 0 ? 0 : Math.PI) + (rand(i + 5) - 0.5) * 0.9 * jitter, (rand(i + 9) - 0.5) * 0.25 * jitter);
      q.setFromEuler(e);
      m.compose(p, q, s);
      this.body.setMatrixAt(i, m);
      this.cabin.setMatrixAt(i, m);
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
  }
}
