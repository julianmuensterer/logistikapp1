# Millau Bridge Lab

A playful 3D browser game about the Viaduc de Millau for a Finite Element Method course.
Load the bridge with traffic and wind, watch a real (simplified) 2D FE model respond, and push
it until something breaks. See [docs/PLAN.md](docs/PLAN.md) for the project plan and sources.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # FE solver and bridge model tests
npm run build    # static build in dist/
```

Desktop browsers only (Chrome, Firefox, Edge).

## Structure

- `src/fem/frame2d.ts` – small 2D frame/truss FE solver (stiffness matrices, assembly, Cholesky solve)
- `src/fem/bridge.ts` – the bridge model: geometry, sections, loads, safety factors, utilisation, tolerable load
- `src/scene/` – stylized Three.js scene: terrain, bridge, toy cars, wind, fracture effect
- `src/ui/femView.ts` – 2D view of the FE mesh with deformed shape and utilisation colours
- `src/content/learn.ts` – learn-mode texts (English)

## Deployment

`.github/workflows/deploy.yml` runs the tests and builds on every PR, and publishes `main` to
GitHub Pages. One-time setup: *Settings → Pages → Source: GitHub Actions*.
