#!/usr/bin/env tsx
/**
 * Incremental Hyperlane Warp Route sync — for each supported chain:
 *   1. Read the Redis blob `hl-index:{chainId}` (created on first run).
 *   2. Scan Mailbox `Dispatch` from `meta.lastScannedBlock + 1` (or
 *      `latest - INITIAL_LOOKBACK` when there's no prior state) up to the
 *      chain head, capped per run.
 *   3. Probe every new sender with wrappedToken()/token() via Multicall —
 *      collateral Warp Routers reveal their underlying ERC20.
 *   4. Merge underlying→router pairs into the blob and write back.
 *
 * The private repo's `api/_lib/hyperlane/dispatchIndex.ts` overlays this
 * blob on its bundled snapshots, so a route becomes resolvable by its
 * underlying token within one cron tick of its FIRST transfer — no
 * hyperlane-registry involvement.
 *
 * Required env: KV_REST_API_REDIS_URL (same Upstash instance as the app)
 */
import { ethers } from 'ethers'
import { createClient } from 'redis'
import { HYPERLANE_TARGETS, type HyperlaneTarget } from './lib/hyperlaneChains.js'
import { scanPacketSentRange } from './lib/scanner.js'
import {
  DISPATCH_TOPIC,
  extractSenderFromDispatch,
  classifyWarpRouters,
  emptyHyperlaneIndexFile,
  type HyperlaneIndexFile,
} from './lib/hyperlaneScanner.js'

const REDIS_KEY_PREFIX = 'hl-index:'
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

async function makeProvider(target: HyperlaneTarget): Promise<ethers.JsonRpcProvider | null> {
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

interface SyncResult {
  chainId: number
  chainKey: string
  status: 'synced' | 'noop' | 'error'
  message?: string
  newSenders?: number
  routersAdded?: number
  seconds?: number
}

async function syncOne(redis: RedisLike, target: HyperlaneTarget): Promise<SyncResult> {
  const t0 = Date.now()
  const provider = await makeProvider(target)
  if (!provider) {
    return {
      chainId: target.chainId,
      chainKey: target.chainKey,
      status: 'error',
      message: `no RPC responded (tried ${target.rpcUrls.length})`,
    }
  }

  const latest = await withTimeout(provider.getBlockNumber(), RPC_PROBE_TIMEOUT_MS, 'getBlockNumber latest')
  const raw = await redis.get(`${REDIS_KEY_PREFIX}${target.chainId}`)
  let existing: HyperlaneIndexFile
  try {
    existing = raw ? (JSON.parse(raw) as HyperlaneIndexFile) : emptyHyperlaneIndexFile(target.chainId, target.mailbox)
  } catch {
    existing = emptyHyperlaneIndexFile(target.chainId, target.mailbox)
  }

  const lastScanned = existing.meta.lastScannedBlock || Math.max(0, latest - INITIAL_LOOKBACK_BLOCKS)
  const fromBlock = lastScanned + 1
  if (fromBlock > latest) {
    return { chainId: target.chainId, chainKey: target.chainKey, status: 'noop' }
  }
  const toBlock = Math.min(latest, fromBlock + MAX_BLOCKS_PER_RUN - 1)

  const scan = await scanPacketSentRange(provider, {
    endpoint: target.mailbox,
    fromBlock,
    toBlock,
    maxSeconds: MAX_SECONDS_PER_CHAIN,
    topic: DISPATCH_TOPIC,
    extractSender: extractSenderFromDispatch,
  })

  const knownRouters = new Set(Object.values(existing.routers))
  const knownNon = new Set(existing.nonRouters)
  const newSenders = [...scan.senders].filter((s) => !knownRouters.has(s) && !knownNon.has(s))

  let routersAdded = 0
  if (newSenders.length > 0) {
    const { routers, nonRouters } = await classifyWarpRouters(provider, newSenders)
    routersAdded = routers.size
    existing = {
      ...existing,
      routers: { ...existing.routers, ...Object.fromEntries(routers) },
      nonRouters: [...new Set([...existing.nonRouters, ...nonRouters])],
    }
  }

  existing.meta = {
    chainId: target.chainId,
    mailbox: target.mailbox,
    lastScannedBlock: scan.highestScannedBlock,
    updatedAt: new Date().toISOString(),
  }
  await redis.set(`${REDIS_KEY_PREFIX}${target.chainId}`, JSON.stringify(existing))

  return {
    chainId: target.chainId,
    chainKey: target.chainKey,
    status: 'synced',
    newSenders: newSenders.length,
    routersAdded,
    seconds: (Date.now() - t0) / 1000,
  }
}

async function main(): Promise<void> {
  const chainFilter = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : null
  const targets = chainFilter
    ? HYPERLANE_TARGETS.filter((c) => c.chainId === chainFilter)
    : HYPERLANE_TARGETS

  console.log(`hyperlane: syncing ${targets.length} chain(s)`)
  // DRY_RUN=1: in-memory store for local verification without Redis.
  const memory = new Map<string, string>()
  const redis: RedisLike = process.env.DRY_RUN
    ? {
        get: async (k) => memory.get(k) ?? null,
        set: async (k, v) => { memory.set(k, v) },
        quit: async () => {},
      }
    : await connectRedis()

  const results: SyncResult[] = []
  for (const target of targets) {
    console.log(`\n[${target.chainKey} chainId=${target.chainId}]`)
    try {
      const r = await syncOne(redis, target)
      results.push(r)
      console.log(
        r.status === 'synced'
          ? `  OK newSenders=${r.newSenders} routersAdded=${r.routersAdded} ${r.seconds?.toFixed(1)}s`
          : `  ${r.status}${r.message ? ` — ${r.message}` : ''}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  EXCEPTION ${message.slice(0, 200)}`)
      results.push({ chainId: target.chainId, chainKey: target.chainKey, status: 'error', message })
    }
  }

  await redis.quit()

  if (process.env.DRY_RUN) {
    for (const [k, v] of memory) {
      const file = JSON.parse(v)
      console.log(`DRY ${k}: routers=${Object.keys(file.routers).length} lastBlock=${file.meta.lastScannedBlock}`)
      const sample = Object.entries(file.routers).slice(0, 3)
      for (const [u, r] of sample) console.log(`  ${u} -> ${r}`)
    }
  }

  const synced = results.filter((r) => r.status === 'synced').length
  const errors = results.filter((r) => r.status === 'error').length
  const routersAdded = results.reduce((s, r) => s + (r.routersAdded ?? 0), 0)
  console.log(`\nhyperlane summary: synced=${synced} errors=${errors} routersAdded=${routersAdded}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
