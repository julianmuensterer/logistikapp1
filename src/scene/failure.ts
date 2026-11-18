import * as THREE from 'three';
import { placeBetween, type ElementVisual } from './bridge3d';
import { toon } from './world';

interface Half {
  mesh: THREE.Mesh;
  anchor: THREE.Vector3;
  tip: THREE.Vector3;
  velocity: THREE.Vector3;
  offsetFromAxis: THREE.Vector3;
}

/**
 * Break animation: the failing element snaps in the middle, both halves swing away
 * from their supports and some debris flies off. Lasts about 1.4 s.
 */
export class Fracture {
  private halves: Half[] = [];
  private debris: { mesh: THREE.Mesh; v: THREE.Vector3; w: THREE.Vector3 }[] = [];
  private t = 0;
  private start = performance.now();
  readonly duration = 1.4;
  private group = new THREE.Group();

  constructor(scene: THREE.Scene, visual: ElementVisual, a: THREE.Vector3, b: THREE.Vector3) {
    scene.add(this.group);
    const red = toon('#ff3b30');
    const isStay = visual.element.part === 'stay';
    const mid = a.clone().lerp(b, 0.5);
    const along = b.clone().sub(a).normalize();
    for (const p of visual.pieces) {
      p.mesh.visible = false;
      for (const [end, off] of [[a, p.offsetI], [b, p.offsetJ]] as const) {
        const mesh = new THREE.Mesh(p.mesh.geometry, red);
        this.group.add(mesh);
        const anchor = end.clone().add(off);
        const tipOffset = off.clone().lerp(end === a ? p.offsetJ : p.offsetI, 0.5);
        const gap = along.clone().multiplyScalar(end === a ? -2 : 2);
        const tip = mid.clone().add(tipOffset).add(gap);
        // stays whip down hard, stiff members sag and swing outwards
        const velocity = new THREE.Vector3(0, isStay ? -60 : -25, 0).addScaledVector(along, end === a ? -10 : 10);
        this.halves.push({ mesh, anchor, tip, velocity, offsetFromAxis: off });
      }
    }
    const debrisGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    for (let k = 0; k < 40; k++) {
      const m = new THREE.Mesh(debrisGeo, k % 2 ? red : toon('#555555'));
      m.position.copy(mid);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(60);
      this.debris.push({ mesh: m, v, w: new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(8) });
      this.group.add(m);
    }
    this.tick(0);
  }

  /** returns true while the animation is running */
  tick(dt: number): boolean {
    this.t += dt;
    const g = new THREE.Vector3(0, -40, 0);
    for (const h of this.halves) {
      h.velocity.addScaledVector(g, dt);
      h.tip.addScaledVector(h.velocity, dt);
      // keep the length of the half (pendulum around its anchor)
      const len = h.mesh.userData.len ?? h.tip.distanceTo(h.anchor);
      h.mesh.userData.len = len;
      const d = h.tip.clone().sub(h.anchor).setLength(len);
      h.tip.copy(h.anchor).add(d);
      placeBetween(h.mesh, h.anchor, h.tip);
    }
    for (const d of this.debris) {
      d.v.addScaledVector(g, dt);
      d.mesh.position.addScaledVector(d.v, dt);
      d.mesh.rotation.x += d.w.x * dt;
      d.mesh.rotation.y += d.w.y * dt;
    }
    // wall-clock limit as well, so slow machines don't wait forever
    return this.t < this.duration && performance.now() - this.start < this.duration * 1000 * 1.5;
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}
