# Outsyde - Social Marketplace Platform

## Overview

Outsyde is a social marketplace connecting customers with local small businesses. It is a TypeScript monorepo with a React frontend (Vite + TailwindCSS + shadcn/ui) and an Express backend, all served from a single process on port 5000.

## Cursor Cloud specific instructions

### Architecture

- **Single process**: Express serves both the REST API and the React frontend (via Vite middleware in dev, static files in prod). There is no separate frontend dev server.
- **Database**: PostgreSQL via `@neondatabase/serverless` (HTTP transport). In production, this connects to a Neon database. For local development, a Neon-compatible proxy is required (see below).
- **Auth**: Session-based for web, JWT for mobile. When not on Replit, the app uses basic session auth with Passport.js.

### Local Database Setup (Neon driver workaround)

The app uses `@neondatabase/serverless` which makes HTTP requests to the Neon API, not standard PostgreSQL TCP connections. For local development:

1. **PostgreSQL must be running** on `localhost:5432` (user: `outsyde`, password: `outsyde`, database: `outsyde`).
2. **Neon local proxy** (`.dev/neon-local-proxy.mjs`) must be running on port 4444. Start it with: `node .dev/neon-local-proxy.mjs &`
3. **Preload the neon config patch** by setting: `NODE_OPTIONS="--import ./.dev/neon-preload.mjs"`
4. This makes the `@neondatabase/serverless` driver route HTTP requests to the local proxy, which translates them to standard PostgreSQL queries.

### Starting the dev server

```bash
# 1. Start PostgreSQL (if not already running)
sudo pg_ctlcluster 16 main start

# 2. Start Neon local proxy (background)
node .dev/neon-local-proxy.mjs &

# 3. Push schema (only needed on first run or schema changes)
DATABASE_URL="postgresql://outsyde:outsyde@localhost:5432/outsyde" npx drizzle-kit push

# 4. Start dev server
export DATABASE_URL="postgresql://outsyde:outsyde@localhost:5432/outsyde"
export NODE_ENV=development
export PORT=5000
export JWT_SECRET=dev-jwt-secret-outsyde-2024
export PAYMENTS_ENABLED=false
export NODE_OPTIONS="--import ./.dev/neon-preload.mjs"
npx tsx server/index.ts
```

The app serves at `http://localhost:5000`.

### Important caveats

- **Stripe**: The app logs a Stripe initialization error at startup if `STRIPE_SECRET_KEY` is not set. This is expected in local dev — payment features won't work but everything else does.
- **TypeScript errors**: The codebase has ~63 pre-existing type errors (in `server/routes.ts`, `server/storage.ts`, etc.). The app runs fine because `tsx` skips type checking. Run `npx tsc --noEmit` to see them.
- **Schema push**: Uses `drizzle-kit push` with the standard `pg` driver (not the Neon HTTP driver), so it works directly with local PostgreSQL without the proxy.
- **No lint config**: There is no ESLint configuration. The only code quality check available is `npm run check` (TypeScript type checking via `tsc`).
- **Node.js 20**: The `.replit` config specifies `nodejs-20`. Use `nvm use 20` if a different version is active.
