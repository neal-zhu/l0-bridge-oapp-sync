/**
 * Hyperlane-specific scanning primitives — Mailbox Dispatch sender
 * extraction and Warp Route classification. Kept in sync with the private
 * repo's `api/_lib/hyperlane/dispatchIndex.ts` (same index file format).
 */
import { ethers, Contract } from 'ethers'

export const DISPATCH_TOPIC = ethers.id('Dispatch(address,uint32,bytes32,bytes)')

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL3_ABI = [
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
]
const ROUTER_PROBE_ABI = [
  'function wrappedToken() view returns (address)',
  'function token() view returns (address)',
]

/** Dispatch sender is indexed — topics[1] is the zero-padded address. */
export function extractSenderFromDispatch(log: { topics: readonly string[] }): string | null {
  const topic = log.topics[1]
  if (!topic || topic.length !== 66) return null
  return ('0x' + topic.slice(26)).toLowerCase()
}

export interface HyperlaneIndexFile {
  meta: {
    chainId: number
    mailbox: string
    lastScannedBlock: number
    updatedAt: string
  }
  /** underlyingLower -> routerLower */
  routers: Record<string, string>
  /** Senders probed and found to not be collateral routers (skip next time). */
  nonRouters: string[]
}

export function emptyHyperlaneIndexFile(chainId: number, mailbox: string): HyperlaneIndexFile {
  return {
    meta: { chainId, mailbox, lastScannedBlock: 0, updatedAt: new Date(0).toISOString() },
    routers: {},
    nonRouters: [],
  }
}

function decodeAddressResult(
  result: { success?: boolean; returnData?: string; 0?: boolean; 1?: string } | undefined,
): string | null {
  if (!result) return null
  const success = Boolean(result.success ?? result[0])
  const data = result.returnData ?? result[1] ?? '0x'
  if (!success || data.length !== 66) return null
  return ('0x' + data.slice(26)).toLowerCase()
}

/**
 * Classify Dispatch senders: collateral routers expose wrappedToken() (or
 * legacy token()) returning the underlying ERC20. Batched via Multicall3.
 */
export async function classifyWarpRouters(
  provider: ethers.Provider,
  senders: string[],
): Promise<{ routers: Map<string, string>; nonRouters: string[] }> {
  const iface = new ethers.Interface(ROUTER_PROBE_ABI)
  const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider)
  const routers = new Map<string, string>()
  const nonRouters: string[] = []
  const CHUNK = 120

  for (let i = 0; i < senders.length; i += CHUNK) {
    const chunk = senders.slice(i, i + CHUNK)
    const calls = chunk.flatMap((target) => [
      { target, callData: iface.encodeFunctionData('wrappedToken') },
      { target, callData: iface.encodeFunctionData('token') },
    ])

    let results: Array<{ success?: boolean; returnData?: string; 0?: boolean; 1?: string }>
    try {
      results = await multicall.tryAggregate(false, calls)
    } catch {
      // Leave the chunk unclassified — it will be retried on a later run.
      continue
    }

    for (let j = 0; j < chunk.length; j++) {
      const underlying =
        decodeAddressResult(results[j * 2]) ?? decodeAddressResult(results[j * 2 + 1])
      if (underlying && underlying !== ethers.ZeroAddress.toLowerCase()) {
        routers.set(underlying, chunk[j].toLowerCase())
      } else {
        nonRouters.push(chunk[j].toLowerCase())
      }
    }
  }

  return { routers, nonRouters }
}
