# poker-server

Phase 3a real-time game server for the Poker PWA. Wraps the Phase 2
`poker-engine` library and exposes a Socket.IO API to clients. Shares the
Phase 1 Supabase project for auth, lounges, and persistence.

No UI — that's Phase 3b. See `../poker-pwa` for the SvelteKit frontend.

## Stack

Node 20+, Fastify, Socket.IO, `@supabase/supabase-js` (service role),
`jose` for JWT, `pino` for logs, `zod` for input validation, `vitest`.

## Env vars

Copy `.env.example` to `.env` and fill in.

| Variable | Notes |
|---|---|
| `PORT` | HTTP/WebSocket port. Defaults to `3001`. |
| `NODE_ENV` | `development` / `test` / `production`. |
| `SUPABASE_URL` | Shared with the PWA. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; bypasses RLS for writes. Never expose. |
| `SUPABASE_JWT_SECRET` | From Supabase dashboard → Settings → API → JWT Settings. Used to verify client JWTs locally. |
| `ALLOWED_ORIGINS` | Comma-separated. Defaults to `http://localhost:5173`. |
| `LOG_LEVEL` | `info`, `debug`, etc. |

## Local development

```sh
# from this directory
npm install
npm run dev          # uses your .env (real Supabase)
curl http://localhost:3001/health
```

The server consumes the engine via `file:../poker-engine`. The engine must
be built (`cd ../poker-engine && npm run build`) — its npm `files` field
ships only `dist/`.

### Local play with NO database (`DEV_NO_DB=1`)

If you just want to play through the WebSocket protocol without touching
Supabase at all:

```sh
npm run dev:nodb     # boots with in-memory stores, prints copy-paste JWTs
```

The server pre-creates a hardcoded lounge and prints two ready-to-paste
PowerShell + bash blocks containing JWTs for two test users. Open two
more terminals, paste one block in each, and they'll connect, sit at
seats 0 and 1, and let you play interactively. Every JWT presented to
the server in this mode is auto-added as a member of the dev lounge.
Hands are kept in memory only — restart the server to wipe everything.

## Database migration

The new schema lives in the PWA repo so all migrations stay in one place:

```
../poker-pwa/supabase/migrations/003_sessions_and_hands.sql
```

Run it manually in the Supabase SQL editor for project
`iykciotzrdiimmdmwkze`. Creates `sessions`, `session_players`, `hands`,
`hand_players` with SELECT-only RLS for lounge members; all writes go
through the service role.

## Demo CLI clients (no UI required)

Two CLI clients side-by-side can play a full hand end-to-end. First, mint
a JWT for each test user (use real `auth.users.id` values from the PWA):

```sh
JWT_A=$(npx tsx scripts/mintTestJwt.ts <userId-A>)
JWT_B=$(npx tsx scripts/mintTestJwt.ts <userId-B>)
```

In two terminals:

```sh
JWT=$JWT_A LOUNGE_ID=<uuid> SEAT=0 BUY_IN=1000 npm run demo
JWT=$JWT_B LOUNGE_ID=<uuid> SEAT=1 BUY_IN=1000 npm run demo
```

Inside each client, type:

| Key | Action |
|---|---|
| `s` | start the next hand |
| `c` | check |
| `l` | call |
| `r <n>` | raise to total `<n>` |
| `b <n>` | bet `<n>` |
| `a` | all in |
| `f` | fold |
| `q` | quit |

Add `--bot` to either client to make it always check/call automatically.

## Tests

```sh
npm test
```

Integration tests run against a real Fastify + Socket.IO server bound to
an ephemeral port, with in-memory implementations of the persistence
layer (`tests/helpers/inMemoryStores.ts`) so no Supabase is required.

## Deploying to Railway

The Dockerfile expects the build context to be the **parent** directory
(`C:\Work\claude\`) so the sibling `poker-engine` folder is included.

1. Push the parent folder to GitHub (both `poker-engine` and
   `poker-server` together; the PWA can live in the same monorepo or a
   separate repo).
2. Create a new Railway project, link the repo.
3. Set the build context to the repo root and the Dockerfile path to
   `poker-server/Dockerfile` (or use the included `railway.json`).
4. Set env vars in Railway: `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `ALLOWED_ORIGINS`
   (your prod frontend URL), and optionally `LOG_LEVEL`.
5. Railway autodetects the Dockerfile and deploys. Health checks hit
   `/health`.

The server binds to `0.0.0.0:$PORT`, so it works in any container
platform that injects `PORT`.

## Architecture

```
src/
├── index.ts                # bootstrap; dotenv (dev only); SIGTERM/SIGINT
├── server.ts               # Fastify + Socket.IO; /health; wires handlers
├── config.ts               # zod env-var schema
├── logging.ts              # pino + hole-card redaction
├── auth/
│   ├── jwtVerifier.ts      # jose.jwtVerify(HS256) against SUPABASE_JWT_SECRET
│   └── socketAuth.ts       # io.use() middleware; joins user:<id> room
├── connection/
│   ├── ConnectionManager.ts# multi-tab tracking; away/online callbacks
│   └── rooms.ts            # user:<id> / session:<id> helpers
├── persistence/
│   ├── supabaseAdmin.ts    # service-role client
│   ├── lounges.ts          # ILoungeStore + Supabase impl
│   ├── sessions.ts         # ISessionStore + Supabase impl
│   └── handWriter.ts       # IHandWriter + Supabase impl
├── protocol/
│   ├── types.ts            # all event payload types
│   └── schemas.ts          # zod schemas for every C→S event
├── session/
│   ├── SessionManager.ts   # lounge → SessionRuntime map
│   ├── SessionRuntime.ts   # owns PokerTable + turn timer
│   ├── stateFiltering.ts   # the only place engine events emit to sockets
│   └── handAnalysis.ts     # event-log → HandSummary + per-player results
├── handlers/
│   ├── sessionHandlers.ts  # session:* events
│   ├── handHandlers.ts     # hand:* events (with rate limit)
│   ├── errors.ts           # engine → wire error code mapping
│   └── rateLimit.ts        # token bucket for hand:action
└── demo/
    └── cliClient.ts        # interactive Socket.IO client
scripts/
└── mintTestJwt.ts          # local helper: sign a Supabase-shape JWT
```

### State-filtering rules (critical)

Hole cards must never leak. All event broadcasts go through
`stateFiltering.broadcastEvents`:

- `hole_cards_dealt` → `user:<recipientId>` only.
- Everything else → `session:<sessionId>` (the `showdown` event publicly
  reveals only the cards of players who reached showdown).
- The initial `session:state` snapshot uses `table.getPlayerView(userId)`
  + `table.getHandHistoryForPlayer(userId)`, which redact opponents'
  hole cards via engine-built helpers.

### Auth

JWT is verified locally per connection via `jose.jwtVerify` against
`SUPABASE_JWT_SECRET`. `userId` is always the `sub` claim; never trust
client-supplied user IDs.

### Persistence

Best-effort, fire-and-forget. Hand writes do not block the in-memory
game; failures log loudly. Future Phase 4 work: retry queue.

## What's NOT in this phase

- SvelteKit table UI → Phase 3b
- Tournaments, chat, snapshots/crash recovery, persistence retry queue,
  Prometheus metrics → later phases
