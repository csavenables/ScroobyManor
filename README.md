# 3DGSViewerV1

3DGSViewerV1 is a lightweight, config-driven web viewer template for product splat experiences. It is designed for static deployment (GitHub Pages or Cloudflare Pages), with a clear scene folder structure so projects can be duplicated quickly per client.

## Features

- TypeScript strict mode with a modular viewer architecture.
- Scene config loading and runtime schema validation with friendly error states.
- Configurable camera home view, orbit/pan/zoom limits, and smooth reset transitions.
- Multi-splat scene loading with supported runtime formats: `.ply`, `.splat`, `.ksplat`, `.spz`, `.sog`.
- Scrooby scene uses SOG-native runtime loading (no KSPLAT fallback in production scene config).
- Fade-out/fade-in scene transitions and basic loading UX.
- Per-splat bottom-up reveal / downward dissolve driven by `scene.json` reveal config.
- Optional `particleIntro` reveal mode for hero-style splat intros.
- Embed mode (`?embed=1`) for Wix/iframe usage with minimal UI.
- Scene switching via `public/scenes/manifest.json` (no code changes required to add scenes).
- Minimal responsive toolbar for reset, fullscreen, and auto-rotate.
- Friendly failures for invalid/unsupported scene assets.

## Getting Started

```bash
npm install
npm run dev
```

Build for static hosting:

```bash
npm run build
```

Preview production build:

```bash
npm run preview
```

## Controls

- Mouse / touch: orbit, pan, zoom.
- `Reset` button or `R`: return to home camera view.
- `Auto Rotate` button or `A`: toggle autorotate.
- `Fullscreen`: enter/exit fullscreen mode.

## Scene Workflow

1. Duplicate `public/scenes/demo` to `public/scenes/<clientSceneId>`.
2. Replace `.ply` files under `public/scenes/<clientSceneId>/splats`.
3. Update `public/scenes/<clientSceneId>/scene.json`.
4. Add the new scene to `public/scenes/manifest.json`.
5. Load with query param, e.g. `?scene=clientSceneId`.

Default startup scene is `sm-orbit-1-trimmed`.

## Runtime Query Params

- `scene=<sceneId>`: pick scene id from `public/scenes/manifest.json`.
- `embed=1`: hero embed mode (hides shell controls/chrome).
- `controls=1|0`: force show/hide visible controls.
- `replayButton=1|0`: show/hide floating replay button in embed mode (default `1` for embeds).
- `autorotate=1|0`: override scene default auto-rotate behavior.
- `parentOrigin=https://your-domain.com`: lock postMessage origin for embedded control.

## Reveal Config (Optional)

Add a `reveal` block in scene JSON to control bottom-up materialization:

```json
"reveal": {
  "enabled": true,
  "mode": "yRamp",
  "durationMs": 450,
  "band": 0.12,
  "ease": "easeInOut",
  "affectAlpha": true,
  "affectSize": true,
  "startPadding": 0,
  "endPadding": 0
}
```

## Load-Time Optimization Workflow

Convert production assets to `.ksplat` for fastest startup in this runtime:

```bash
npm run convert:ksplat
```

Conversion presets:

- `npm run convert:ksplat:speed`
- `npm run convert:ksplat` (balanced default)
- `npm run convert:ksplat:quality`
- `npm run convert:ksplat:topdown` (reorders `.splat` source by Y so progressive chunks favor upper geometry first)

Startup benchmark (captures `[perf]` logs from headless Chromium):

```bash
npm run bench:startup
```

If `bench:startup` reports missing Playwright:

```bash
npm i -D playwright
npx playwright install chromium
```

### SOG Pipeline

Generate SOG outputs with deterministic filtering presets:

```bash
npm run convert:sog:safe
npm run convert:sog:balanced
npm run convert:sog:aggressive
```

Generate only the balanced LOD streaming bundle:

```bash
npm run convert:sog:lod
```

Outputs per preset:

- `public/scenes/sm-orbit-1-trimmed/splats/sog/<preset>/scene.sog`
- `public/scenes/sm-orbit-1-trimmed/splats/sog/<preset>/lod/lod-meta.json`

Combined size + startup benchmark:

```bash
npm run bench:size-and-startup
```

Note: Scrooby scene policy is SOG-native (`assets[].src` must be `.sog` and `fallbackSrc` is rejected by schema validation).

### Performance Profile (Scene JSON)

Use `performanceProfile` in `scene.json` to reduce cold-start cost:

```json
"performanceProfile": {
  "enabled": true,
  "firstLoadIntroParticleCount": 4500,
  "firstLoadParticleDurationMs": 1800,
  "firstLoadDisableStaticPointCloud": true,
  "maxDevicePixelRatio": 1
}
```

## Deployment

- GitHub Pages and Cloudflare Pages are both supported.
- See `docs/DEPLOYMENT.md`.

## Checklists & Ops

- Client duplication guide: `docs/CLIENT_DUPLICATION_WORKFLOW.md`
- Mobile QA checklist: `docs/MOBILE_QA_CHECKLIST.md`
