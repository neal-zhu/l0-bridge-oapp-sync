# l0-bridge-oapp-sync

GitHub Actions cron that keeps the LayerZero V2 OApp index for [l0-bridge](https://github.com/neal-zhu/layerzero-bridge) fresh.

## What it does

Every 15 minutes, for each Tier A LayerZero V2 EVM mainnet:

1. Read the Redis blob `oapp-index:{eid}` (Upstash, shared with the main app).
2. Scan `EndpointV2.PacketSent` from `meta.lastSyncedBlock + 1` up to chain head, capped to keep one chain from starving the others.
3. Multicall `token()` on every newly-seen sender to classify it as **adapter** (returns a different ERC20), **native OFT** (returns self), or **unknown** (reverts — generic LZ messaging app).
4. Merge into the blob, advance `lastSyncedBlock`, write back to Redis.

The runtime in the main app overlays this Redis blob on top of its bundled JSON snapshots when resolving a user-pasted ERC20 to an OFT adapter.

## Why a separate public repo?

The main `l0-bridge` repo is private; private-repo Actions minutes are capped (2000 / month on the Free plan) and Vercel Hobby cron is daily-only. A public repo gets unlimited Actions minutes, so a per-15-minute cron costs nothing.

## Setup

### One-time

1. **Create the Upstash Redis database** (or use an existing one shared with the main `l0-bridge` deploy on Vercel).
2. **Add the connection URL as a repo secret**:
   - Repo Settings → Secrets and variables → Actions → New repository secret
   - Name: `KV_REST_API_REDIS_URL`
   - Value: the same `KV_REST_API_REDIS_URL` value used in the Vercel environment of the main app.

### Manual run

```bash
npm install
KV_REST_API_REDIS_URL=redis://... npx tsx scripts/sync.ts
```

Filter to a single chain via `EID=30110 npx tsx scripts/sync.ts`.

## Adding a chain

Edit [scripts/lib/chains.ts](scripts/lib/chains.ts) — add an entry with the chain's `eid`, `chainId`, `chainKey`, `endpointV2` address (look up in the [LayerZero deployments metadata](https://metadata.layerzero-api.com/v1/metadata/deployments)) and a curated RPC list. Push; the next cron picks it up.

## Removing the Vercel cron

The main `l0-bridge` repo previously shipped a Vercel cron handler at `api/cron/sync-oapp-index.ts`. Once this workflow is running, that handler can be removed from `vercel.json` (it stays as a manual webhook if useful).

## Monitoring

- Workflow runs: https://github.com/neal-zhu/l0-bridge-oapp-sync/actions
- Each run logs per-chain summary (`OK fromBlock=... newSenders=... adaptersAdded=...`)
- Bad RPCs surface as `EXCEPTION` or `no RPC responded` in the log
