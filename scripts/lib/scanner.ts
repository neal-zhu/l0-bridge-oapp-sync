import { ethers } from 'ethers'

/**
 * topic0 for `PacketSent(bytes,bytes,address)` on LayerZero V2 EndpointV2.
 * Every OFT / adapter / generic OApp that sends a cross-chain message
 * triggers this event on the chain's endpoint contract.
 */
export const PACKET_SENT_TOPIC =
  '0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f'

/** Multicall3 deterministic deploy address (same on every supported EVM chain). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

const MULTICALL_ABI = [
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
]
const OFT_TOKEN_ABI = ['function token() view returns (address)']
const ZERO_BYTES32 = '0x' + '00'.repeat(32) // unused but kept for symmetry

/**
 * Decode the OApp (sender) address from a PacketSent log payload.
 *
 * LayerZero V2 PacketV1 layout:
 *   version(1) | nonce(8) | srcEid(4) | sender(32) | dstEid(4) | receiver(32) | guid(32) | message(...)
 * Sender bytes32 starts at byte offset 13. Take the last 20 bytes for the EVM address.
 */
export function extractSenderFromPacketSent(log: { data: string }): string | null {
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['bytes', 'bytes', 'address'],
      log.data,
    )
    const encodedPayload: string = decoded[0]
    const hex = encodedPayload.startsWith('0x') ? encodedPayload.slice(2) : encodedPayload
    if (hex.length < 45 * 2) return null
    const senderBytes32 = hex.slice(13 * 2, 45 * 2)
    return ethers.getAddress('0x' + senderBytes32.slice(24)).toLowerCase()
  } catch {
    return null
  }
}

function isBlockRangeError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('block range') ||
    m.includes('too large') ||
    m.includes('too many') ||
    m.includes('response size') ||
    m.includes('maximum block range') ||
    m.includes('limit exceeded') ||
    m.includes('query returned')
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export interface ScanRangeOptions {
  endpoint: string
  fromBlock: number
  toBlock: number
  initialWindow?: number
  minWindow?: number
  maxWindow?: number
  maxSeconds?: number
  perCallTimeoutMs?: number
  onProgress?: (line: string) => void
}

export interface ScanRangeResult {
  senders: Set<string>
  totalLogs: number
  highestScannedBlock: number
  lowestScannedBlock: number
  timedOut: boolean
  attempts: number
  errors: number
}

/**
 * Scan EndpointV2.PacketSent logs in a block range (newest-first) with
 * adaptive window sizing. Survives public-RPC throttling by shrinking the
 * window on errors, learning the RPC's max range cap from error messages,
 * and aborting cleanly when even the minimum window keeps failing.
 */
export async function scanPacketSentRange(
  provider: ethers.Provider,
  opts: ScanRangeOptions,
): Promise<ScanRangeResult> {
  const endpoint = opts.endpoint
  const fromBlock = opts.fromBlock
  const toBlock = opts.toBlock
  const minWindow = opts.minWindow ?? 500
  const maxWindow = opts.maxWindow ?? 500_000
  const maxSeconds = opts.maxSeconds ?? 60
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 7_000
  const onProgress = opts.onProgress ?? (() => {})

  let windowSize = Math.min(Math.max(opts.initialWindow ?? 40_000, minWindow), maxWindow)
  let learnedMaxWindow = maxWindow
  const senders = new Set<string>()
  let totalLogs = 0
  let cursorEnd = toBlock
  let attempts = 0
  let errors = 0
  let consecutiveErrorsAtMinWindow = 0
  const abortAfterMinWindowErrors = 4
  const t0 = Date.now()

  while (cursorEnd >= fromBlock && (Date.now() - t0) / 1000 < maxSeconds) {
    attempts++
    const from = Math.max(fromBlock, cursorEnd - windowSize + 1)
    try {
      const logs = await withTimeout(
        provider.getLogs({
          address: endpoint,
          topics: [PACKET_SENT_TOPIC],
          fromBlock: from,
          toBlock: cursorEnd,
        }),
        perCallTimeoutMs,
        `getLogs ${from}..${cursorEnd}`,
      )
      totalLogs += logs.length
      for (const l of logs) {
        const s = extractSenderFromPacketSent(l)
        if (s) senders.add(s)
      }
      onProgress(
        `[${attempts}] ${from}..${cursorEnd} (w=${windowSize}) +${logs.length} logs, total=${totalLogs}, unique=${senders.size}`,
      )
      consecutiveErrorsAtMinWindow = 0
      if (logs.length === 0) {
        windowSize = Math.min(windowSize * 2, learnedMaxWindow)
      } else if (logs.length < 500) {
        windowSize = Math.min(Math.floor(windowSize * 1.2), learnedMaxWindow)
      } else if (logs.length > 5_000) {
        windowSize = Math.max(minWindow, Math.floor(windowSize / 2))
      }
      cursorEnd = from - 1
      if (from === fromBlock) break
    } catch (err) {
      errors++
      const msg = err instanceof Error ? err.message : String(err)
      onProgress(`[${attempts}] ${from}..${cursorEnd} ERR: ${msg.slice(0, 100).replace(/\n/g, ' ')}`)

      if (windowSize <= minWindow) {
        consecutiveErrorsAtMinWindow++
        if (consecutiveErrorsAtMinWindow >= abortAfterMinWindowErrors) {
          onProgress(`ABORT: ${abortAfterMinWindowErrors} errors at minWindow=${minWindow}`)
          break
        }
      }

      if (
        isBlockRangeError(msg) ||
        msg.includes('-32701') ||
        msg.includes('-32600') ||
        msg.includes('-32005') ||
        msg.includes('-32001')
      ) {
        const capMatch = msg.match(/(?:maximum(?: allowed)?(?: block range)?(?: range)?:?\s*)(\d+)/i)
        if (capMatch) {
          const cap = Number(capMatch[1])
          if (Number.isFinite(cap) && cap > 0) {
            learnedMaxWindow = Math.min(learnedMaxWindow, cap)
          }
        } else {
          learnedMaxWindow = Math.min(learnedMaxWindow, Math.max(minWindow, Math.floor(windowSize / 2)))
        }
        windowSize = Math.max(minWindow, Math.min(learnedMaxWindow, Math.floor(windowSize / 3)))
      } else {
        windowSize = Math.max(minWindow, Math.floor(windowSize / 2))
      }
      await sleep(400)
    }
    await sleep(30)
  }

  const timedOut = cursorEnd >= fromBlock
  return {
    senders,
    totalLogs,
    highestScannedBlock: toBlock,
    lowestScannedBlock: timedOut ? cursorEnd + 1 : fromBlock,
    timedOut,
    attempts,
    errors,
  }
}

export type OAppClassification = 'native' | 'adapter' | 'unknown'

export interface ClassifiedOApp {
  oapp: string
  classification: OAppClassification
  underlying?: string
}

/**
 * Classify OApp candidates by calling `token()` on each.
 *   - returns self  -> native OFT
 *   - returns other -> adapter wrapping that ERC20
 *   - reverts       -> generic LZ messaging app, not an OFT
 *
 * Uses Multicall3 for batching, falls back to individual calls when
 * multicall isn't deployed on a chain.
 */
export async function classifyOAppsByTokenCall(
  provider: ethers.Provider,
  oapps: string[],
  opts: { chunkSize?: number; perCallTimeoutMs?: number } = {},
): Promise<ClassifiedOApp[]> {
  const chunkSize = opts.chunkSize ?? 150
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 10_000
  const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL_ABI, provider)
  const iface = new ethers.Interface(OFT_TOKEN_ABI)

  let multicallAvailable = true
  try {
    const code = await withTimeout(
      provider.getCode(MULTICALL3_ADDRESS),
      perCallTimeoutMs,
      'getCode multicall',
    )
    multicallAvailable = code !== '0x'
  } catch {
    multicallAvailable = false
  }

  const out: ClassifiedOApp[] = []

  for (let i = 0; i < oapps.length; i += chunkSize) {
    const chunk = oapps.slice(i, i + chunkSize)
    let classified = false

    if (multicallAvailable) {
      try {
        const calls = chunk.map((t) => ({
          target: t,
          callData: iface.encodeFunctionData('token'),
        }))
        const results: { success: boolean; returnData: string }[] = await withTimeout(
          multicall.tryAggregate(false, calls) as Promise<any>,
          perCallTimeoutMs,
          `multicall token() chunk[${i}]`,
        )
        for (let j = 0; j < chunk.length; j++) {
          out.push(decodeTokenResult(chunk[j], results[j]?.success, results[j]?.returnData, iface))
        }
        classified = true
      } catch {
        // fall through to per-address fallback
      }
    }

    if (!classified) {
      for (const addr of chunk) {
        const c = new ethers.Contract(addr, OFT_TOKEN_ABI, provider)
        try {
          const token = ((await withTimeout(c.token(), perCallTimeoutMs, `token() ${addr}`)) as string).toLowerCase()
          if (token === addr.toLowerCase()) {
            out.push({ oapp: addr, classification: 'native' })
          } else {
            out.push({ oapp: addr, classification: 'adapter', underlying: token })
          }
        } catch {
          out.push({ oapp: addr, classification: 'unknown' })
        }
      }
    }

    await sleep(30)
  }

  return out
}

function decodeTokenResult(
  oapp: string,
  success: boolean | undefined,
  returnData: string | undefined,
  iface: ethers.Interface,
): ClassifiedOApp {
  if (!success || !returnData || returnData === '0x') {
    return { oapp, classification: 'unknown' }
  }
  try {
    const token = (iface.decodeFunctionResult('token', returnData)[0] as string).toLowerCase()
    if (token === oapp.toLowerCase()) {
      return { oapp, classification: 'native' }
    }
    return { oapp, classification: 'adapter', underlying: token }
  } catch {
    return { oapp, classification: 'unknown' }
  }
}

export interface OAppIndexFile {
  meta: {
    eid: number
    chainId: number
    chainKey: string
    endpointV2: string
    syncedAt: string
    lastSyncedBlock: number
    firstScannedBlock: number
  }
  /** `underlying_lower -> adapter_lower` */
  adapters: Record<string, string>
  nativeOfts: string[]
  unknownOApps: string[]
}

/** Fold newly classified OApps into an existing index blob. Pure. */
export function mergeClassifiedOApps(
  existing: OAppIndexFile,
  classified: ClassifiedOApp[],
): OAppIndexFile {
  const adapters = { ...existing.adapters }
  const nativeSet = new Set(existing.nativeOfts.map((s) => s.toLowerCase()))
  const unknownSet = new Set(existing.unknownOApps.map((s) => s.toLowerCase()))
  for (const c of classified) {
    const addr = c.oapp.toLowerCase()
    if (c.classification === 'adapter' && c.underlying) {
      adapters[c.underlying.toLowerCase()] = addr
      nativeSet.delete(addr)
      unknownSet.delete(addr)
    } else if (c.classification === 'native') {
      nativeSet.add(addr)
      unknownSet.delete(addr)
    } else {
      if (!nativeSet.has(addr) && !Object.values(adapters).some((v) => v === addr)) {
        unknownSet.add(addr)
      }
    }
  }
  return {
    meta: { ...existing.meta, syncedAt: new Date().toISOString() },
    adapters,
    nativeOfts: [...nativeSet].sort(),
    unknownOApps: [...unknownSet].sort(),
  }
}

export function emptyIndexFile(
  eid: number,
  chainId: number,
  chainKey: string,
  endpointV2: string,
): OAppIndexFile {
  return {
    meta: {
      eid,
      chainId,
      chainKey,
      endpointV2,
      syncedAt: new Date().toISOString(),
      lastSyncedBlock: 0,
      firstScannedBlock: 0,
    },
    adapters: {},
    nativeOfts: [],
    unknownOApps: [],
  }
}
