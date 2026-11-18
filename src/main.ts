import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import {
  BRIDGE_LENGTH, BridgeModel, CD, DECK_DEAD_LOAD, DECK_WIND_HEIGHT, PIER_X, PYLON_DEAD_LOAD, PYLON_HEIGHT,
  kNtoTonnes, windPressure, type Evaluation,
} from './fem/bridge';
import { Bridge3D, disposeGroup } from './scene/bridge3d';
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
  overview: { pos: [-1250, 320, 1350], target: [-150, -60, 0] },
  side: { pos: [0, -70, 2900], target: [0, -80, 0] },
  under: { pos: [-560, -170, 200], target: [-684, -10, 0] },
  pylon: { pos: [150, 80, 290], target: [0, 42, 0] },
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
  // The FE panel covers the bottom of the view: shift the image centre upwards so
  // the camera target sits in the middle of the visible area above the panel.
  const fem = document.getElementById('fem');
  const covered = fem ? fem.offsetHeight + 12 : 0;
  camera.setViewOffset(r.width, r.height, 0, covered / 2, r.width, r.height);
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
  $('tab-fem').hidden = name !== 'fem';
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
  const MESH_SIZES = [40, 20, 15, 8, 4];
  const MODE_AMPLITUDE = 12; // [m] shown amplitude of an animated mode shape
  const cutStays = new Set<string>();
  let model = new BridgeModel({ meshSize: 15 });
  let bridge = new Bridge3D(model);
  scene.add(bridge.group);
  const cars = new Cars(scene);
  const wind = new WindStreaks(scene);
  const svg = $('fem-svg') as unknown as SVGSVGElement;
  let fem = new FemView(svg, $('fem-tip'), model);
  $('loading').remove();

  const inputs = {
    traffic: $<HTMLInputElement>('traffic'),
    wind: $<HTMLInputElement>('wind'),
    safety: $<HTMLInputElement>('safety'),
    colors: $<HTMLInputElement>('colors'),
    scale: $<HTMLInputElement>('scale'),
    mesh: $<HTMLInputElement>('mesh'),
  };
  const state = {
    q: 0, wind: 0, safety: false, colors: true, scale: 20, failed: false, frozen: false,
    cutMode: false,
    mode: null as null | { kind: 'vertical' | 'lateral'; index: number; t0: number },
  };
  let ev: Evaluation;
  let fracture: Fracture | null = null;
  let brokenElement = -1;

  const forceText = (idx: number) => {
    const fG = model.solG.forces[idx], fQ = model.solQ.forces[idx];
    const N = fG.N + state.q * fQ.N;
    const M = Math.max(Math.abs(fG.Mi + state.q * fQ.Mi), Math.abs(fG.Mj + state.q * fQ.Mj), Math.abs(fG.Mm + state.q * fQ.Mm));
    return `N = ${fmt(N / 1000, 2)} MN · |M|max = ${fmt(M / 1000, 1)} MNm (vertical model, characteristic)<br>`;
  };

  const selfWeight = DECK_DEAD_LOAD * BRIDGE_LENGTH + PYLON_DEAD_LOAD * PYLON_HEIGHT * PIER_X.length;
  $('selfw').textContent = `${MN(selfWeight)} · ${TONNES(selfWeight)}`;

  // ---------- FEM tab: mesh info ----------
  const bytes = (b: number) => (b > 1e6 ? `${fmt(b / 1e6, 1)} MB` : `${fmt(b / 1e3, 0)} kB`);
  function showModelInfo(): void {
    const st = model.matrixStats();
    const v = st.vertical, l = st.lateral;
    $('fem-stats').textContent =
      `${v.nodes} nodes · ${v.elements} elements · ${v.dofs} DOF (+ lateral model ${l.dofs} DOF) · solved in ${fmt(model.solveMs)} ms`;
    $('mesh-val').textContent = `max. element length ${model.meshSize} m`;
    $('matrix-info').innerHTML = `
      <tr><th></th><th>elevation</th><th>lateral</th></tr>
      <tr><td>Nodes</td><td>${fmt(v.nodes)}</td><td>${fmt(l.nodes)}</td></tr>
      <tr><td>Elements</td><td>${fmt(v.elements)}</td><td>${fmt(l.elements)}</td></tr>
      <tr><td>DOF (3 per node)</td><td>${fmt(v.dofs)}</td><td>${fmt(l.dofs)}</td></tr>
      <tr><td>Global K (free DOF)</td><td>${fmt(v.equations)} × ${fmt(v.equations)}</td><td>${fmt(l.equations)} × ${fmt(l.equations)}</td></tr>
      <tr><td>Entries of K</td><td>${fmt(v.equations ** 2)}</td><td>${fmt(l.equations ** 2)}</td></tr>
      <tr><td>Non-zero entries</td><td>${fmt(v.nonZeros)} (${fmt((100 * v.nonZeros) / v.equations ** 2, 2)} %)</td><td>${fmt(l.nonZeros)} (${fmt((100 * l.nonZeros) / l.equations ** 2, 2)} %)</td></tr>
      <tr><td>Half-bandwidth</td><td>${fmt(v.bandwidth)}</td><td>${fmt(l.bandwidth)}</td></tr>
      <tr><td>Memory dense / band</td><td>${bytes(v.denseBytes)} / ${bytes(v.bandBytes)}</td><td>${bytes(l.denseBytes)} / ${bytes(l.bandBytes)}</td></tr>
      <tr><td>Assemble + solve</td><td colspan="2">${fmt(model.solveMs)} ms (banded Cholesky)</td></tr>`;
    $('modes-list').innerHTML = '';
    $('modes-note').textContent = 'Not computed yet for this mesh.';
    $('cut-count').textContent = cutStays.size ? `Restore all cables (${cutStays.size} cut)` : 'Restore all cables';
    ($('restore') as HTMLButtonElement).disabled = cutStays.size === 0;
  }

  function rebuild(): void {
    stopMode();
    disposeGroup(bridge.group);
    fem.dispose();
    model = new BridgeModel({ meshSize: MESH_SIZES[Number(inputs.mesh.value)], cutStays });
    bridge = new Bridge3D(model);
    scene.add(bridge.group);
    fem = new FemView(svg, $('fem-tip'), model);
    fem.setForceText(forceText);
    fem.elementClick = (idx) => { if (state.cutMode) cutStay(idx); };
    showModelInfo();
    recompute();
  }
  fem.setForceText(forceText);
  fem.elementClick = (idx) => { if (state.cutMode) cutStay(idx); };

  const lateralNow = (t: number) => model.lateralDisplacement(t, state.wind);

  function recompute(): void {
    ev = model.evaluate(state.q, state.wind, state.safety);
    const trafficTotal = BridgeModel.trafficTotal(state.q);
    $('traffic-val').textContent = `${fmt(state.q, 1)} kN/m²`;
    const tonnes = kNtoTonnes(trafficTotal);
    $('traffic-sub').textContent = state.q > 0
      ? `as heavy as ${fmt(Math.round(tonnes / 1.5))} cars (1.5 t) or ${fmt(Math.round(tonnes / 40))} trucks (40 t) or ${fmt(Math.round(tonnes / 60))} tanks (60 t). Toy vehicles are shown by weight: 1 toy car = 5 cars (7.5 t), truck 40 t, tank 60 t.`
      : 'Empty bridge. Toy vehicles are shown by weight: 1 toy car = 5 cars (7.5 t), truck 40 t, tank 60 t.';
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
    // always-visible HUD over the 3D view
    const etaColor = bar.style.background;
    const hb = $('hud-eta-bar');
    hb.style.width = `${Math.min(100, pct)}%`;
    hb.style.background = etaColor;
    $('hud-eta-val').textContent = `${fmt(pct)} %`;
    $('hud-eta-el').textContent = model.element(ev.governing).label;
    const loadPct = tol > 0 ? (trafficTotal / tol) * 100 : (trafficTotal > 0 ? Infinity : 0);
    const lb = $('hud-load-bar');
    lb.style.width = `${Math.min(100, loadPct)}%`;
    lb.style.background = loadPct < 50 ? 'var(--ok)' : loadPct < 85 ? '#ffb020' : 'var(--bad)';
    $('hud-load-val').textContent = `${MN(trafficTotal)} / ${MN(tol)}`;
    $('hud-load-sub').textContent = `${TONNES(trafficTotal)} of ${TONNES(tol)} tolerable${state.safety ? ' (with γ)' : ''}`;

    let maxDefl = 0, maxDrift = 0;
    model.deckNodes.forEach((n, t) => {
      maxDefl = Math.max(maxDefl, Math.abs(ev.displacement(n * 3 + 1)));
      maxDrift = Math.max(maxDrift, Math.abs(lateralNow(t)));
    });
    $('defl').textContent = `${fmt(maxDefl, 2)} m`;
    $('drift').textContent = `${fmt(maxDrift, 2)} m`;
    const p2 = model.lateral.nodes.findIndex((n) => Math.abs(n.x - PIER_X[1]) < 1e-6);
    $('pier-drift').textContent = `${fmt(lateralNow(p2) * 100, 1)} cm`;

    cars.setLoad(state.q);
    wind.setWind(state.wind);
    if (!state.mode) drawStatic();

    if (!state.failed && ev.maxEta > 1) fail();
  }

  function drawStatic(): void {
    bridge.update(ev.displacement, lateralNow, ev.eta, state.scale, state.colors);
    cars.update(bridge, state.scale);
    fem.update(ev, state.scale);
  }

  // ---------- natural modes ----------
  function drawMode(time: number): void {
    const m = state.mode!;
    const entry = model.modes()[m.index];
    const phase = MODE_AMPLITUDE * Math.sin(2 * Math.PI * entry.mode.f * (time - m.t0));
    const shape = entry.mode.shape;
    const disp = entry.kind === 'vertical' ? (d: number) => shape[d] * phase : () => 0;
    const lat = entry.kind === 'lateral' ? (t: number) => shape[t * 3 + 1] * phase : () => 0;
    bridge.update(disp, lat, ev.eta, 1, state.colors);
    cars.update(bridge, 1);
    fem.update(ev, 1, disp);
  }
  function stopMode(): void {
    if (!state.mode) return;
    state.mode = null;
    document.querySelectorAll('#modes-list button').forEach((b) => b.classList.remove('active'));
    $('badge-scale').textContent = state.scale === 1 ? 'deformations at true scale' : `deformations exaggerated ×${state.scale}`;
    if (ev) drawStatic();
  }
  $('compute-modes').onclick = () => {
    $('modes-note').textContent = 'Solving K φ = ω² M φ …';
    setTimeout(() => {
      const t0 = performance.now();
      const modes = model.modes();
      const ms = performance.now() - t0;
      $('modes-note').textContent = `Subspace iteration, lumped masses from self-weight · ${fmt(ms)} ms. Click a mode to animate it (real time).`;
      const list = $('modes-list');
      list.innerHTML = '';
      modes.forEach((m, i) => {
        const b = document.createElement('button');
        b.className = 'mode';
        b.innerHTML = `<b>Mode ${i + 1}</b> <span>${m.kind === 'vertical' ? 'vertical' : 'lateral'}</span> <span>f = ${fmt(m.mode.f, 3)} Hz</span> <span>T = ${fmt(m.mode.T, 2)} s</span>`;
        b.onclick = () => {
          if (state.mode?.index === i) return stopMode();
          state.mode = { kind: m.kind, index: i, t0: performance.now() / 1000 };
          list.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          $('badge-scale').textContent = `mode ${i + 1} (${m.kind}), amplitude exaggerated`;
        };
        list.appendChild(b);
      });
    }, 20);
  };

  // ---------- scissors: cut stay cables ----------
  const toast = $('toast');
  let toastTimer = 0;
  function showToast(text: string): void {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 2200);
  }
  function cutStay(idx: number): void {
    const e = model.element(idx);
    if (!e || e.part !== 'stay' || state.failed) return;
    cutStays.add(BridgeModel.stayKey(e.stay!.pylon, e.stay!.side, e.stay!.k));
    showToast(`✂ Snip! ${e.label} removed`);
    rebuild();
  }
  function setCutMode(on: boolean): void {
    state.cutMode = on;
    canvas.classList.toggle('scissors', on);
    svg.classList.toggle('scissors', on);
    $('cut-mode').classList.toggle('active', on);
    $('cut-mode').textContent = on ? '✂ Scissors on: click a cable' : '✂ Cut cables';
    setHover(null);
  }
  $('cut-mode').onclick = () => setCutMode(!state.cutMode);
  $('restore').onclick = () => {
    cutStays.clear();
    showToast('All cables restored');
    rebuild();
  };
  let hovered: THREE.MeshToonMaterial | null = null;
  function setHover(mat: THREE.MeshToonMaterial | null): void {
    if (hovered) hovered.emissive.set('#000000');
    hovered = mat;
    if (hovered) hovered.emissive.set('#ffffff').multiplyScalar(0.55);
  }

  // ---------- failure ----------
  function fail(): void {
    stopMode();
    state.failed = true;
    brokenElement = ev.governing;
    const vis = bridge.visuals.get(brokenElement)!;
    const el = model.vertical.elements[brokenElement];
    const a = bridge.nodePosition(el.i, new THREE.Vector3(), state.scale);
    const b = bridge.nodePosition(el.j, new THREE.Vector3(), state.scale);
    fracture = new Fracture(scene, vis, a, b);
    // fly the camera to the broken element so the break is visible
    const mid = a.clone().lerp(b, 0.5);
    const part = model.element(brokenElement).part;
    const far = part === 'pier' ? 420 : 260;
    controls.target.copy(mid);
    // look from below for the deck (the toy cars would hide the break from above)
    camera.position.copy(mid).add(new THREE.Vector3(-0.45 * far, (part === 'deck' ? -0.3 : 0.35) * far, far));
    controls.update();
    setInputsDisabled(true);
    const e = model.element(brokenElement);
    $('failure-element').innerHTML = `<b>${e.label}</b> failed at ${fmt(ev.eta[brokenElement] * 100)} % utilisation.`;
    $('failure-text').textContent = FAILURE_TEXT[e.part];
    const total = BridgeModel.trafficTotal(state.q);
    $('failure-numbers').innerHTML = `Traffic: ${fmt(state.q, 1)} kN/m² = ${MN(total)} ≈ ${TONNES(total)} · Wind: ${fmt(state.wind)} km/h` +
      (state.safety ? ' · with partial safety factors' : '') + (cutStays.size ? ` · ${cutStays.size} cable(s) cut` : '');
  }
  function setInputsDisabled(on: boolean): void {
    for (const i of Object.values(inputs)) i.disabled = on;
    for (const id of ['mix', 'cut-mode', 'restore', 'compute-modes']) ($(id) as HTMLButtonElement).disabled = on;
    if (!on) ($('restore') as HTMLButtonElement).disabled = cutStays.size === 0;
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
    setInputsDisabled(false);
    // back to a safe state: keep the wind if it is survivable, otherwise remove it
    state.q = 0;
    inputs.traffic.value = '0';
    if (model.evaluate(0, state.wind, state.safety).maxEta > 0.9) {
      state.wind = 0;
      inputs.wind.value = '0';
    }
    // if the cut cables alone make the bridge fail, give them back
    if (model.evaluate(0, state.wind, state.safety).maxEta > 1 && cutStays.size) {
      cutStays.clear();
      rebuild();
      return;
    }
    recompute();
  };

  const mix = $<HTMLSelectElement>('mix');
  mix.onchange = () => { cars.setMix(mix.value); recompute(); };
  inputs.traffic.oninput = () => { state.q = Number(inputs.traffic.value); recompute(); };
  inputs.wind.oninput = () => { state.wind = Number(inputs.wind.value); recompute(); };
  inputs.safety.onchange = () => { state.safety = inputs.safety.checked; recompute(); };
  inputs.colors.onchange = () => { state.colors = inputs.colors.checked; recompute(); };
  inputs.mesh.oninput = () => {
    $('mesh-val').textContent = `max. element length ${MESH_SIZES[Number(inputs.mesh.value)]} m · solving…`;
    clearTimeout(meshTimer);
    meshTimer = window.setTimeout(rebuild, 150);
  };
  let meshTimer = 0;
  const applyScale = () => {
    state.scale = Number(inputs.scale.value);
    $('scale-val').textContent = inputs.scale.value;
    if (!state.mode) $('badge-scale').textContent = state.scale === 1 ? 'deformations at true scale' : `deformations exaggerated ×${state.scale}`;
    recompute();
  };
  inputs.scale.oninput = applyScale;
  $('true-scale').onclick = () => {
    inputs.scale.value = inputs.scale.value === '1' ? '20' : '1';
    $('true-scale').textContent = inputs.scale.value === '1' ? '×20' : 'true scale';
    applyScale();
  };

  // mouse wheel on a slider changes its value (scroll up = more)
  const wheelStep: Record<string, number> = { traffic: 0.2, wind: 5, scale: 2, mesh: 1 };
  for (const input of [inputs.traffic, inputs.wind, inputs.scale, inputs.mesh]) {
    input.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (input.disabled) return;
      const step = wheelStep[input.id] * (e.shiftKey && input.id !== 'mesh' ? 5 : 1);
      const v = Number(input.value) + (e.deltaY < 0 ? step : -step);
      const clamped = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(v * 10) / 10));
      if (String(clamped) === input.value) return;
      input.value = String(clamped);
      input.dispatchEvent(new Event('input'));
    }, { passive: false });
  }

  // click on the bridge → learn card, or cut a cable in scissors mode
  const ray = new THREE.Raycaster();
  const pick = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hits = ray.intersectObjects(bridge.group.children, false).filter((h) => h.object.userData.part);
    return state.cutMode ? hits.find((h) => h.object.userData.part === 'stay') : hits[0];
  };
  let downAt = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointermove', (e) => {
    if (!state.cutMode || e.buttons) return;
    const hit = pick(e);
    setHover(hit ? bridge.visuals.get(hit.object.userData.element)!.material : null);
  });
  canvas.addEventListener('click', (e) => {
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return; // was a drag
    const hit = pick(e);
    if (!hit) return;
    if (state.cutMode) cutStay(hit.object.userData.element);
    else focusCard(hit.object.userData.part);
  });

  showModelInfo();
  recompute();

  // ---------- loop ----------
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    if (state.frozen) return; // picture stays frozen (black & white) until reset
    controls.update();
    wind.tick(dt);
    const driving = !state.failed && cars.tick(dt, state.q);
    if (state.mode) drawMode(performance.now() / 1000);
    else if (driving) cars.update(bridge, state.scale);
    if (fracture && !fracture.tick(dt)) {
      renderer.render(scene, camera);
      freeze();
      return;
    }
    renderer.render(scene, camera);
  });
}
