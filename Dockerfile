# syntax=docker/dockerfile:1

# ============================================================
# wacrm — production image (Next.js 16 standalone output)
#
# Three stages so the runtime image carries neither the full
# node_modules tree nor the source: `deps` installs, `builder`
# compiles, `runner` ships only `.next/standalone` + assets.
#
# IMPORTANT — build-time env:
#   `NEXT_PUBLIC_*` values are inlined into the client bundle during
#   `next build`, NOT read at runtime. They must therefore be passed
#   as --build-arg (docker-compose.yml wires this up). Changing one
#   later requires a rebuild, not just a restart. Server-only secrets
#   (SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, META_APP_SECRET) are
#   read at runtime and must NOT be build args — that would bake them
#   into image layers.
# ============================================================

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app

# libc6-compat: some native deps expect glibc symbols on musl.
RUN apk add --no-cache libc6-compat

# Copy only the manifests so this layer caches until deps change.
COPY package.json package-lock.json ./
RUN npm ci


# ---------- builder ----------
FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Inlined into the client bundle at build time — see header note.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


# ---------- runner ----------
FROM node:22-alpine AS runner
WORKDIR /app

# Listens on 3060, not Next's default 3000 — the host already runs
# focas-ai-mentor there, and keeping the internal port identical to the
# published one means the mapping stays 1:1 and there's no 3000 anywhere
# to confuse things.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3060 \
    HOSTNAME=0.0.0.0

# Run unprivileged. `node` (uid 1000) already exists in the base image.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

# `output: "standalone"` traces the minimal server + node_modules subset.
# `public/` and `.next/static/` are deliberately excluded from that trace,
# so copy them in explicitly or every asset 404s.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3060

# The standalone entrypoint honours PORT / HOSTNAME from the env above.
CMD ["node", "server.js"]
