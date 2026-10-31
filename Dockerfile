# syntax=docker/dockerfile:1

# Multi-stage build for the Next.js portfolio (+ tools).
#
#   deps    -> install the full dependency tree (devDeps included: tailwind,
#              postcss and typescript are build-time only)
#   builder -> `next build` with output: "standalone" (see next.config.ts)
#   runner  -> minimal image: standalone server.js + static assets, non-root
#
# Build:  docker build -t portfolio:local .
# Run:    docker run --rm -p 3000:3000 portfolio:local

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev: NODE_ENV may be production in CI, which would drop the
# build-only devDependencies the build needs.
RUN npm ci --include=dev

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# The standalone server does not include public/ or .next/static by default;
# copy them alongside so server.js serves them itself (no CDN in the home lab).
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
