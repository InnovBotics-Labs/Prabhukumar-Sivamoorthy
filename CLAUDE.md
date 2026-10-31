# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # dev server (Turbopack) → http://localhost:3000
npm run build    # production build
npm run start    # serve the production build, binds to $PORT (default 3000)
npm run lint     # eslint (eslint.config.mjs)
npm run lint -- app/(site)/page.tsx   # lint a single file/path
```

There is **no test suite** in this repo.

Node 22 is pinned (`.node-version`). The `@/*` TypeScript path alias maps to the repo root.

## Big picture

A single-page personal portfolio **ported from a [Claude Design](https://claude.ai/design) prototype** into a production Next.js 16 App Router app (React 19, Tailwind v4, Framer Motion). Two standalone browser tools (a PDF editor and a code formatter) ride along in the same app.

Because of the port, **large parts of the codebase are vendored verbatim** from the prototype and should not be "cleaned up" casually — they are eslint-ignored or have relaxed lint rules on purpose (see `eslint.config.mjs`): `public/bg3d.js`, `public/image-slot.js`, `public/pdf-editor/**`, and the `components/pdf-editor/**` + `components/code-formatter/**` modules (faithful single-bundle ports preserving original shared-scope structure).

### Route groups = isolated apps

`app/` uses two route groups, **each with its own root `<html>/<body>` layout** so their CSS/design tokens never leak into each other (Next loads each segment's CSS only for that segment):

- **`app/(site)/`** — the portfolio. `layout.tsx` is the design shell (fonts, pre-paint theme script, `ThemeProvider`, `Atmosphere`, `SiteChrome`, `Footer`, vendored scripts). `page.tsx` composes sections in order: Hero → Marquee → AppStore → Work → About → Experience → Contact. `app/globals.css` is the full design system (OKLCH tokens, 3 palettes × light/dark) and loads **only** here.
- **`app/(tool)/`** — full-screen tools (`pdf-editor`, `code-formatter`), each with its own minimal layout + fonts. The tool pages `dynamic(..., { ssr: false })`-import heavy client-only components, since they rely on `window`/`document`/canvas/clipboard and must never run during SSR/prerender.

### Content is data, not markup

All portfolio copy lives in `lib/content.ts`. Section components map over it — **edit copy there, not in component JSX**. Prototype relative links (`apps/x.html`) are stored as absolute `/apps/x.html` paths resolving against `public/`.

### Theming (SSR-safe, no flash)

`components/ThemeProvider.tsx` owns theme / palette / accent hue / display font / film grain / 3D backdrop, persisted to `localStorage` (`ps_portfolio`). The flash-free pattern matters: SSR and first client render use the authored `DEFAULTS`; a **pre-paint inline `<script>` (`themeInitScript`, exported from the same file)** applies saved settings to `<html>`/`<body>` before React hydrates; the provider then reconciles `localStorage` in a mount effect. It also drives `window.BG3D` (the verbatim `public/bg3d.js` particle backdrop). If you change how settings are applied, update **both** `apply()` and `themeInitScript` to keep them in sync.

### PDF editor engine

`components/pdf-editor/lib/engine.ts` is the real engine: `pdfjs-dist` renders/extracts, `pdf-lib` builds/edits/flattens, and `crypto.ts` (qpdf-wasm) layers encryption. The pdf.js worker is served from `/pdf-editor/pdf.worker.min.mjs` (a vendored asset, not bundled).

### Other notable wiring

- `next.config.ts` rewrites `/.image-slots.state.json` → `/api/image-slots` (an empty sidecar) so the vendored `<image-slot>` web component doesn't 404. `<image-slot>` is a custom JSX element typed in `types/custom-elements.d.ts`; its drops only persist in the design runtime — placeholders here are intentional (see README TODO for replacing them with real images).
- **Deploy:** `render.yaml` deploys as a **Node web service, not a static site** (SSR + the `/api/image-slots` route require `next start`). The build runs `npm ci --include=dev` because `NODE_ENV=production` would otherwise drop the build-only devDeps (tailwind/postcss/typescript). Deploy branch is `dev/ver-1`. The **Kubernetes path** (home lab, in progress) is `Dockerfile` (Next `output: "standalone"`) + `k8s/base` Kustomize manifests + `.github/workflows/build-image.yml`, which pushes the image to Google Artifact Registry on pushes to `Portfolio_AD`; `app/api/health` is the probe endpoint. Runbook: `k8s/README.md`. Render stays until the cluster cutover.
