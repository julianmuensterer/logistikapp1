import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import {
  BRIDGE_LENGTH, BridgeModel, CD, DECK_DEAD_LOAD, DECK_WIND_HEIGHT, PIER_X, PYLON_DEAD_LOAD, PYLON_HEIGHT,
  kNtoTonnes, windPressure, type Evaluation,
} from './fem/bridge';
import { Bridge3D } from './scene/bridge3d';
import { Cars } from './scene/cars';
import { Fracture } from './scene/failure';
import { WindStreaks } from './scene/wind';
import { createWorld } from './scene/world';
import { FemView } from './ui/femView';
import { FAILURE_TEXT, LEARN_CARDS } from './content/learn';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number, d = 0) => v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const MN = (kN: number) => `${fmt(kN / 1000, kN < 1e5 ? 1 : 0)} MN`;
const TONNES = (kN: number) => `${fmt(Math.round(kNtoTonnes(kN) / 10) * 10)} t`;

// ---------- renderer, camera ----------
const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 1, 15000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.95;
createWorld(scene);

const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [-1250, 320, 1350], target: [-150, -110, 0] },
  side: { pos: [0, -70, 2900], target: [0, -80, 0] },
  under: { pos: [-560, -170, 200], target: [-684, -10, 0] },
  pylon: { pos: [90, 70, 170], target: [0, 35, 0] },
  driver: { pos: [-1235, 9, -7], target: [-900, 9, -7] },
};
function setView(name: string): void {
  const v = VIEWS[name];
  camera.position.set(...v.pos);
  controls.target.set(...v.target);
  controls.update();
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.view === name));
}
document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => (b.onclick = () => setView(b.dataset.view!)));
setView('overview');

function resize(): void {
  const r = canvas.parentElement!.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------- tabs and learn cards ----------
const learn = $('tab-learn');
learn.innerHTML = LEARN_CARDS.map((c) => `<div class="card" id="card-${c.id}"><h3>${c.title}</h3>${c.body}</div>`).join('');
function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-loads').hidden = name !== 'loads';
  learn.hidden = name !== 'learn';
}
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));
function focusCard(id: string): void {
  showTab('learn');
  document.querySelectorAll('#tab-learn .card').forEach((c) => c.classList.remove('focus'));
  const card = $(`card-${id}`);
  card.classList.add('focus');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- model (built after the loading screen has painted) ----------
setTimeout(init, 30);

function init(): void {
  const t0 = performance.now();
  const model = new BridgeModel();
  const solveMs = performance.now() - t0;
  const bridge = new Bridge3D(model);
  scene.add(bridge.group);
  const cars = new Cars(scene);
  const wind = new WindStreaks(scene);
  const fem = new FemView($('fem-svg') as unknown as SVGSVGElement, $('fem-tip'), model);
  const v = model.vertical;
  $('fem-stats').textContent =
    `${v.nodes.length} nodes · ${v.elements.length} elements · ${v.dofCount} DOF (+ lateral model ${model.lateral.dofCount} DOF) · solved in ${fmt(solveMs)} ms`;
  $('loading').remove();

  const inputs = {
    traffic: $<HTMLInputElement>('traffic'),
    wind: $<HTMLInputElement>('wind'),
    safety: $<HTMLInputElement>('safety'),
    colors: $<HTMLInputElement>('colors'),
    scale: $<HTMLInputElement>('scale'),
  };
  const state = { q: 0, wind: 0, safety: false, colors: true, scale: 20, failed: false, frozen: false };
  let ev: Evaluation;
  let fracture: Fracture | null = null;
  let brokenElement = -1;

  fem.setForceText((idx) => {
    const fG = model.solG.forces[idx], fQ = model.solQ.forces[idx];
    const N = fG.N + state.q * fQ.N;
    const M = Math.max(Math.abs(fG.Mi + state.q * fQ.Mi), Math.abs(fG.Mj + state.q * fQ.Mj), Math.abs(fG.Mm + state.q * fQ.Mm));
    return `N = ${fmt(N / 1000, 2)} MN · |M|max = ${fmt(M / 1000, 1)} MNm (vertical model, characteristic)<br>`;
  });

  const selfWeight = DECK_DEAD_LOAD * BRIDGE_LENGTH + PYLON_DEAD_LOAD * PYLON_HEIGHT * PIER_X.length;
  $('selfw').textContent = `${MN(selfWeight)} · ${TONNES(selfWeight)}`;

  function recompute(): void {
    ev = model.evaluate(state.q, state.wind, state.safety);
    const trafficTotal = BridgeModel.trafficTotal(state.q);
    $('traffic-val').textContent = `${fmt(state.q, 1)} kN/m²`;
    $('traffic-sub').textContent = `≈ ${fmt(Math.round(kNtoTonnes(trafficTotal) / 1.5))} toy cars of 1.5 t (shown: one layer of cars per kN/m²)`;
    const pw = windPressure(state.wind);
    $('wind-val').textContent = `${fmt(state.wind)} km/h`;
    $('wind-sub').textContent = `pressure ${fmt(pw, 2)} kN/m² · lateral force on deck ${MN(pw * CD.deck * DECK_WIND_HEIGHT * BRIDGE_LENGTH)}`;

    const tol = BridgeModel.trafficTotal(ev.qMax);
    $('tol-note').textContent = state.safety ? '(characteristic, design check with γ)' : '(characteristic, no safety factors)';
    $('tol-mn').textContent = MN(tol);
    $('tol-t').textContent = TONNES(tol);
    $('tol-sub').innerHTML = ev.qMax > 0
      ? `q<sub>max</sub> = ${fmt(ev.qMax, 2)} kN/m² at ${fmt(state.wind)} km/h wind ≈ ${fmt(Math.floor(kNtoTonnes(tol) / 40))} trucks of 40 t<br>governed by: ${model.element(ev.qMaxGoverning).label}`
      : `The wind alone already exceeds the capacity: ${model.element(ev.qMaxGoverning).label}`;
    $('app-mn').textContent = MN(trafficTotal);
    $('app-t').textContent = TONNES(trafficTotal);
    const pct = ev.maxEta * 100;
    const bar = $('eta-bar');
    bar.style.width = `${Math.min(100, pct)}%`;
    bar.style.background = pct < 50 ? 'var(--ok)' : pct < 85 ? '#ffb020' : 'var(--bad)';
    $('eta-val').textContent = `${fmt(pct)} %`;
    $('eta-el').textContent = model.element(ev.governing).label;

    let maxDefl = 0, maxDrift = 0;
    model.deckNodes.forEach((n, t) => {
      maxDefl = Math.max(maxDefl, Math.abs(ev.displacement(n * 3 + 1)));
      maxDrift = Math.max(maxDrift, Math.abs(model.lateralDisplacement(t, state.wind)));
    });
    $('defl').textContent = `${fmt(maxDefl, 2)} m`;
    $('drift').textContent = `${fmt(maxDrift, 2)} m`;
    const p2 = model.lateral.nodes.findIndex((n) => Math.abs(n.x - PIER_X[1]) < 1e-6);
    $('pier-drift').textContent = `${fmt(model.lateralDisplacement(p2, state.wind) * 100, 1)} cm`;

    bridge.update(ev.displacement, ev.eta, state.scale, state.wind, state.colors);
    cars.setLoad(state.q);
    cars.update(bridge, state.scale, state.wind);
    wind.setWind(state.wind);
    fem.update(ev, state.scale);

    if (!state.failed && ev.maxEta > 1) fail();
  }

  function fail(): void {
    state.failed = true;
    brokenElement = ev.governing;
    const vis = bridge.visuals.get(brokenElement)!;
    const el = v.elements[brokenElement];
    const a = bridge.nodePosition(el.i, new THREE.Vector3(), state.scale, state.wind);
    const b = bridge.nodePosition(el.j, new THREE.Vector3(), state.scale, state.wind);
    fracture = new Fracture(scene, vis, a, b);
    // fly the camera to the broken element so the break is visible
    const mid = a.clone().lerp(b, 0.5);
    const part = model.element(brokenElement).part;
    const far = part === 'pier' ? 420 : 260;
    controls.target.copy(mid);
    // look from below for the deck (the toy cars would hide the break from above)
    camera.position.copy(mid).add(new THREE.Vector3(-0.45 * far, (part === 'deck' ? -0.3 : 0.35) * far, far));
    controls.update();
    for (const i of Object.values(inputs)) i.disabled = true;
    const e = model.element(brokenElement);
    $('failure-element').innerHTML = `<b>${e.label}</b> failed at ${fmt(ev.eta[brokenElement] * 100)} % utilisation.`;
    $('failure-text').textContent = FAILURE_TEXT[e.part];
    const total = BridgeModel.trafficTotal(state.q);
    $('failure-numbers').innerHTML = `Traffic: ${fmt(state.q, 1)} kN/m² = ${MN(total)} ≈ ${TONNES(total)} · Wind: ${fmt(state.wind)} km/h` +
      (state.safety ? ' · with partial safety factors' : '');
  }

  function freeze(): void {
    state.frozen = true;
    canvas.classList.add('frozen');
    $('failure').hidden = false;
  }

  $('reset').onclick = () => {
    fracture?.dispose();
    fracture = null;
    bridge.visuals.get(brokenElement)?.pieces.forEach((p) => (p.mesh.visible = true));
    state.failed = state.frozen = false;
    canvas.classList.remove('frozen');
    $('failure').hidden = true;
    for (const i of Object.values(inputs)) i.disabled = false;
    // back to a safe state: keep the wind if it is survivable, otherwise remove it
    state.q = 0;
    inputs.traffic.value = '0';
    if (model.evaluate(0, state.wind, state.safety).maxEta > 0.9) {
      state.wind = 0;
      inputs.wind.value = '0';
    }
    recompute();
  };

  inputs.traffic.oninput = () => { state.q = Number(inputs.traffic.value); recompute(); };
  inputs.wind.oninput = () => { state.wind = Number(inputs.wind.value); recompute(); };
  inputs.safety.onchange = () => { state.safety = inputs.safety.checked; recompute(); };
  inputs.colors.onchange = () => { state.colors = inputs.colors.checked; recompute(); };
  const applyScale = () => {
    state.scale = Number(inputs.scale.value);
    $('scale-val').textContent = inputs.scale.value;
    $('badge-scale').textContent = state.scale === 1 ? 'deformations at true scale' : `deformations exaggerated ×${state.scale}`;
    recompute();
  };
  inputs.scale.oninput = applyScale;
  $('true-scale').onclick = () => {
    inputs.scale.value = inputs.scale.value === '1' ? '20' : '1';
    $('true-scale').textContent = inputs.scale.value === '1' ? '×20' : 'true scale';
    applyScale();
  };

  // click on the bridge → learn card
  const ray = new THREE.Raycaster();
  let downAt = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('click', (e) => {
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return; // was a drag
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(bridge.group.children, false).find((h) => h.object.userData.part);
    if (hit) focusCard(hit.object.userData.part);
  });

  recompute();

  // ---------- loop ----------
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    if (state.frozen) return; // picture stays frozen (black & white) until reset
    controls.update();
    wind.tick(dt);
    if (!state.failed && cars.tick(dt, state.q)) cars.update(bridge, state.scale, state.wind);
    if (fracture && !fracture.tick(dt)) {
      renderer.render(scene, camera);
      freeze();
      return;
    }
    renderer.render(scene, camera);
  });
}
