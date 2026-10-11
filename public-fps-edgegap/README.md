# Tactical FPS — public multiplayer starter (Edgegap)

This package preserves the existing Three.js FPS client and adds a starter architecture for public rooms, persistent accounts/progression, and Edgegap-hosted dedicated match servers. It is a deployable scaffold, **not yet a fully integrated multiplayer game**: the current client still runs its original local simulation. The game-server protocol below must be wired into the client's movement, firing, damage, respawn, and HUD code before public matches are real multiplayer.

## Architecture

- `client/index.html`: existing browser game; host as static HTTPS (GitHub Pages, Cloudflare Pages, etc.).
- `coordinator/`: always-on HTTPS API for registration/login, persistent progression, public room browser, and server registration. Host on a normal Node service (Render/Fly/Railway/etc.) and attach managed PostgreSQL.
- `game-server/`: Node WebSocket dedicated-server process. Build the container in cloud CI and deploy it as an Edgegap application version. It registers room metadata with the coordinator.
- PostgreSQL is the source of truth for accounts/progression. Room presence is ephemeral and heartbeat-based.

## Local development (optional)

Requires Node.js 20+ and PostgreSQL. No Docker is required locally.

1. Create a PostgreSQL database and set `DATABASE_URL`.
2. In `coordinator/`, copy `.env.example` to `.env`, set secrets, then run `npm install && npm run dev`.
3. In `game-server/`, copy `.env.example` to `.env`, set `COORDINATOR_URL` and `SERVER_REGISTER_TOKEN`, then run `npm install && npm start`.
4. Test `GET /health` and `GET /api/rooms` on the coordinator.

## Cloud deployment checklist

1. Push this folder to a private/public Git repository.
2. Deploy `coordinator/` as a Node web service. Set `DATABASE_URL`, `JWT_SECRET` (long random secret), `SERVER_REGISTER_TOKEN` (different long random secret), `CORS_ORIGIN` (your client HTTPS origin), and `PORT` if needed. The coordinator's startup creates its tables automatically; for production, use managed migrations/backups and restrict DB access.
3. Deploy managed PostgreSQL and enable backups. Do not store passwords or JWT secrets in source control.
4. In Edgegap, create an application/version using `game-server/Dockerfile`. Configure the game's TCP port (default 8080) in Edgegap's port configuration. Set `COORDINATOR_URL`, `SERVER_REGISTER_TOKEN`, `ROOM_NAME`, `MAP_ID`, and `MAX_PLAYERS=8` as environment variables. The Edgegap deployment's actual address/port fields vary by allocation and protocol; configure and test the client connection endpoint accordingly.
5. Cloud CI workflow `.github/workflows/build-game-server.yml` builds and pushes the game-server image to GHCR. Add GitHub repository Actions secrets `GHCR_TOKEN` (a GitHub token with package write access; `GITHUB_TOKEN` is also available automatically in many repos) if required by your repository policy. Set repository variable `IMAGE_NAME` to `ghcr.io/OWNER/REPOSITORY/fps-game-server` (lowercase). The workflow does not deploy to Edgegap automatically.
6. Configure Edgegap to use the pushed image. Then configure your static host to serve `client/index.html`.
7. Set up an HTTPS/WSS-capable public connection path. Browsers on HTTPS pages generally require secure WebSockets (`wss://`). A raw TCP port on Edgegap is not automatically a WSS endpoint; use a supported TLS gateway/proxy or a browser-compatible transport and verify Edgegap's current networking support.

## API endpoints

- `POST /api/auth/register` `{ username, password }`
- `POST /api/auth/login` `{ username, password }`
- `GET /api/me` with `Authorization: Bearer <token>`
- `GET /api/rooms` public room browser
- `POST /api/progression/xp` authenticated `{ amount }` (starter demo endpoint; replace with server-verified match rewards before production)
- `POST /api/servers/register` server token auth; heartbeat upserts room presence
- `GET /health`

## Security / status

- Passwords are bcrypt-hashed; auth uses signed JWTs; usernames are unique; HTTP request limits and CORS are configured.
- XP endpoint is intentionally a development placeholder: **do not expose it as a trusted reward mechanism**. In production, only a trusted match result signed/verified by the game server should grant XP.
- Room listings are heartbeat-based, not a full Edgegap allocator integration. The current game server must be allocated/launched by Edgegap or another orchestrator; this scaffold does not call Edgegap's management API or create deployments automatically.
- The sample game server only relays basic movement snapshots and does not implement authoritative hit validation, weapons, health, anti-cheat, matchmaking allocation, or account-linked match results yet.
- Do not claim multiplayer is complete until the client is connected to this protocol and tested with multiple remote browsers.
