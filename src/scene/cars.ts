import * as THREE from 'three';
import { BRIDGE_LENGTH } from '../fem/bridge';
import { toon } from './world';
import type { Bridge3D } from './bridge3d';

/** Toy cars are oversized on purpose so they are visible from far away. */
const CAR_LENGTH = 9;
const SLOT_SPACING = 12;
const LANES = [-9.5, -4.5, 4.5, 9.5];
/** Lanes move at slightly different speeds so the traffic looks natural. */
const LANE_SPEED = [1.0, 0.86, 0.93, 1.07];
const LEVEL_HEIGHT = 4.2;
/** Cars drive in a loop: across the bridge and on along the approach roads. */
const APPROACH = 300;
const LOOP = BRIDGE_LENGTH + 2 * APPROACH;
const SLOTS_PER_LANE = Math.floor(LOOP / SLOT_SPACING);
const LOOP_EXACT = SLOTS_PER_LANE * SLOT_SPACING;
export const SLOTS_PER_LAYER = SLOTS_PER_LANE * LANES.length;
/** One full layer of toy cars represents 1 kN/m² of traffic area load. */
export const CARS_PER_KN_M2 = SLOTS_PER_LAYER;
export const MAX_Q = 25;
const MAX_CARS = Math.ceil(MAX_Q * CARS_PER_KN_M2);
const ROAD_TOP = -0.5; // top of the approach roads

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
  /** distance travelled per lane [m], grows continuously (no jumps) */
  private travelled = LANES.map(() => 0);

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

  /**
   * Cars always drive. The more traffic, the slower they get (stop-and-go in a jam),
   * but every car moves continuously along its lane.
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
    for (let i = 0; i < this.count; i++) {
      const layer = Math.floor(i / SLOTS_PER_LAYER);
      const slot = this.order[i % SLOTS_PER_LAYER];
      const lane = slot % LANES.length;
      const dir = LANES[lane] > 0 ? 1 : -1;
      const n = Math.floor(slot / LANES.length);
      // position along the loop; piles of cars ride on top of the car below them
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
      this.body.setMatrixAt(i, m);
      this.cabin.setMatrixAt(i, m);
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
  }
}
