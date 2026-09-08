# Staging backend

- Site: https://telepathy-frontend-staging.up.railway.app
- WebSocket endpoint: wss://ws-backend-staging.up.railway.app
- Health check: https://ws-backend-staging.up.railway.app/health
- Railway project: `2ed4b062-8163-4799-91e1-c877d7287f27`
- Staging environment: `ca0eaa0a-f680-405a-ba6f-a376d875e46b`
- Backend service: `c907b055-3dba-4605-b8d4-38fda4b4c852`

Commit and push changes to `staging`. Frontend changes belong on `telepathy-frontend`'s `staging` branch. From this repository's clean staging checkout, deploy explicitly:

```sh
git push origin staging
npx --yes @railway/cli@5.49.6 up --project 2ed4b062-8163-4799-91e1-c877d7287f27 --environment ca0eaa0a-f680-405a-ba6f-a376d875e46b --service c907b055-3dba-4605-b8d4-38fda4b4c852 --ci
```

Wait for both deployments before testing protocol changes. Pushes do not automatically deploy: no staging GitHub triggers are configured, and the current CLI login cannot create a staging project token for CI. Enable GitHub integration or staging-scoped CI credentials before adding an automatic deployment workflow.

Railway's staging service settings use `npm start`, health check `/health` (60-second timeout), and one replica in `us-west2`. The WebSocket server binds to `0.0.0.0` on Railway's `PORT`. The frontend's build-time `NEXT_PUBLIC_WEBSOCKET_URL` references this staging backend.

Rooms and scores are in memory, isolated from production. A restart or redeployment resets games. Do not scale beyond one replica without adding shared room state and coordinating socket routing.

Run the live multiplayer smoke test from this repository:

```sh
npm ci
node scripts/smoke.mjs wss://ws-backend-staging.up.railway.app
```

The test uses unique disposable rooms, checks HTTP health, pairs two independent WebSocket clients, verifies separate-room isolation, plays ten rounds in all five modes, checks correct and incorrect scoring, and completes rematches with swapped roles. It requires an explicit URL and never defaults to production.

## Custom Cards

Each room owns one shared deck. Players independently open the editor; `DECK_GET` / `DECK_STATE` synchronize its current state without changing their screens. `DECK_ADD`, `DECK_UPDATE`, and `DECK_REMOVE` apply atomic operations and return request acknowledgements. Card IDs and versions prevent lost edits. Drafts show typing live and reserve a card while it is being edited. Draft attribution uses public actor IDs separate from private reconnect credentials.

Cards contain 1–120 characters, with whitespace normalized and case-insensitive duplicates skipped. Decks hold at most 40 cards and require at least 20 to start. Paste batches are validated before any change is applied. Starting Custom Cards snapshots the saved deck; editing is locked during play. Each game has ten rounds and four options. Rematches retain the snapshot; choosing Custom Cards again uses the latest edited deck.

Disconnected drafts are cleared; saved room decks remain in memory for 30 minutes after everyone disconnects. They are not durable across deployments. Players can copy their deck to Notes and paste it back later.

Run `npm test` for isolated server integration tests covering concurrent edits, limits, room access, reconnects, game start, scoring, and rematches.
