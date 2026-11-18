import * as THREE from 'three';

const COUNT = 700;
const BOX = { x: 3000, yMin: -260, yMax: 160, z: 1800 };

/** Animated wind streaks blowing across the valley (in +z, perpendicular to the deck). */
export class WindStreaks {
  lines: THREE.LineSegments;
  private seeds: Float32Array;
  private speed = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(COUNT * 6), 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0 }));
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    this.seeds = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      this.seeds[i * 3] = (Math.random() - 0.5) * BOX.x;
      this.seeds[i * 3 + 1] = BOX.yMin + Math.random() * (BOX.yMax - BOX.yMin);
      this.seeds[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
    }
  }

  setWind(kmh: number): void {
    this.speed = kmh / 3.6;
    const mat = this.lines.material as THREE.LineBasicMaterial;
    mat.opacity = Math.min(0.9, kmh / 120);
    this.lines.visible = kmh > 1;
  }

  tick(dt: number): void {
    if (!this.lines.visible) return;
    const pos = this.lines.geometry.attributes.position as THREE.BufferAttribute;
    const len = 10 + this.speed * 0.6;
    for (let i = 0; i < COUNT; i++) {
      let z = this.seeds[i * 3 + 2] + this.speed * dt * 3;
      if (z > BOX.z / 2) z -= BOX.z;
      this.seeds[i * 3 + 2] = z;
      const x = this.seeds[i * 3], y = this.seeds[i * 3 + 1];
      const wobble = Math.sin(z * 0.02 + i) * 4;
      pos.setXYZ(i * 2, x, y + wobble, z);
      pos.setXYZ(i * 2 + 1, x, y + wobble, z - len);
    }
    pos.needsUpdate = true;
  }
}
