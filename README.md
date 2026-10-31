# Prabhukumar Sivamoorthy — Portfolio

A single-page personal portfolio (Staff Engineer @ SanDisk), ported from a
[Claude Design](https://claude.ai/design) prototype ("Portfolio – Photo Hero")
into a production Next.js app. It also bundles two standalone browser tools —
a PDF editor and a code formatter — under their own routes.

**Stack:** Next.js (App Router) · TypeScript · Tailwind CSS v4 · Framer Motion.

## Run it

```bash
npm run dev      # dev server → http://localhost:3000
npm run build    # production build
npm run lint     # eslint
npm run start    # serve the production build
```

## Structure

The app uses two App Router **route groups**, each with its own root
`<html>`/`<body>` layout so their CSS and design tokens stay isolated:
`(site)` is the portfolio, `(tool)` holds standalone full-screen browser tools.

```
app/
  (site)/
    layout.tsx     portfolio shell: fonts, pre-paint theme init, Atmosphere, SiteChrome (Nav/Portal), Footer, vendored scripts
    page.tsx       section composition (Hero → Marquee → AppStore → Work → About → Experience → Contact)
  (tool)/
    pdf-editor/    full-screen PDF editor — annotate, reorder, split, merge, protect (client-only)
    code-formatter/ full-screen code/data formatter (client-only)
  globals.css      the design system, ported verbatim from the prototype (OKLCH tokens, 3 palettes × light/dark); loaded only by (site)
  api/image-slots  empty <image-slot> sidecar (served at /.image-slots.state.json via a rewrite)
  api/health       liveness/readiness probe for the Kubernetes deployment
components/
  ThemeProvider    theme / palette / accent / grain / 3D-backdrop state + localStorage; drives window.BG3D
  Reveal           Framer Motion scroll-reveal wrapper (replaces the prototype's .reveal + IntersectionObserver)
  SiteChrome       fixed chrome owning Nav + Portal modal open state
  Nav / Portal / Footer / BrandDot / Atmosphere
  sections/        Hero, Marquee, AppStore, Work, About, Experience, Contact
  pdf-editor/      PDF editor UI + engine (pdfjs-dist render, pdf-lib edit, qpdf-wasm encrypt) — verbatim port
  code-formatter/  code formatter UI + engine — verbatim port
lib/content.ts     all portfolio copy (edit content here, not in markup)
public/
  bg3d.js          3D particle backdrop — ported verbatim from the prototype
  image-slot.js    drag-drop image placeholder web component — ported verbatim
  apps/            App Store sub-pages + gradient icons
  pdf-editor/      vendored PDF runtime assets (pdf.js worker, qpdf-wasm glue)
Dockerfile         multi-stage image (Next standalone output) for the Kubernetes deploy
k8s/               Kustomize manifests (base + local overlay) + deploy runbook (k8s/README.md)
.github/workflows/ builds and pushes the image to Google Artifact Registry
```

The two tools live in `app/(tool)/` and are loaded with `dynamic(..., { ssr:
false })` because they rely on browser APIs (`window`/`document`/canvas/
clipboard) and must not run during SSR/prerender.

## Deploy

The site runs as a Node container on a home-lab Kubernetes cluster (SSR and
API routes rule out a static export). The `Dockerfile` builds Next's standalone
output, GitHub Actions pushes the image to Google Artifact Registry on pushes to
`Portfolio_AD`, and `kubectl apply -k k8s/base` rolls it out behind ingress-nginx.
The step-by-step runbook, including a registry-free path for testing on the
cluster, is in [`k8s/README.md`](k8s/README.md).

## Theming

Theme, film grain, and the 3D backdrop are controlled by the **settings gear**
in the footer; choices persist in `localStorage`. Authored defaults: light
theme, ink palette, emerald accent, grain on, 3D on.

## TODO (placeholders to fill in)

- **Photos** — the `<image-slot>` slots show placeholders. They only persist
  drops inside the Claude Design runtime; for this site, replace each
  `<image-slot>` (hero portrait, About portrait, project shots) with a real
  `<img>` / `next/image` pointing at files in `public/`.
- **`resume.pdf`** — both résumé buttons link to `/resume.pdf`; drop the real
  file into `public/`.
- **Contact form** — currently a client-side demo; wire it to a real endpoint.
- **Portal** — sign-in/register is a front-end demo; connect a real auth provider.
