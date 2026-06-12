/**
 * Hyperlane Mailbox targets — the EVM chains supported by l0-bridge.
 * Mailbox addresses sourced from @hyperlane-xyz/registry chainAddresses;
 * RPC lists are shared with the LayerZero targets (same chains).
 */
import { TIER_A_CHAINS } from './chains.js'

export interface HyperlaneTarget {
  chainId: number
  chainKey: string
  mailbox: string
  rpcUrls: string[]
}

const MAILBOXES: Record<number, string> = {
  1: '0xc005dc82818d67AF737725bD4bf75435d065D239',     // ethereum
  56: '0x2971b9Aec44bE4eb673DF1B88cDB57b96eefe8a4',    // bsc
  137: '0x5d934f4e2f797775e53561bB72aca21ba36B96BB',   // polygon
  43114: '0xFf06aFcaABaDDd1fb08371f9ccA15D73D51FeBD6', // avalanche
  42161: '0x979Ca5202784112f4738403dBec5D0F3B9daabB9', // arbitrum
  10: '0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D',    // optimism
  8453: '0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D',  // base
  42220: '0x50da3B3907A08a24fe4999F4Dcf337E8dC7954bb', // celo
  1284: '0x094d03E751f49908080EFf000Dd6FD177fd44CC3',  // moonbeam
}

export const HYPERLANE_TARGETS: HyperlaneTarget[] = Object.entries(MAILBOXES).flatMap(
  ([chainIdStr, mailbox]) => {
    const chainId = Number(chainIdStr)
    const lzTwin = TIER_A_CHAINS.find((c) => c.chainId === chainId)
    if (!lzTwin) return []
    return [{ chainId, chainKey: lzTwin.chainKey, mailbox, rpcUrls: lzTwin.rpcUrls }]
  },
)
