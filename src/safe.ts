/**
 * `pantessa/safe` — drive a desk job through a Safe.
 *
 * An institution signs with its custody, not a browser wallet. `safeSigner`
 * is the first custody adapter for `driveJob`: the legs are built for the
 * SAFE's address, and every EVM transaction the runner offers becomes a
 * Safe transaction — hashed exactly as the Safe contract hashes it
 * (`SafeTx` EIP-712 over the domain `{ chainId, verifyingContract: safe }`),
 * signed by an OWNER, proposed to the Safe Transaction Service (so the
 * firm's other owners see it in their own Safe), then executed — by the
 * owner itself once the threshold is met (the default), or by whoever the
 * firm's queue executes with (`executor: false`, and this loop waits for
 * the service to report the execution).
 *
 * ```ts
 * import { driveJob } from 'pantessa/desk'
 * import { safeSigner } from 'pantessa/safe'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const owner = privateKeyToAccount(process.env.OWNER_KEY as `0x${string}`)
 * const signer = safeSigner({ safeAddress: '0xYourSafe', chainId: 8453, owner, rpc: 'https://…' })
 * await driveJob({ base, jobId, token, signer, rpc: { 8453: 'https://…' } })
 * ```
 *
 * What this version refuses BY NAME (`supports(kind)`): a CoW `order` leg
 * (Safe presign — `setPreSignature` on GPv2Settlement — is wave 2) and a
 * Hyperliquid `hlAction` / `hlBatch` (the venue signs agent actions with a
 * key a Safe does not have; unmeasured). It has no `signMessage`: a Safe
 * cannot `personal_sign` the desk's execute consent, so `openAndExecute`
 * with this signer refuses in its own words — open the intent with an owner
 * account and drive the job with the Safe.
 *
 * Light on purpose: `fetch` + viem only. The Safe types are written by hand
 * (`SAFE_TX_TYPES`), no protocol-kit — the SDK's one dependency stays the
 * viem peer. The Safe Transaction Service's own hosts are the table
 * `SAFE_TX_SERVICE`; pass `txServiceUrl` for a self-hosted one.
 */

import type { Account, Address, Chain, Hex, PublicClient, WalletClient } from 'viem'
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, hashTypedData, http } from 'viem'
import { DEFAULT_RPC, DeskError, type DeskCustodySigner, type DeskLegKind, type LegTx, type TypedDataLike } from './desk.js'

/* ── the Safe wire ────────────────────────────────────────────────────── */

/** The Safe Transaction Service, per chain — Safe's own hosts (the legacy
 *  `safe-transaction-<chain>.safe.global` names 308 here). Verified by GET
 *  `/v1/about/` on 2026-11-03. */
export const SAFE_TX_SERVICE: Readonly<Record<number, string>> = Object.freeze({
  1: 'https://api.safe.global/tx-service/eth/api',
  10: 'https://api.safe.global/tx-service/oeth/api',
  8453: 'https://api.safe.global/tx-service/base/api',
  42161: 'https://api.safe.global/tx-service/arb1/api',
  84532: 'https://api.safe.global/tx-service/basesep/api',
})

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/** The `SafeTx` struct, as Safe ≥ 1.3.0 hashes it (`SAFE_TX_TYPEHASH`). */
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/** One Safe transaction, fully specified — what the owners sign. */
export interface SafeTxFields {
  to: Address
  value: bigint
  data: Hex
  /** 0 = CALL. This adapter never delegatecalls. */
  operation: 0
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: Address
  refundReceiver: Address
  nonce: bigint
}

/** The minimal Safe ABI this adapter speaks. */
export const SAFE_ABI = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getTransactionHash',
    stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const

/** The EIP-712 payload an owner signs for one Safe transaction. Pure. The
 *  domain is `{ chainId, verifyingContract }` ONLY — Safe's domain has no
 *  name or version, and viem derives `EIP712Domain` from the fields present. */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTxFields): TypedDataLike {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: { ...tx },
  }
}

/** The `safeTxHash` — what the contract's `getTransactionHash` answers. Pure. */
export function safeTxHash(chainId: number, safe: Address, tx: SafeTxFields): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: tx,
  })
}

/** A leg's transaction as a Safe transaction: CALL, no gas refund, this nonce. Pure. */
export function safeTxOf(tx: LegTx, nonce: bigint): SafeTxFields {
  const value = tx.value === undefined || tx.value === '' ? 0n : BigInt(tx.value)
  return {
    to: tx.to,
    value,
    data: tx.data && tx.data !== '0x' ? tx.data : '0x',
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  }
}

/** Pack owner signatures the way `checkNSignatures` reads them: concatenated,
 *  sorted by owner address ascending, each 65 bytes. Pure. */
export function packSignatures(confirmations: ReadonlyArray<{ owner: string; signature: string }>): Hex {
  const sorted = [...confirmations].sort((a, b) => (a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : a.owner.toLowerCase() > b.owner.toLowerCase() ? 1 : 0))
  return `0x${sorted.map((c) => c.signature.replace(/^0x/, '')).join('')}` as Hex
}

/** The proposal body `POST /v1/safes/{safe}/multisig-transactions/` takes. Pure.
 *  Every address is EIP-55 checksummed — the service refuses a lowercase one
 *  by name ("Address 0x… is not checksumed"; measured 2026-11-03 on a
 *  builder's Permit2 address). */
export function safeProposalBody(
  safe: Address,
  tx: SafeTxFields,
  hash: Hex,
  sender: Address,
  signature: Hex,
  origin?: string,
): Record<string, unknown> {
  return {
    safe: getAddress(safe),
    to: getAddress(tx.to),
    value: tx.value.toString(),
    data: tx.data === '0x' ? null : tx.data,
    operation: tx.operation,
    gasToken: getAddress(tx.gasToken),
    safeTxGas: Number(tx.safeTxGas),
    baseGas: Number(tx.baseGas),
    gasPrice: tx.gasPrice.toString(),
    refundReceiver: getAddress(tx.refundReceiver),
    nonce: Number(tx.nonce),
    contractTransactionHash: hash,
    sender: getAddress(sender),
    signature,
    ...(origin ? { origin } : {}),
  }
}

/* ── the adapter ──────────────────────────────────────────────────────── */

export type SafeEvent =
  | { kind: 'safe'; safe: Address; nonce: number; threshold: number; owners: Address[]; source: 'chain' | 'service' }
  | { kind: 'hash'; safeTxHash: Hex; tx: SafeTxFields }
  | { kind: 'proposed'; safeTxHash: Hex; status: number; url: string }
  | { kind: 'confirmations'; safeTxHash: Hex; have: number; need: number }
  | { kind: 'executed'; safeTxHash: Hex; transactionHash: Hex; by: 'owner' | 'service' }

export interface SafeSignerOptions {
  /** The Safe the legs are built for. */
  safeAddress: Address
  /** The chain the Safe lives on. A leg for another chain is refused by name. */
  chainId: number
  /** An OWNER of the Safe: a viem LocalAccount, or a WalletClient with an
   *  account. It signs every SafeTx hash and, by default, executes. */
  owner: Account | WalletClient
  /** Overrides `SAFE_TX_SERVICE[chainId]` (a self-hosted service). */
  txServiceUrl?: string
  /** An RPC for the Safe's chain. With it the nonce, owners and threshold are
   *  read ON-CHAIN (the truth, and no indexer lag) and the owner can execute;
   *  without it the service answers them and `DEFAULT_RPC` is tried for
   *  execution. Never publicnode. */
  rpc?: string
  /** Who executes once the threshold is met. Default: the owner. `false` =
   *  propose only and wait for the Safe's own executor (the firm's queue, a
   *  relayer) — the service reports the execution and its hash. */
  executor?: Account | WalletClient | false
  /** Poll cadence against the service (default 10s) and the give-up (default 30 min). */
  pollMs?: number
  timeoutMs?: number
  /** `Authorization: Bearer …` for the service, when yours requires one. */
  apiKey?: string
  /** The proposal's `origin` label the Safe UI shows (default `pantessa/desk`). */
  origin?: string
  /** Pin the Safe nonce (a queue with proposals ahead of this one). */
  nonce?: number
  /** Extra headers on every service call. */
  headers?: Record<string, string>
  fetch?: typeof fetch
  /** Every step, as it happens — a drill's log. */
  onEvent?: (event: SafeEvent) => void | Promise<void>
}

/** What `safeSigner` returns: the custody signer `driveJob` takes, plus the
 *  Safe's address for logs. */
export interface SafeSigner extends DeskCustodySigner {
  custody: 'safe'
  safeAddress: Address
  chainId: number
}

interface SafeInfo {
  nonce: number
  threshold: number
  owners: Address[]
  source: 'chain' | 'service'
}

interface ServiceTx {
  isExecuted?: boolean
  isSuccessful?: boolean | null
  transactionHash?: string | null
  confirmationsRequired?: number
  confirmations?: Array<{ owner: string; signature: string }>
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function chainFor(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as Chain
}

function addressOf(a: Account | WalletClient, what: string): Address {
  const direct = (a as Account).address
  if (typeof direct === 'string') return direct
  const viaClient = (a as WalletClient).account?.address
  if (typeof viaClient === 'string') return viaClient
  throw new DeskError('signer', `The Safe ${what} has no address — pass a viem LocalAccount or a WalletClient with an account.`)
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { error: text.slice(0, 400) }
  }
}

/**
 * A custody signer for `driveJob` that drives EVM legs through a Safe.
 * See the module note for what it signs and what it refuses by name.
 */
export function safeSigner(options: SafeSignerOptions): SafeSigner {
  const {
    safeAddress,
    chainId,
    owner,
    rpc,
    executor = owner,
    pollMs = 10_000,
    timeoutMs = 30 * 60_000,
    apiKey,
    origin = 'pantessa/desk',
    headers = {},
    onEvent,
  } = options
  const service = (options.txServiceUrl ?? SAFE_TX_SERVICE[chainId] ?? '').replace(/\/$/, '')
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const ownerAddress = addressOf(owner, 'owner')
  const serviceHeaders: Record<string, string> = {
    accept: 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...headers,
  }
  const rpcUrl = rpc ?? DEFAULT_RPC[chainId]
  let publicClient: PublicClient | null = null
  const client = (): PublicClient => {
    if (!rpcUrl) {
      throw new DeskError('no-rpc', `No RPC is known for chain ${chainId}. Pass rpc: '<url>' to safeSigner.`)
    }
    if (!publicClient) publicClient = createPublicClient({ chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl) }) as PublicClient
    return publicClient
  }
  const emit = async (e: SafeEvent) => {
    if (onEvent) await onEvent(e)
  }

  const serviceGet = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!service) throw new DeskError('no-rpc', `No Safe Transaction Service is known for chain ${chainId}. Pass txServiceUrl to safeSigner.`)
    const res = await doFetch(`${service}${path}`, { headers: serviceHeaders }).catch((e: unknown) => {
      throw new DeskError('http', `GET ${service}${path} failed: ${asError(e).message}`, { cause: e })
    })
    return { status: res.status, body: await readJson(res) }
  }

  /** Nonce, owners and threshold — on-chain when an RPC is known, else the service. */
  const readSafe = async (): Promise<SafeInfo> => {
    if (rpc) {
      const pc = client()
      const [nonce, owners, threshold] = await Promise.all([
        pc.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: 'nonce' }),
        pc.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: 'getOwners' }),
        pc.readContract({ address: safeAddress, abi: SAFE_ABI, functionName: 'getThreshold' }),
      ]).catch((e: unknown) => {
        throw new DeskError('http', `Reading Safe ${safeAddress} on chain ${chainId} failed: ${asError(e).message}`, { cause: e })
      })
      return { nonce: Number(nonce), owners: [...(owners as readonly Address[])], threshold: Number(threshold), source: 'chain' }
    }
    const { status, body } = await serviceGet(`/v1/safes/${safeAddress}/`)
    if (status !== 200) {
      throw new DeskError('http', `The Safe Transaction Service does not know ${safeAddress} on chain ${chainId} (HTTP ${status}) — not a Safe, or not indexed yet.`, { status })
    }
    const owners = Array.isArray(body.owners) ? (body.owners as Address[]) : []
    return { nonce: Number(body.nonce ?? 0), owners, threshold: Number(body.threshold ?? 1), source: 'service' }
  }

  const signSafeTx = async (td: TypedDataLike): Promise<Hex> => {
    if ((owner as Account).type === 'local') {
      return (owner as Account).signTypedData!(td as never)
    }
    const wc = owner as WalletClient
    return wc.signTypedData({ account: wc.account ?? ownerAddress, ...td } as never)
  }

  /** Wait on the service for a transaction to reach a state. */
  const pollService = async (hash: Hex, until: (tx: ServiceTx) => boolean, what: string): Promise<ServiceTx> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { status, body } = await serviceGet(`/v1/multisig-transactions/${hash}/`)
      const tx = body as ServiceTx
      if (status === 200 && until(tx)) return tx
      if (Date.now() > deadline) {
        throw new DeskError('http', `Safe transaction ${hash} did not reach "${what}" within ${Math.round(timeoutMs / 1000)}s.`)
      }
      await sleep(pollMs)
    }
  }

  const execute = async (tx: SafeTxFields, signatures: Hex, hash: Hex): Promise<Hex> => {
    const exec = executor as Account | WalletClient
    const data = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: 'execTransaction',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures],
    })
    let txHash: Hex
    try {
      if ((exec as Account).type === 'local') {
        if (!rpcUrl) throw new DeskError('no-rpc', `No RPC is known for chain ${chainId}. Pass rpc: '<url>' to safeSigner so the owner can execute.`)
        const wc = createWalletClient({ account: exec as Account, chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl) })
        txHash = await wc.sendTransaction({ to: safeAddress, data, value: 0n } as never)
      } else {
        const wc = exec as WalletClient
        txHash = await wc.sendTransaction({ account: wc.account ?? addressOf(wc, 'executor'), chain: null, to: safeAddress, data, value: 0n } as never)
      }
    } catch (e) {
      if (e instanceof DeskError) throw e
      throw new DeskError('broadcast', `execTransaction for Safe tx ${hash} failed to broadcast: ${asError(e).message}`, { cause: e })
    }
    let receipt
    try {
      receipt = await client().waitForTransactionReceipt({ hash: txHash })
    } catch (e) {
      if (e instanceof DeskError) throw e
      throw new DeskError('broadcast', `No receipt for ${txHash} on chain ${chainId}: ${asError(e).message}`, { detail: txHash, cause: e })
    }
    // With safeTxGas = 0 the Safe reverts (GS013) when the inner call fails,
    // so a reverted receipt is the honest "the Safe refused it".
    if (receipt.status !== 'success') {
      throw new DeskError('broadcast', `execTransaction ${txHash} reverted on chain ${chainId} — the Safe refused the inner call or the signatures.`, { detail: txHash })
    }
    return txHash.toLowerCase() as Hex
  }

  const sendTransaction = async (leg: LegTx, legChainId: number): Promise<Hex> => {
    if (legChainId !== chainId) {
      throw new DeskError('signer', `This Safe (${safeAddress}) lives on chain ${chainId}; the leg wants chain ${legChainId}. A Safe signs on its own chain only.`)
    }
    const info = await readSafe()
    await emit({ kind: 'safe', safe: safeAddress, ...info })
    if (!info.owners.some((o) => o.toLowerCase() === ownerAddress.toLowerCase())) {
      throw new DeskError('signer', `${ownerAddress} is not an owner of Safe ${safeAddress} (owners: ${info.owners.join(', ') || 'none read'}).`)
    }
    const nonce = BigInt(options.nonce ?? info.nonce)
    const tx = safeTxOf(leg, nonce)
    const hash = safeTxHash(chainId, safeAddress, tx)
    await emit({ kind: 'hash', safeTxHash: hash, tx })
    const signature = await signSafeTx(safeTxTypedData(chainId, safeAddress, tx))

    // Propose, so the firm's other owners see it in their own Safe. A hash
    // the service already holds (a retry) is not an error.
    if (!service) throw new DeskError('no-rpc', `No Safe Transaction Service is known for chain ${chainId}. Pass txServiceUrl to safeSigner.`)
    const url = `${service}/v1/safes/${safeAddress}/multisig-transactions/`
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceHeaders },
      body: JSON.stringify(safeProposalBody(safeAddress, tx, hash, ownerAddress, signature, origin)),
    }).catch((e: unknown) => {
      throw new DeskError('http', `POST ${url} failed: ${asError(e).message}`, { cause: e })
    })
    if (!res.ok) {
      const body = await readJson(res)
      const words = JSON.stringify(body).slice(0, 400)
      if (!/already exist/i.test(words)) {
        throw new DeskError('http', `The Safe Transaction Service refused the proposal (HTTP ${res.status}): ${words}`, { status: res.status })
      }
    }
    await emit({ kind: 'proposed', safeTxHash: hash, status: res.status, url })

    if (executor === false) {
      const done = await pollService(hash, (t) => t.isExecuted === true && typeof t.transactionHash === 'string', 'executed')
      if (done.isSuccessful === false) {
        throw new DeskError('broadcast', `Safe tx ${hash} was executed and FAILED (${done.transactionHash}).`, { detail: String(done.transactionHash) })
      }
      const txHash = String(done.transactionHash).toLowerCase() as Hex
      await emit({ kind: 'executed', safeTxHash: hash, transactionHash: txHash, by: 'service' })
      return txHash
    }

    // Our own execution. One owner's signature meets a threshold of 1; a
    // higher threshold waits for the others' confirmations on the service
    // and packs them in owner order.
    let signatures: Hex = signature
    if (info.threshold > 1) {
      const need = info.threshold
      const ready = await pollService(
        hash,
        (t) => {
          const have = Array.isArray(t.confirmations) ? t.confirmations.length : 0
          void emit({ kind: 'confirmations', safeTxHash: hash, have, need: t.confirmationsRequired ?? need })
          return have >= (t.confirmationsRequired ?? need)
        },
        `${need} confirmations`,
      )
      signatures = packSignatures(ready.confirmations ?? [])
    }
    const txHash = await execute(tx, signatures, hash)
    await emit({ kind: 'executed', safeTxHash: hash, transactionHash: txHash, by: 'owner' })
    return txHash
  }

  return {
    custody: 'safe',
    address: safeAddress,
    safeAddress,
    chainId,
    supports(kind: DeskLegKind): string | null {
      switch (kind) {
        case 'tx':
        case 'txChain':
        case 'wait':
          return null
        case 'order':
          return (
            'Safe presign for CoW (setPreSignature on GPv2Settlement) is wave 2 — this version drives only EVM transactions through a Safe. ' +
            'Hand the order leg to a human sign link (broker_handoff) or sign it with an owner key.'
          )
        case 'hlAction':
        case 'hlBatch':
          return (
            'Hyperliquid through a Safe is unmeasured — the venue signs EIP-712 agent actions with a key, which a Safe does not have. ' +
            'Drive Hyperliquid legs with the owner key directly.'
          )
        default:
          return `a ${kind} leg is a shape pantessa/safe will not guess at.`
      }
    },
    sendTransaction,
  }
}
