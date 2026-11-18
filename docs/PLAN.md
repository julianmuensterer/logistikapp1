# Millau Bridge Lab: Project Plan

A playful desktop browser game about the **Viaduc de Millau** for the university course
**Finite Element Method** (civil engineering, taught in English). Students explore a
stylized 3D model of the bridge, learn about its materials and structural system, and
apply wind and traffic loads until the (simplified) structure fails. A live readout shows
the current load and the tolerable load in **MN** and **tonnes**.

> Status: planning only. No code yet. This document is meant to be reviewed and changed.

---

## 1. Goals

1. **See** the bridge: an interactive 3D model that is clearly stylized (toy-like, low-poly),
   not a photorealistic replica.
2. **Learn** about it: materials, structural system, load paths, and how an FE model of it
   is built (nodes, elements, boundary conditions, loads).
3. **Play** with it: set wind speed and traffic, watch deflections and stresses grow, and
   push the model to failure.
4. **Connect to FEM**: every number on screen comes from a small, real FE solve that runs in
   the browser, so the game doubles as a demonstrator for the lecture.

Non-goals: a certified structural analysis, mobile support, multiplayer.

---

## 2. Real bridge data (reference for the model)

| Item | Value | Source |
|---|---|---|
| Structural system | Multi-span cable-stayed bridge, 7 pylons, single central cable plane (semi-harp) | [1], [4] |
| Total length | 2,460 m | [1], [2] |
| Spans | 204 m + 6 × 342 m + 204 m (8 continuous spans) | [1], [2], [3] |
| Plan curvature / slope | Radius 20,000 m, longitudinal slope 3.025 % | [1] |
| Deck height above Tarn valley | about 270 m | [1], [2] |
| Deck | Steel box girder with orthotropic deck, 32.05 m wide, 4.20 m deep | [1], [3] |
| Deck steel | about 36,000 t (S355 and S460 / DI-MC 460) | [1], [3] |
| Pylons | 7 steel pylons, about 87–89 m above deck, 4,600 t steel | [1], [2], [3] |
| Highest point | about 343 m above ground (pylon top above P2) | [1] |
| Piers (reinforced concrete) | P1 94.5 m, P2 245.0 m, P3 221.1 m, P4 144.2 m, P5 136.4 m, P6 111.9 m, P7 77.6 m | [1] |
| Pier shape | Tapered concrete shafts, split into two thinner columns over the top ~90 m (flexible for thermal expansion of the deck) | [5], [4] |
| Pier concrete | about 53,000 m³ concrete, 10,000 t reinforcement | [1] |
| Stay cables | 154 stays (22 per pylon, 11 on each side, in one central plane), 55–91 strands each, longest about 180 m, about 1,500 t cable steel | [1], [2] |
| Total weight | about 290,000 t | [3], [4] |
| Wind | Mean 50-year wind at deck level 210 km/h (design study); side wind screens reduce wind effect on traffic by about 50 % | [5], [4] |
| Traffic | 2 lanes per direction plus emergency lanes | [4] |
| Opened | December 2004, after 39 months of construction | [2] |

Sources:

1. Structurae, *Millau Viaduct*: https://structurae.net/en/structures/millau-viaduct
2. Freyssinet, *Millau Viaduct construction*: https://www.freyssinet.com/case-study/millau-viaduct-construction/
3. Dillinger, *Heavy plate for the Viaduc de Millau* (PDF): https://en.dillinger.de/app/uploads/2024/03/20160211043536-millau_e.pdf
4. Road Traffic Technology, *Millau Viaduct*: https://roadtraffic-technology.com/projects/millau_viaduct
5. HAW Hamburg / DGLR lecture notes, *Millau Viaduct* (PDF): https://www.fzt.haw-hamburg.de/pers/Scholz/dglr/hh/text_2010_10_28_Millau_Viaduct.pdf

Sources disagree on a few figures (total concrete, wind design speed: 151 km/h vs. 210 km/h).
The app will show rounded values and state that they are approximate.

**Unit conversion shown in the app:** 1 MN = 1,000 kN ≈ 101.97 t (using g = 9.81 m/s²).
Example: a 40 t truck ≈ 0.39 MN; the deck steel alone ≈ 36,000 t ≈ 353 MN.

---

## 3. Features

### 3.1 3D scene
- Stylized low-poly bridge: deck, 7 piers (with the split upper part), 7 pylons, 154 stays,
  simplified Tarn valley terrain, river, a few toy trees and houses.
- Toon / flat shading, soft colors, slightly exaggerated proportions are allowed. A small
  "stylized model, not to scale" badge.
- Orbit camera (rotate, zoom, pan) plus preset views: overview, side elevation, under the
  deck, pylon close-up, "driver view".
- Toy cars and trucks that drive across the deck; their number follows the traffic slider.
- Wind visualized by animated streak particles and a windsock; trees bend.

### 3.2 Learn mode
- Clickable hotspots (deck, pier, pylon, stay cable, foundation, wind screen) that open a
  short info card: material, dimensions, role in the load path.
- "How it carries load" walkthrough: deck → stays → pylon → pier → foundation, highlighted
  step by step.
- Material cards: structural steel S355 / S460, high-strength concrete, prestressing strands
  (yield / tensile strength, Young's modulus, density).
- Fact sheet panel with the data from section 2 and the sources.

### 3.3 Load mode (the game)
- **Wind** slider (0–300 km/h) with direction (transverse to the deck by default).
  Wind pressure q = ½ ρ v², force F = q · c<sub>d</sub> · A on deck, pylons and piers.
- **Traffic** controls: number of cars and trucks, or a "traffic density" slider; optional
  presets (empty, rush hour, traffic jam of trucks, "every truck in France").
- Optional extras: temperature change, one pier settlement, cutting a single stay cable.
- Live result panel:
  - Applied load in **MN** and **t** (traffic, wind, self-weight).
  - **Tolerable load** in **MN** and **t** for the current wind level (from the model).
  - Utilization bar (0–100 %+) for the most stressed element, with its name.
  - Maximum deck deflection (m) and pylon top drift (m).
- When utilization exceeds 100 %: failure sequence. The first failed element is marked,
  then a scripted, cartoon-style collapse animation (no gore, cars bounce away like toys).
  Then a "What happened?" card explains the failure mode (e.g. stay rupture, pier bending,
  deck yielding) and a Reset button.

### 3.4 FEM view (for the lecture)
- Toggle between the 3D look and the **FE mesh**: nodes, beam elements (deck, pylons, piers),
  truss/cable elements (stays), supports.
- Color map of axial force / bending moment / utilization, with a legend.
- Deformed shape with an adjustable scale factor (e.g. ×1, ×100).
- Element inspector: click an element to see its type, section properties, local stiffness
  matrix, end forces.
- Info panel: number of nodes, elements, degrees of freedom, solve time.
- Optional: mesh refinement slider (elements per span) to show convergence of deflection.

### 3.5 Challenges (game layer)
- Short tasks such as "Find the wind speed at which the bridge can carry no more traffic",
  "Which element fails first?", "Remove one stay. What changes?".
- Score / star rating and a simple results screen. Useful as in-class exercises.

---

## 4. MVP vs. later

**MVP (first playable version)**
- Stylized 3D bridge with orbit camera and 3 preset views.
- Wind slider and traffic slider (uniform area load in kN/m²); toy cars that fill the lanes and pile up as the load grows.
- Toggle for partial safety factors.
- 2D FE frame model in the longitudinal plane (deck + pylons + piers as beams, stays as
  tension-only trusses), linear static solve in the browser.
- Lateral wind handled by a simple separate 2D model (deck as a continuous beam on elastic
  pier supports) or a hand formula. Combined into one utilization check.
- Result panel with load and tolerable load in MN and t, utilization bar.
- Failure state: the first failing element visibly breaks or snaps, then the image freezes and turns black and white; reset button.
- Learn hotspots for the 5 main components and a fact sheet with sources.
- English UI, desktop browsers (Chrome, Firefox, Edge).

**Later**
- Full 3D frame model (6 DOF per node) instead of the 2D models.
- FEM view with element inspector, stiffness matrix display, mesh refinement.
- Stress / utilization color maps on the 3D model.
- Challenges with scores; teacher mode with preset scenarios.
- Simple nonlinear effects: cable sag (Ernst modulus), P-Δ for the tall piers.
- Dynamic effects: natural frequencies and mode shapes animation (a nice FEM topic),
  a "vortex shedding" demo.
- Sound effects, more scenery, day/night.

---

## 5. Engineering model (how "tolerable load" is computed)

- **Discretization:** nodes at piers, pylon tops, stay anchors on the deck and pylons.
  Roughly 150–400 DOF in the 2D MVP model, which solves in milliseconds in the browser.
- **Elements:**
  - Deck: Euler-Bernoulli beam, steel box section (A, I from a simplified 32 m × 4.2 m box).
  - Pylons and piers: beams with tapered or stepped sections.
  - Stays: truss elements, tension only (iterate: remove stays in compression and re-solve).
- **Loads:** self-weight (from the 290,000 t total, distributed), traffic as distributed or
  point loads (cars ≈ 1.5 t, trucks ≈ 40 t), wind as distributed loads from F = ½ ρ v² c<sub>d</sub> A.
- **Failure check:** utilization η = σ / f<sub>y</sub> (steel, stays) and a simple
  moment-capacity check for the concrete piers. Failure when max η > 1.
- **Tolerable load:** because the model is linear, the remaining traffic capacity at the
  current wind is found by scaling: λ = (1 − η<sub>dead+wind</sub>) / η<sub>traffic,unit</sub>,
  then shown as λ × unit traffic load in MN and t.
- **Honesty note in the app:** "Simplified teaching model. Real safety factors, dynamic
  effects and detailed design are not included. The real bridge is far safer than this game."

---

## 6. Suggested tech stack

| Area | Choice | Why |
|---|---|---|
| Language / build | TypeScript + Vite | Fast dev server, simple static build |
| 3D | Three.js | Mature, large community, good for low-poly / toon look |
| UI panels | Plain HTML/CSS (or lil-gui for sliders) | Simple, no framework needed for MVP |
| FE solver | Own small TypeScript module (assemble K, apply BCs, solve K·u = f with dense or banded Cholesky) | Transparent, teachable code that students can read |
| Charts | Small SVG charts or uPlot | Deflection / force diagrams |
| Animation | Three.js + simple tweening | Collapse sequence, cars |
| Tests | Vitest | Check solver against hand calculations (cantilever, simply supported beam, truss) |
| Hosting | GitHub Pages (static) | Free, link can be shared with students |

Proposed folder layout:

```
src/
  scene/      3D bridge, terrain, vehicles, wind particles
  fem/        elements, assembly, solver, model of the bridge
  ui/         panels, sliders, info cards
  content/    texts for learn mode (English)
docs/
  PLAN.md
```

---

## 7. Milestones

1. **Scaffold:** Vite + TS + Three.js, empty scene, deploy to GitHub Pages.
2. **Bridge model:** stylized 3D geometry from the real dimensions.
3. **FE core:** beam and truss elements, solver, unit tests against textbook cases.
4. **Bridge FE model + loads:** wind and traffic sliders wired to the solver.
5. **Results and failure:** MN / t panel, utilization, collapse animation.
6. **Learn mode:** hotspots, info cards, fact sheet with sources.
7. **Polish and classroom test.**

---

## 8. Decisions (2026-11-18)

Answers from Julian to the open questions of the first draft:

| Question | Decision |
|---|---|
| Depth of FEM content | Show the **results** of the stiffness-matrix solve (displacements, element forces, utilization). The matrix itself does not need to be displayed. |
| 2D vs. 3D model | A **2D FE model** is enough for the MVP. |
| Safety factors | A **toggle** switches partial safety factors on and off. |
| Traffic model | Statics use a **uniform area load** (kN/m²). Visually it should look like more and more cars pile up on the deck. |
| Collapse | It is enough to see **something break or snap**; then the picture **freezes and turns black and white**. |

Partial factors used when the toggle is on (Eurocode style, simplified):
γ<sub>G</sub> = 1.35 (self-weight), γ<sub>Q</sub> = 1.5 (traffic), γ<sub>W</sub> = 1.5 (wind),
γ<sub>M0</sub> = 1.0 (structural steel), γ<sub>M</sub> = 1.5 (stay cables, on f<sub>uk</sub>),
γ<sub>c</sub> = 1.5 (concrete, with α<sub>cc</sub> = 0.85).

## 9. Still open

1. **Language:** English only, or a German toggle?
2. **Use in class:** projector, or students on their own laptops? Is a challenge mode wanted later?
3. **Hosting:** is GitHub Pages fine, or does it need to run offline / on the university LMS?
4. **Repo name:** the repo is called `logistikapp1`. Keep it or rename it later?
