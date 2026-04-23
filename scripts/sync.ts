#!/usr/bin/env tsx
/**
 * Incremental cron — for each Tier A chain:
 *   1. Read the Redis blob `oapp-index:{eid}` (created on first run if absent).
 *   2. Scan `EndpointV2.PacketSent` from `meta.lastSyncedBlock + 1` (or
 *      `latest - INITIAL_LOOKBACK` if there's no prior state) up to the
 *      current chain head, capped by MAX_BLOCKS_PER_RUN and a wall-clock
 *      budget per chain so one slow chain can't starve the others.
 *   3. Multicall `token()` on every new sender, classify as adapter /
 *      native OFT / unknown.
 *   4. Merge into the blob, bump `lastSyncedBlock`, write back.
 *
 * Designed for GitHub Actions (no function timeout) but trivially runnable
 * anywhere with `npx tsx scripts/sync.ts`. The runtime reader in the main
 * l0-bridge repo (`oappIndex.ts`) overlays this Redis blob on top of its
 * bundled JSON snapshots.
 *
 * Required env:
 *   KV_REST_API_REDIS_URL — same Upstash instance as the main app
 */

import { ethers } from 'ethers'
import { createClient } from 'redis'
import { TIER_A_CHAINS, type ChainTarget } from './lib/chains.js'
import {
  scanPacketSentRange,
  classifyOAppsByTokenCall,
  mergeClassifiedOApps,
  emptyIndexFile,
  type OAppIndexFile,
} from './lib/scanner.js'

const REDIS_KEY_PREFIX = 'oapp-index:'
const MAX_BLOCKS_PER_RUN = 200_000
const MAX_SECONDS_PER_CHAIN = 60
const INITIAL_LOOKBACK_BLOCKS = 5_000
const RPC_PROBE_TIMEOUT_MS = 8_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function makeProvider(target: ChainTarget): Promise<ethers.JsonRpcProvider | null> {
  const network = new ethers.Network(target.chainKey, target.chainId)
  for (const url of target.rpcUrls) {
    try {
      const request = new ethers.FetchRequest(url)
      request.timeout = 5_000
      const provider = new ethers.JsonRpcProvider(request, network, { staticNetwork: network })
      const latest = await withTimeout(provider.getBlockNumber(), RPC_PROBE_TIMEOUT_MS, `getBlockNumber ${url}`)
      if (Number.isFinite(latest) && latest > 0) return provider
    } catch {
      // try next RPC
    }
  }
  return null
}

interface RedisLike {
  get: (k: string) => Promise<string | null>
  set: (k: string, v: string) => Promise<unknown>
  quit: () => Promise<unknown>
}

async function connectRedis(): Promise<RedisLike> {
  const url = process.env.KV_REST_API_REDIS_URL
  if (!url) throw new Error('KV_REST_API_REDIS_URL not set')
  const client = createClient({ url })
  client.on('error', (err) => console.error('redis error:', err.message))
  await client.connect()
  return client as unknown as RedisLike
}

async function readBlob(redis: RedisLike, eid: number): Promise<OAppIndexFile | null> {
  const raw = await redis.get(`${REDIS_KEY_PREFIX}${eid}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAppIndexFile
  } catch {
    return null
  }
}

async function writeBlob(redis: RedisLike, file: OAppIndexFile): Promise<void> {
  await redis.set(`${REDIS_KEY_PREFIX}${file.meta.eid}`, JSON.stringify(file))
}

interface SyncResult {
  eid: number
  chainKey: string
  status: 'synced' | 'noop' | 'error'
  message?: string
  fromBlock?: number
  toBlock?: number
  newSenders?: number
  adaptersAdded?: number
  natives?: number
  seconds?: number
}

async function syncOne(redis: RedisLike, target: ChainTarget): Promise<SyncResult> {
  const t0 = Date.now()
  const provider = await makeProvider(target)
  if (!provider) {
    return {
      eid: target.eid,
      chainKey: target.chainKey,
      status: 'error',
      message: `no RPC responded (tried ${target.rpcUrls.length})`,
    }
  }

  const latest = await withTimeout(provider.getBlockNumber(), RPC_PROBE_TIMEOUT_MS, 'getBlockNumber latest')
  const existing =
    (await readBlob(redis, target.eid)) ??
    emptyIndexFile(target.eid, target.chainId, target.chainKey, target.endpointV2)

  const lastSynced = existing.meta.lastSyncedBlock || Math.max(0, latest - INITIAL_LOOKBACK_BLOCKS)
  const fromBlock = lastSynced + 1
  if (fromBlock > latest) {
    return { eid: target.eid, chainKey: target.chainKey, status: 'noop' }
  }
  const toBlock = Math.min(latest, fromBlock + MAX_BLOCKS_PER_RUN - 1)

  const scan = await scanPacketSentRange(provider, {
    endpoint: target.endpointV2,
    fromBlock,
    toBlock,
    maxSeconds: MAX_SECONDS_PER_CHAIN,
  })

  // Filter senders against what's already in the blob.
  const knownAdapters = new Set(Object.values(existing.adapters).map((a) => a.toLowerCase()))
  const knownNative = new Set(existing.nativeOfts.map((a) => a.toLowerCase()))
  const knownUnknown = new Set(existing.unknownOApps.map((a) => a.toLowerCase()))
  const newSenders = [...scan.senders].filter(
    (s) => !knownAdapters.has(s) && !knownNative.has(s) && !knownUnknown.has(s),
  )

  let next: OAppIndexFile = existing
  let adaptersAdded = 0
  let natives = 0
  if (newSenders.length > 0) {
    const classified = await classifyOAppsByTokenCall(provider, newSenders, { chunkSize: 150 })
    const beforeAdapters = Object.keys(existing.adapters).length
    next = mergeClassifiedOApps(existing, classified)
    adaptersAdded = Object.keys(next.adapters).length - beforeAdapters
    natives = classified.filter((c) => c.classification === 'native').length
  }

  next.meta = {
    ...next.meta,
    chainId: target.chainId,
    chainKey: target.chainKey,
    endpointV2: target.endpointV2,
    syncedAt: new Date().toISOString(),
    lastSyncedBlock: scan.highestScannedBlock,
    firstScannedBlock: existing.meta.firstScannedBlock || scan.lowestScannedBlock,
  }
  await writeBlob(redis, next)

  return {
    eid: target.eid,
    chainKey: target.chainKey,
    status: 'synced',
    fromBlock,
    toBlock: scan.highestScannedBlock,
    newSenders: newSenders.length,
    adaptersAdded,
    natives,
    seconds: (Date.now() - t0) / 1000,
  }
}

async function main(): Promise<void> {
  const eidFilter = process.env.EID ? Number(process.env.EID) : null
  const targets = eidFilter ? TIER_A_CHAINS.filter((c) => c.eid === eidFilter) : TIER_A_CHAINS

  console.log(`syncing ${targets.length} chain(s)`)
  const redis = await connectRedis()

  const results: SyncResult[] = []
  for (const target of targets) {
    console.log(`\n[${target.chainKey} eid=${target.eid}]`)
    try {
      const r = await syncOne(redis, target)
      results.push(r)
      if (r.status === 'synced') {
        console.log(
          `  OK fromBlock=${r.fromBlock} toBlock=${r.toBlock} newSenders=${r.newSenders} adaptersAdded=${r.adaptersAdded} ${r.seconds?.toFixed(1)}s`,
        )
      } else {
        console.log(`  ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  EXCEPTION ${message.slice(0, 200)}`)
      results.push({ eid: target.eid, chainKey: target.chainKey, status: 'error', message })
    }
  }

  await redis.quit()

  console.log('\n========== summary ==========')
  const synced = results.filter((r) => r.status === 'synced').length
  const noop = results.filter((r) => r.status === 'noop').length
  const errors = results.filter((r) => r.status === 'error').length
  const adaptersAdded = results.reduce((s, r) => s + (r.adaptersAdded ?? 0), 0)
  console.log(`synced=${synced} noop=${noop} errors=${errors} adaptersAdded=${adaptersAdded}`)

  if (errors > 0) {
    console.log('\nerrors:')
    for (const r of results.filter((r) => r.status === 'error')) {
      console.log(`  ${r.chainKey} (${r.eid}): ${r.message}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
