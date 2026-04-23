/**
 * Tier A LayerZero V2 mainnets — the supported set in l0-bridge.
 * Mirror of `TIER_A_EIDS` in the private repo's batch backfill script.
 *
 * Each chain entry:
 *   eid          — LayerZero V2 endpoint ID
 *   chainId      — EVM chainId
 *   chainKey     — short name (matches LZ metadata key)
 *   endpointV2   — EndpointV2 contract address (per-chain, source: LZ metadata)
 *   rpcUrls      — curated public RPC list, ordered by reliability
 */
export interface ChainTarget {
  eid: number
  chainId: number
  chainKey: string
  endpointV2: string
  rpcUrls: string[]
}

export const TIER_A_CHAINS: ChainTarget[] = [
  {
    eid: 30101, chainId: 1, chainKey: 'ethereum',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://ethereum-rpc.publicnode.com',
      'https://1rpc.io/eth',
      'https://rpc.mevblocker.io',
      'https://rpc.flashbots.net',
      'https://ethereum-public.nodies.app',
    ],
  },
  {
    eid: 30102, chainId: 56, chainKey: 'bsc',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://bsc-dataseed.bnbchain.org',
      'https://bsc-dataseed1.defibit.io',
      'https://bsc-dataseed1.ninicoin.io',
      'https://bsc-dataseed2.defibit.io',
      'https://bsc-dataseed3.defibit.io',
    ],
  },
  {
    eid: 30106, chainId: 43114, chainKey: 'avalanche',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://api.avax.network/ext/bc/C/rpc',
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://avalanche.public-rpc.com',
      'https://1rpc.io/avax/c',
      'https://avax.meowrpc.com',
    ],
  },
  {
    eid: 30109, chainId: 137, chainKey: 'polygon',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://polygon-rpc.com',
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.llamarpc.com',
      'https://1rpc.io/matic',
      'https://polygon.drpc.org',
    ],
  },
  {
    eid: 30110, chainId: 42161, chainKey: 'arbitrum',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.meowrpc.com',
      'https://1rpc.io/arb',
      'https://arbitrum.drpc.org',
    ],
  },
  {
    eid: 30111, chainId: 10, chainKey: 'optimism',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://mainnet.optimism.io',
      'https://1rpc.io/op',
      'https://optimism-public.nodies.app',
      'https://optimism.public.blockpi.network/v1/rpc/public',
      'https://optimism.api.onfinality.io/public',
    ],
  },
  {
    eid: 30181, chainId: 5000, chainKey: 'mantle',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://rpc.mantle.xyz',
      'https://mantle-rpc.publicnode.com',
      'https://mantle.drpc.org',
      'https://1rpc.io/mantle',
      'https://mantle.public-rpc.com',
    ],
  },
  {
    eid: 30183, chainId: 59144, chainKey: 'linea',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://rpc.linea.build',
      'https://linea-rpc.publicnode.com',
      'https://1rpc.io/linea',
      'https://linea.drpc.org',
      'https://linea.decubate.com',
    ],
  },
  {
    eid: 30184, chainId: 8453, chainKey: 'base',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://1rpc.io/base',
      'https://base.meowrpc.com',
      'https://base.drpc.org',
    ],
  },
  {
    eid: 30214, chainId: 534352, chainKey: 'scroll',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://rpc.scroll.io',
      'https://scroll-mainnet-public.unifra.io',
      'https://scroll.drpc.org',
      'https://scroll-rpc.publicnode.com',
      'https://1rpc.io/scroll',
    ],
  },
  {
    eid: 30243, chainId: 81457, chainKey: 'blast',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://rpc.blast.io',
      'https://blast.din.dev/rpc',
      'https://blastl2-mainnet.public.blastapi.io',
      'https://blast.drpc.org',
    ],
  },
  {
    eid: 30255, chainId: 252, chainKey: 'fraxtal',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://rpc.frax.com',
      'https://fraxtal.drpc.org',
    ],
  },
  {
    eid: 30260, chainId: 34443, chainKey: 'mode',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://mainnet.mode.network',
      'https://1rpc.io/mode',
      'https://mode.drpc.org',
    ],
  },
  {
    eid: 30280, chainId: 1329, chainKey: 'sei',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://evm-rpc.sei-apis.com',
      'https://sei.drpc.org',
    ],
  },
  {
    eid: 30290, chainId: 167000, chainKey: 'taiko',
    endpointV2: '0x1a44076050125825900e736c501f859c50fE728c',
    rpcUrls: [
      'https://rpc.mainnet.taiko.xyz',
      'https://rpc.taiko.xyz',
      'https://taiko-rpc.publicnode.com',
      'https://taiko.drpc.org',
    ],
  },
  {
    eid: 30332, chainId: 146, chainKey: 'sonic',
    endpointV2: '0x6F475642a6e85809B1c36Fa62763669b1b48DD5B',
    rpcUrls: [
      'https://rpc.soniclabs.com',
      'https://sonic-rpc.publicnode.com',
      'https://sonic.drpc.org',
    ],
  },
  {
    eid: 30367, chainId: 999, chainKey: 'hyperliquid',
    endpointV2: '0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9',
    rpcUrls: [
      'https://rpc.hyperliquid.xyz/evm',
      'https://hyperliquid.drpc.org',
    ],
  },
]
