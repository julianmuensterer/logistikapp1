import * as THREE from 'three';
import { BRIDGE_LENGTH, PIER_HEIGHTS, PIER_X } from '../fem/bridge';

/** Three-tone gradient for the toon look. */
export const toonGradient = (() => {
  const data = new Uint8Array([90, 170, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
})();

export const toon = (color: THREE.ColorRepresentation) =>
  new THREE.MeshToonMaterial({ color, gradientMap: toonGradient });

/** Ground elevation below the bridge axis (deck = 0) as a function of x along the bridge. */
const PROFILE: [number, number][] = (() => {
  const pts: [number, number][] = [[-900, 15], [-300, 8], [0, -6]];
  PIER_X.forEach((x, p) => pts.push([x, -PIER_HEIGHTS[p]]));
  pts.push([700, -262]); // river Tarn
  pts.push([BRIDGE_LENGTH, -6], [BRIDGE_LENGTH + 300, 8], [BRIDGE_LENGTH + 900, 15]);
  return pts.sort((a, b) => a[0] - b[0]);
})();

export function groundAt(x: number): number {
  for (let k = 0; k < PROFILE.length - 1; k++) {
    const [x0, y0] = PROFILE[k];
    const [x1, y1] = PROFILE[k + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      const s = t * t * (3 - 2 * t); // smooth
      return y0 + (y1 - y0) * s;
    }
  }
  return x < PROFILE[0][0] ? PROFILE[0][1] : PROFILE[PROFILE.length - 1][1];
}

const hash = (x: number, z: number) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** Terrain elevation: profile along the bridge axis, valley sides rising away from it. */
function terrainHeight(x: number, z: number): number {
  // the valley widens: away from the bridge axis the terrain follows a "softened" profile
  const base = groundAt(x);
  const side = Math.min(1, Math.abs(z) / 1800);
  const plateau = 15;
  const h = base + (plateau - base) * side * side * 0.35;
  const bumps = Math.sin(x * 0.006 + z * 0.004) * 12 + Math.sin(z * 0.011) * 6;
  return h + bumps * (0.4 + 0.6 * side);
}

export function createWorld(scene: THREE.Scene): void {
  scene.background = new THREE.Color('#bfe3ff');
  scene.fog = new THREE.Fog('#d6ecff', 2500, 7000);

  const hemi = new THREE.HemisphereLight('#ffffff', '#8fb47a', 1.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff4dd', 2.2);
  sun.position.set(-800, 1500, 900);
  scene.add(sun);

  // --- terrain
  const sizeX = 5200;
  const sizeZ = 4400;
  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, 160, 120);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const cLow = new THREE.Color('#7fbf6a');
  const cHigh = new THREE.Color('#c9d98a');
  const cRock = new THREE.Color('#c8b49a');
  for (let i = 0; i < pos.count; i++) {
    const X = pos.getX(i);
    const Z = pos.getZ(i);
    const x = X + BRIDGE_LENGTH / 2;
    const y = terrainHeight(x, Z);
    pos.setY(i, y);
    const t = THREE.MathUtils.clamp((y + 260) / 280, 0, 1);
    const c = cLow.clone().lerp(cHigh, t);
    if (hash(X, Z) > 0.85) c.lerp(cRock, 0.5);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const flat = geo.toNonIndexed(); // faceted, low-poly look
  flat.computeVertexNormals();
  const terrain = new THREE.Mesh(flat, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient }));
  terrain.name = 'terrain';
  scene.add(terrain);

  // --- river Tarn (flows across the valley, roughly along z)
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(70, sizeZ),
    new THREE.MeshToonMaterial({ color: '#4fa3e0', gradientMap: toonGradient }),
  );
  river.rotation.x = -Math.PI / 2;
  river.position.set(700 - BRIDGE_LENGTH / 2, groundAt(700) + 6, 0);
  scene.add(river);

  // --- toy trees (instanced cones + trunks)
  const treeCount = 900;
  const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(14, 40, 6), toon('#3f9b4f'), treeCount);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(3, 3, 10, 5), toon('#8a5a3b'), treeCount);
  const m = new THREE.Matrix4();
  let placed = 0;
  for (let k = 0; placed < treeCount && k < treeCount * 4; k++) {
    const X = (hash(k, 1) - 0.5) * sizeX * 0.9;
    const Z = (hash(k, 2) - 0.5) * sizeZ * 0.9;
    if (Math.abs(Z) < 60) continue; // keep the bridge corridor free
    if (Math.abs(X + BRIDGE_LENGTH / 2 - 700) < 60) continue; // river
    const y = terrainHeight(X + BRIDGE_LENGTH / 2, Z);
    const s = 0.7 + hash(k, 3) * 0.8;
    m.makeScale(s, s, s).setPosition(X, y + 5 * s + 20 * s, Z);
    crown.setMatrixAt(placed, m);
    m.makeScale(s, s, s).setPosition(X, y + 5 * s, Z);
    trunk.setMatrixAt(placed, m);
    placed++;
  }
  crown.count = trunk.count = placed;
  scene.add(crown, trunk);

  // --- puffy clouds
  const cloudMat = toon('#ffffff');
  for (let k = 0; k < 14; k++) {
    const g = new THREE.Group();
    for (let b = 0; b < 4; b++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(40 + hash(k, b) * 40, 10, 8), cloudMat);
      s.position.set(b * 55, hash(b, k) * 25, hash(k + b, 7) * 30);
      g.add(s);
    }
    g.position.set((hash(k, 11) - 0.5) * 5000, 450 + hash(k, 12) * 300, (hash(k, 13) - 0.5) * 4000);
    scene.add(g);
  }
}
