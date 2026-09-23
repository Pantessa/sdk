/**
 * `pantessa/desk` — hand it a signer and it gets done.
 *
 * Pantessa's agent desk compiles a plain-English money ask into a guarded,
 * multi-leg JOB owned by the wallet that will sign it. The job's legs are
 * built fresh one at a time by deterministic builders behind fail-closed
 * guards; nothing is ever signed by Pantessa. Until now an agent wanting to
 * drive that job had to reimplement four artifact shapes, a re-quote recipe,
 * a Hyperliquid relay and a settlement poll by hand.
 *
 * `driveJob` is that loop, once:
 *
 *   poll → the runner offers ONE leg → sign it with your own key → broadcast
 *   → post completion → the runner verifies arrival on-chain before it builds
 *   the next leg → repeat until done.
 *
 * Round-trip across every settlement boundary, batched within one.
 *
 * ```ts
 * import { openAndExecute, driveJob } from 'pantessa/desk'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const signer = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`)
 * const base = 'https://www.pantessa.com'
 *
 * const { jobId, token } = await openAndExecute({
 *   base, ask: '2x long $12 of HYPE', signer,
 *   agentKey: process.env.DESK_KEY!, agent: 'my-agent',
 * })
 * await driveJob({ base, jobId, token, signer, onLeg: (leg) => console.log(leg.summary) })
 * ```
 *
 * Safety posture, unchanged by this helper: Pantessa never holds the key, the
 * desk never writes calldata with a model, every leg is guard-checked and
 * spend-policy gated at build AND at submit, and completion is *advancement*,
 * not proof — a leg result the chain disagrees with fails the job closed one
 * leg later.
 */

import type { Account, Address, Chain, Hex, PublicClient, WalletClient } from 'viem'
import { createPublicClient, createWalletClient, http } from 'viem'

/* ── the leg wire (mirrors the server's lib/desk-wire.ts) ──────────────── */
//
// These types, constants and `legViewOf` are a line-for-line mirror of
// `lib/desk-wire.ts` in the Pantessa app — the one place the artifact shapes
// are named. The harness pins the two in sync. Keep them identical.
//
// SIGNING A HYPERLIQUID LEG — the #850 rule: the venue hashes the MSGPACK of
// `hl.action`, msgpack is key-order sensitive, and Postgres `jsonb` sorts
// object keys, so the action read out of a job step is NOT in the venue's
// schema order. It does not need to be: the leg's `typedData` was built
// server-side over the CANONICAL hash, so sign `typedData` VERBATIM, post the
// action back as received, and `/api/hl/submit` re-canonicalizes before it
// hashes, guards or relays. This module never re-serializes an artifact.

/** What kind of signature a leg wants. */
export type DeskLegKind =
  | 'tx'        // one EVM transaction
  | 'txChain'   // N EVM transactions, in order
  | 'hlAction'  // one Hyperliquid L1 action (EIP-712, domain chainId 1337)
  | 'hlBatch'   // N Hyperliquid L1 actions signed in one motion (C2)
  | 'order'     // a non-HL EIP-712 order: CoW swap / limit, Seaport listing
  | 'wait'      // nothing to sign — the runner verifies settlement on-chain
  | 'unknown'   // a shape this wire does not name yet: do not sign it blind

/** The Hyperliquid L1 domain chain id — a venue constant, never a network. */
export const HL_DOMAIN_CHAIN_ID = 1337
/** How long a Hyperliquid nonce stays signable. */
export const HL_NONCE_LIFE_MS = 90_000
/** How long the runner leaves a built artifact offered before rebuilding it. */
export const LEG_OFFER_TTL_MS = 30 * 60_000
/** How often to poll while the runner is building a leg. */
export const BUILD_RETRY_MS = 3_000
/** How often to poll while a wait leg settles (the GET advances it inline). */
export const SETTLE_RETRY_MS = 10_000

export interface DeskLegView {
  seq: number
  kind: DeskLegKind
  /** One plain sentence: what signing this does. */
  summary: string
  /** The signable material, verbatim from the runner — never re-serialized. */
  artifact: Record<string, unknown> | null
  /** The chain the signature belongs to (EVM id; 1337 for a Hyperliquid L1 action). */
  chainId: number | null
  valueUsd: number | null
  /** ms after which the material must be re-fetched. 0 = already stale, ask for
   *  a rebuild. null = nothing to sign (a wait leg). */
  staleAfterMs: number | null
}

export interface DeskLegResult {
  txHash?: Hex
  chainId?: number
  /** Hyperliquid: the venue's response to the submitted action(s). */
  orderResponse?: unknown
  /** hlBatch: one entry per SUBMITTED member, in order; a failed member is the
   *  last entry with `ok: false` and the runner re-offers from it. */
  batch?: Array<{ ok: boolean; orderResponse?: unknown; error?: string }>
  /** Every confirmed hash of a txChain leg, in order. */
  txs?: Array<{ hash: Hex; chainId: number; title: string }>
  /** A human line the job card and the desk log show verbatim. */
  detail?: string
  explorerUrl?: string
}

export interface DeskNext {
  leg: DeskLegView | null
  /** Set when there is nothing to sign right now. */
  waiting: string | null
  retryAfterMs: number | null
  jobStatus: string
}

/** One member of a batched Hyperliquid leg (C2). Each is signed on its OWN
 *  `typedData` and submitted on its own, in order. */
export interface HlBatchMemberLike {
  kind?: string
  action?: unknown
  nonce?: number
  typedData?: unknown
  expected?: unknown
}

/* ── errors ───────────────────────────────────────────────────────────── */

export type DeskErrorCode =
  /** An HTTP call to the desk or the Jobs API failed. */
  | 'http'
  /** The desk refused the call (an MCP tool error, or a broker guard). */
  | 'desk-refused'
  /** The job ended in `failed`. */
  | 'job-failed'
  /** The job ended in `canceled`. */
  | 'job-canceled'
  /** A leg shape this SDK will not guess at (fail closed). */
  | 'unsupported-leg'
  /** No RPC URL is known for a chain the leg wants. */
  | 'no-rpc'
  /** The signer cannot do what the leg needs. */
  | 'signer'
  /** Broadcasting or awaiting a receipt failed, or the tx reverted. */
  | 'broadcast'
  /** The server withheld a re-quoted step (a guard or the chain refused it). */
  | 'withheld'
  /** `maxLegs` was reached before the job finished. */
  | 'max-legs'
  /** The build aged out and could not be refreshed. */
  | 'stale'

/** Every failure `pantessa/desk` raises. A raw `fetch` error never escapes. */
export class DeskError extends Error {
  readonly code: DeskErrorCode
  readonly status?: number
  readonly detail?: string
  constructor(code: DeskErrorCode, message: string, opts?: { status?: number; detail?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'DeskError'
    this.code = code
    this.status = opts?.status
    this.detail = opts?.detail
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/* ── chains ───────────────────────────────────────────────────────────── */

/**
 * Public RPC defaults, one per chain Pantessa builds on.
 *
 * Each is the chain's OWN canonical endpoint. Deliberately **not**
 * publicnode: its free tier answers `eth_getTransactionReceipt` with
 * "Archive requests require a personal token" for a transaction five blocks
 * old, and this loop polls receipts. Pass `rpc` to use your own provider —
 * recommended for anything beyond a drill, and required for Robinhood Chain
 * under load (its public RPC rate-limits per IP).
 */
export const DEFAULT_RPC: Readonly<Record<number, string>> = Object.freeze({
  1: 'https://cloudflare-eth.com',
  10: 'https://mainnet.optimism.io',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  4663: 'https://rpc.mainnet.chain.robinhood.com',
  5042: 'https://rpc.drpc.mainnet.arc.io',
})

const CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Ethereum',
  10: 'Optimism',
  8453: 'Base',
  42161: 'Arbitrum',
  4663: 'Robinhood Chain',
  5042: 'Arc',
})

/** Chains whose gas token is not ETH (Arc settles gas in USDC). */
const STABLE_GAS_CHAINS = new Set([5042])

function chainFor(chainId: number, rpcUrl: string): Chain {
  const stable = STABLE_GAS_CHAINS.has(chainId)
  return {
    id: chainId,
    name: CHAIN_NAMES[chainId] ?? `chain ${chainId}`,
    nativeCurrency: stable
      ? { name: 'USDC', symbol: 'USDC', decimals: 18 }
      : { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as Chain
}

/* ── the signer ───────────────────────────────────────────────────────── */

/**
 * Anything that can sign for one address: a viem `LocalAccount`
 * (`privateKeyToAccount(...)`) or a viem `WalletClient` with an account.
 */
export type DeskSigner = Account | WalletClient

interface TypedDataLike {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

interface NormalSigner {
  address: Address
  signMessage(message: string): Promise<Hex>
  signTypedData(typedData: TypedDataLike): Promise<Hex>
  sendTransaction(tx: LegTx, chainId: number): Promise<Hex>
}

interface LegTx {
  to: Address
  data?: Hex
  value?: string | bigint
}

function signerAddress(signer: DeskSigner): Address {
  const direct = (signer as Account).address
  if (typeof direct === 'string') return direct
  const viaClient = (signer as WalletClient).account?.address
  if (typeof viaClient === 'string') return viaClient
  throw new DeskError('signer', 'The signer has no address — pass a viem LocalAccount or a WalletClient with an account.')
}

/** Normalize a LocalAccount or a WalletClient behind one small surface. */
function normalizeSigner(signer: DeskSigner, rpc: Record<number, string>): NormalSigner {
  const address = signerAddress(signer)
  const local = (signer as Account).type === 'local' ? (signer as Account) : null
  const client = local ? null : (signer as WalletClient)
  const walletClients = new Map<number, WalletClient>()

  const rpcFor = (chainId: number): string => {
    const url = rpc[chainId] ?? DEFAULT_RPC[chainId]
    if (!url) {
      throw new DeskError(
        'no-rpc',
        `No RPC is configured for chain ${chainId}. Pass rpc: { ${chainId}: '<url>' } to driveJob.`,
      )
    }
    return url
  }

  return {
    address,
    async signMessage(message) {
      if (local) return (local.signMessage as (a: { message: string }) => Promise<Hex>)({ message })
      return client!.signMessage({ account: client!.account ?? address, message } as never)
    },
    async signTypedData(typedData) {
      if (local) return (local.signTypedData as (a: TypedDataLike) => Promise<Hex>)(typedData)
      return client!.signTypedData({ account: client!.account ?? address, ...typedData } as never)
    },
    async sendTransaction(tx, chainId) {
      const value = tx.value === undefined || tx.value === '' ? undefined : BigInt(tx.value)
      if (local) {
        let wc = walletClients.get(chainId)
        if (!wc) {
          const url = rpcFor(chainId)
          wc = createWalletClient({ account: local, chain: chainFor(chainId, url), transport: http(url) })
          walletClients.set(chainId, wc)
        }
        return wc.sendTransaction({ to: tx.to, data: tx.data, value } as never)
      }
      // A connected wallet may sit on another chain — ask it to move, but do
      // not fail on a wallet that manages chains itself.
      if (client!.chain && client!.chain.id !== chainId && typeof client!.switchChain === 'function') {
        await client!.switchChain({ id: chainId }).catch(() => {})
      }
      return client!.sendTransaction({
        account: client!.account ?? address,
        chain: null,
        to: tx.to,
        data: tx.data,
        value,
      } as never)
    },
  }
}

/* ── HTTP ─────────────────────────────────────────────────────────────── */

type FetchLike = typeof fetch

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { error: text.slice(0, 400) }
  }
}

function errorLine(body: Record<string, unknown>, fallback: string): string {
  const e = body.error ?? body.reasons ?? body.message
  return typeof e === 'string' && e ? e : fallback
}

/* ── classifying a leg (the mirror of lib/desk-wire.ts) ───────────────── */

/** The raw Jobs-API step shape this wire reads. Structural on purpose. */
export interface DeskStepLike {
  seq: number
  kind?: string | null
  status?: string | null
  builder?: string | null
  title?: string | null
  artifact?: unknown
  valueUsd?: number | null
  result?: unknown
  /** When the runner last touched the step — the offer clock for a leg with
   *  no deadline of its own. Date or ISO string (the Jobs API serializes it). */
  updatedAt?: Date | string | number | null
}

/** A job as `GET /api/jobs/{id}?t=` serves it. */
export interface DeskJobLike {
  id?: string
  status: string
  currentStep: number
  steps: DeskStepLike[]
  valueUsd?: number | null
  failReason?: string | null
}

/** @deprecated use {@link DeskStepLike}. */
export type JobStep = DeskStepLike
/** @deprecated use {@link DeskJobLike}. */
export type JobView = DeskJobLike

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t : null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const msOf = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** The one EVM tx a `txRequest` leg carries. `tx` is accepted as an alias. */
function txOf(artifact: Record<string, unknown>): Record<string, unknown> | null {
  return obj(artifact.txRequest) ?? obj(artifact.tx)
}

/** The members of a batched HL leg, in order. `orderRequest.batch` is the
 *  contract; `orderRequest.hl.batch` is tolerated. Empty = not a batch. */
export function hlBatchOf(order: Record<string, unknown> | null): HlBatchMemberLike[] {
  if (!order) return []
  const top = order.batch
  const nested = obj(order.hl)?.batch
  const raw = Array.isArray(top) ? top : Array.isArray(nested) ? nested : []
  return raw.filter((m): m is HlBatchMemberLike => !!obj(m))
}

function chainOf(artifact: Record<string, unknown> | null, kind: DeskLegKind): number | null {
  if (kind === 'hlAction' || kind === 'hlBatch') return HL_DOMAIN_CHAIN_ID
  if (!artifact) return null
  if (kind === 'tx') return num(txOf(artifact)?.chainId)
  if (kind === 'txChain') {
    const steps = obj(artifact.txChain)?.steps
    if (!Array.isArray(steps)) return null
    for (const st of steps) {
      const c = num(obj(obj(st)?.tx)?.chainId)
      if (c != null) return c
    }
    return null
  }
  if (kind === 'order') return num(obj(artifact.orderRequest)?.chainId)
  return null
}

/** Classify the artifact. Fails to `unknown` rather than guessing — an agent
 *  must never blind-sign a shape this wire cannot name. */
function kindOf(step: DeskStepLike, artifact: Record<string, unknown> | null): DeskLegKind {
  if (step.kind === 'wait') return 'wait'
  if (!artifact) return step.kind === 'sign' ? 'unknown' : 'wait'
  const order = obj(artifact.orderRequest)
  if (order) {
    if (str(order.protocol)?.toLowerCase() === 'hyperliquid') {
      return hlBatchOf(order).length > 0 ? 'hlBatch' : 'hlAction'
    }
    return 'order'
  }
  const chain = obj(artifact.txChain)
  if (chain && Array.isArray(chain.steps) && chain.steps.length > 0) return 'txChain'
  if (txOf(artifact)) return 'tx'
  return 'unknown'
}

/** How long the material stays signable, in ms from `now`. */
function staleOf(kind: DeskLegKind, artifact: Record<string, unknown> | null, step: DeskStepLike, now: number): number | null {
  if (kind === 'wait') return null
  const clamp = (at: number | null) => (at == null ? null : Math.max(0, at - now))
  if (artifact) {
    if (kind === 'hlAction' || kind === 'hlBatch') {
      const order = obj(artifact.orderRequest)
      // A batch is minted on ascending nonces in one motion, so the EARLIEST
      // member is the clock the whole leg shares.
      const members = hlBatchOf(order)
      const first = members.length > 0 ? num(members[0]?.nonce) : num(obj(order?.hl)?.nonce)
      if (first != null) return clamp(first + HL_NONCE_LIFE_MS)
    }
    if (kind === 'txChain') {
      const steps = obj(artifact.txChain)?.steps
      let soonest: number | null = null
      if (Array.isArray(steps)) {
        for (const st of steps) {
          const v = num(obj(st)?.validUntil)
          // validUntil is unix SECONDS.
          if (v != null && (soonest == null || v < soonest)) soonest = v
        }
      }
      if (soonest != null) return clamp(soonest * 1000)
    }
    if (kind === 'tx') {
      // A cross-chain deposit address is the venue's and it expires.
      const expires = msOf(artifact.addressExpires)
      if (expires != null) return clamp(expires)
    }
  }
  const touched = msOf(step.updatedAt)
  return touched == null ? null : clamp(touched + LEG_OFFER_TTL_MS)
}

/** One plain sentence: what signing this leg does. Composed from what the
 *  runner already stamps — never invented. */
function summaryOf(kind: DeskLegKind, artifact: Record<string, unknown> | null, step: DeskStepLike): string {
  const base = (artifact && str(artifact.summary)) ?? str(step.title) ?? fallbackSummary(kind)
  const extras: string[] = []
  if (kind === 'txChain') {
    const raw = obj(artifact?.txChain)?.steps
    const steps: unknown[] = Array.isArray(raw) ? raw : []
    if (steps.length > 1) {
      const labels = steps.map((st) => str(obj(st)?.label) ?? str(obj(st)?.title) ?? 'transaction')
      extras.push(`${steps.length} transactions in order: ${labels.join(' → ')}`)
    }
    if (obj(artifact?.txChain)?.refresh) extras.push('one step re-quotes before it is signed (POST /api/tx/refresh)')
  }
  if (kind === 'tx' && artifact && str(artifact.depositAddress)) {
    extras.push('pays a one-time deposit address the guard pinned — the address expires')
  }
  if (kind === 'hlAction' || kind === 'hlBatch') {
    const hl = obj(obj(artifact?.orderRequest)?.hl)
    if (hl?.pre) extras.push('a guarded leverage update signs first, then the order')
    if (hl?.feeApproval) extras.push('a one-time builder-fee approval signs first')
    if (kind === 'hlBatch') {
      const members = hlBatchOf(obj(artifact?.orderRequest))
      const named = members.map((m) => str(m.kind) ?? 'action').join(' → ')
      extras.push(`${members.length} Hyperliquid actions signed in one motion and submitted in order: ${named}; the first failure stops the batch`)
    }
  }
  if (kind === 'order') {
    const protocol = str(obj(artifact?.orderRequest)?.protocol)
    if (protocol) extras.push(`${protocol} order — signing it is off-chain; the venue settles it`)
    if (obj(artifact?.orderRequest)?.prereqTx) extras.push('a one-time on-chain approval signs first')
  }
  return extras.length ? `${base} (${extras.join('; ')})` : base
}

function fallbackSummary(kind: DeskLegKind): string {
  switch (kind) {
    case 'wait': return 'Wait for settlement — the runner verifies it on-chain.'
    case 'tx': return 'Sign one transaction.'
    case 'txChain': return 'Sign a chain of transactions in order.'
    case 'hlAction': return 'Sign a Hyperliquid action.'
    case 'hlBatch': return 'Sign a batch of Hyperliquid actions.'
    case 'order': return 'Sign an off-chain order.'
    default: return 'This leg carries a shape the desk wire does not name — do not sign it; poll again or ask a human.'
  }
}

/** Classify a raw Jobs-API step into the one view every consumer reads.
 *  Pure. The artifact rides through by REFERENCE — no clone, no JSON round
 *  trip — so a Hyperliquid action reaches the signer exactly as stored. */
export function legViewOf(step: DeskStepLike, now: number = Date.now()): DeskLegView {
  const artifact = obj(step.artifact)
  const kind = kindOf(step, artifact)
  return {
    seq: step.seq,
    kind,
    summary: summaryOf(kind, artifact, step),
    artifact: kind === 'wait' ? null : artifact,
    chainId: chainOf(artifact, kind),
    valueUsd: step.valueUsd ?? null,
    staleAfterMs: staleOf(kind, artifact, step, now),
  }
}

/** @deprecated use {@link legViewOf}. */
export const legViewOfStep = legViewOf

const TERMINAL: Record<string, string> = {
  done: 'done — every leg completed.',
  failed: 'failed — read the job\u2019s failReason; nothing further will be offered.',
  canceled: 'canceled — the job was closed; nothing further will be offered.',
}

/** The whole "what should I do right now" answer, from a job + its steps.
 *  Exactly one of `leg` / `waiting` is set. Pure. */
export function deskNextOf(job: DeskJobLike, now: number = Date.now()): DeskNext {
  const terminal = TERMINAL[job.status]
  if (terminal) return { leg: null, waiting: terminal, retryAfterMs: null, jobStatus: job.status }

  const step = job.steps.find((x) => x.seq === job.currentStep) ?? job.steps.find((x) => x.status === 'offered')
  if (!step) {
    return { leg: null, waiting: 'the runner is rolling the job up — poll again.', retryAfterMs: BUILD_RETRY_MS, jobStatus: job.status }
  }
  if (step.status === 'offered' && step.kind === 'sign') {
    return { leg: legViewOf(step, now), waiting: null, retryAfterMs: null, jobStatus: job.status }
  }
  if (step.status === 'failed') {
    return { leg: null, waiting: `leg ${step.seq + 1} failed — the job will not offer it again without a retry.`, retryAfterMs: null, jobStatus: job.status }
  }
  if (step.kind === 'wait') {
    return {
      leg: null,
      waiting: `${str(step.title) ?? `leg ${step.seq + 1}`} — waiting for on-chain settlement; the runner verifies it, nothing to sign.`,
      retryAfterMs: SETTLE_RETRY_MS,
      jobStatus: job.status,
    }
  }
  return {
    leg: null,
    waiting: `leg ${step.seq + 1} (${str(step.title) ?? step.builder ?? 'building'}) is being built fresh and guard-checked — poll again.`,
    retryAfterMs: BUILD_RETRY_MS,
    jobStatus: job.status,
  }
}

/* ── driveJob ─────────────────────────────────────────────────────────── */

export interface DriveJobOptions {
  /** Origin of the Pantessa deployment, e.g. `https://www.pantessa.com`. */
  base: string
  jobId: string
  /** The job's capability token — `broker_execute` returns it in `drive.poll`. */
  token: string
  /** The wallet the job is owned by: a viem LocalAccount or WalletClient. */
  signer: DeskSigner
  /** `{ chainId: rpcUrl }` overriding `DEFAULT_RPC`. Use your own provider. */
  rpc?: Record<number, string>
  /** Called once per leg, the moment it is offered and classified. */
  onLeg?: (leg: DeskLegView) => void | Promise<void>
  /** Called after a leg's completion is accepted by the runner. */
  onDone?: (seq: number, result: DeskLegResult) => void | Promise<void>
  /**
   * Called on every poll that has nothing to sign — a wait leg settling, the
   * runner still building, or a step WITHHELD because the wallet can't fund
   * it yet. `withheld` carries the runner's own honest sentence.
   */
  onWaiting?: (note: { seq: number; status: string; title: string; waiting?: string; withheld?: string }) => void | Promise<void>
  /** Stop after this many signed legs (default 12). */
  maxLegs?: number
  /** Force a poll interval in ms. Omitted, the loop uses the wire's own
   *  cadence — `BUILD_RETRY_MS` while a leg builds, `SETTLE_RETRY_MS` while
   *  one settles. */
  pollMs?: number
  /** Give up after this long (default 30 min). */
  timeoutMs?: number
  /** Classify every leg and return WITHOUT signing or broadcasting anything. */
  dryRun?: boolean
  /** The chainId that goes inside a one-time Hyperliquid builder-fee approval. */
  hlSignatureChainId?: number
  /** Extra headers on every call this loop makes — the Jobs API, the re-quote
   *  route and the Hyperliquid relay alike (e.g. `x-yf-internal-run` on a
   *  drill, so the rows it mints never read as growth). */
  headers?: Record<string, string>
  /** Swap in a custom fetch (tests, proxies, extra headers). */
  fetch?: FetchLike
}

export interface DriveJobOutcome {
  jobId: string
  /** `done` | `failed` | `canceled`, or `dry` when `dryRun` stopped the loop. */
  status: string
  /** Every leg the loop saw, in order (the only output of a `dryRun`). */
  legs: DeskLegView[]
  /** Every completion the runner accepted, in order. */
  results: Array<{ seq: number; result: DeskLegResult }>
  /** Set when the job failed: the runner's own words. */
  failReason?: string
  /**
   * Set when the loop stopped at a step the runner WITHHELD — it built
   * nothing because the wallet can't fund the leg yet. Not a failure: the
   * job stays live and the step is offered the moment the money is there.
   */
  withheld?: { seq: number; reason: string }
}

const ACTIVE = new Set(['running', 'waiting_signature', 'waiting_settlement', 'paused'])

/** How many times one leg may be rebuilt after going stale before giving up. */
const MAX_REBUILDS = 3
/** How many times one leg may be offered (a batch re-offers from its failed member). */
const MAX_LEG_ATTEMPTS = 4

/**
 * Drive a Pantessa job leg by leg with your own signer.
 *
 * Polls the job, and whenever the runner offers a leg signs the shape it
 * carries — a single transaction, a transaction chain (re-quoting any step
 * that carries a `refresh` recipe), a Hyperliquid L1 action, or a batch of
 * them — broadcasts it, waits for the receipt, and posts completion. Wait
 * legs are left to the runner, which verifies arrival on-chain before the
 * next leg is built. Returns when the job reaches `done`, `failed` or
 * `canceled`.
 *
 * With `dryRun: true` nothing is signed and nothing is broadcast: the loop
 * returns as soon as the first leg is offered, with the leg views it saw.
 */
export async function driveJob(options: DriveJobOptions): Promise<DriveJobOutcome> {
  const {
    base,
    jobId,
    token,
    signer,
    rpc = {},
    onLeg,
    onDone,
    onWaiting,
    maxLegs = 12,
    pollMs,
    timeoutMs = 30 * 60_000,
    dryRun = false,
    hlSignatureChainId = 42161,
    headers = {},
  } = options
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const origin = base.replace(/\/$/, '')
  const me = normalizeSigner(signer, rpc)

  const legs: DeskLegView[] = []
  const results: Array<{ seq: number; result: DeskLegResult }> = []
  const publicClients = new Map<number, PublicClient>()
  const seen = new Set<number>()
  const attempts = new Map<number, number>()
  const rebuilds = new Map<number, number>()
  const deadline = Date.now() + timeoutMs

  const publicClientFor = (chainId: number): PublicClient => {
    let c = publicClients.get(chainId)
    if (!c) {
      const url = rpc[chainId] ?? DEFAULT_RPC[chainId]
      if (!url) {
        throw new DeskError(
          'no-rpc',
          `No RPC is configured for chain ${chainId}. Pass rpc: { ${chainId}: '<url>' } to driveJob.`,
        )
      }
      c = createPublicClient({ chain: chainFor(chainId, url), transport: http(url) }) as PublicClient
      publicClients.set(chainId, c)
    }
    return c
  }

  /** Broadcast one transaction and wait for a SUCCESSFUL receipt. */
  const send = async (tx: LegTx, chainId: number): Promise<Hex> => {
    let hash: Hex
    try {
      hash = await me.sendTransaction(tx, chainId)
    } catch (e) {
      if (e instanceof DeskError) throw e
      throw new DeskError('broadcast', `Broadcast failed on chain ${chainId}: ${asError(e).message}`, { cause: e })
    }
    let receipt
    try {
      receipt = await publicClientFor(chainId).waitForTransactionReceipt({ hash })
    } catch (e) {
      if (e instanceof DeskError) throw e
      throw new DeskError('broadcast', `No receipt for ${hash} on chain ${chainId}: ${asError(e).message}`, {
        detail: hash,
        cause: e,
      })
    }
    // A reverted transaction is not a completed leg — never post it as one.
    if (receipt.status !== 'success') {
      throw new DeskError('broadcast', `Transaction ${hash} reverted on chain ${chainId}.`, { detail: hash })
    }
    return hash
  }

  /** Re-quote one step of a chain server-side before signing it. */
  const refreshStep = async (
    recipe: { kind: string; stepIndex: number; params: Record<string, string> },
    step: { tx: LegTx & { chainId?: number }; validUntil?: number },
  ): Promise<{ tx: LegTx & { chainId?: number }; validUntil?: number }> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await doFetch(`${origin}/api/tx/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ kind: recipe.kind, ...recipe.params, from: me.address }),
      }).catch((e: unknown) => {
        throw new DeskError('http', `POST /api/tx/refresh failed: ${asError(e).message}`, { cause: e })
      })
      const body = await readJson(res)
      if (body.blocked === true) {
        throw new DeskError('withheld', `The re-quote was withheld: ${errorLine(body, 'a safety check refused it')}`, {
          detail: String(body.blockKind ?? ''),
        })
      }
      const fresh = obj(body.tx)
      if (fresh) {
        return { tx: fresh as unknown as LegTx & { chainId?: number }, validUntil: num(body.validUntil) ?? undefined }
      }
      if (body.pending === true && attempt < 4) {
        await sleep(2500)
        continue
      }
      break
    }
    // No fresh build came back. Prebuilt calldata past its deadline is the
    // wallet dead-end this whole recipe exists to avoid — refuse it.
    if (typeof step.validUntil === 'number' && step.validUntil * 1000 <= Date.now()) {
      throw new DeskError('stale', 'This quote expired before it was signed and could not be rebuilt. Ask again.')
    }
    return step
  }

  /** Sign + submit ONE Hyperliquid L1 action through the relay. */
  /** Sign one member's typed data, verbatim. Never re-serialize the action. */
  const signHl = async (member: { typedData: unknown }): Promise<Hex> => {
    const td = obj(member.typedData)
    if (!td) throw new DeskError('unsupported-leg', 'The Hyperliquid action carries no typed data to sign.')
    return me.signTypedData(td as unknown as TypedDataLike)
  }

  /** Relay ONE already-signed Hyperliquid L1 action, `mode: 'direct'`. */
  const submitHl = async (member: {
    action: unknown
    nonce: number
    expected: Record<string, unknown>
    isTestnet: boolean
    signature: Hex
  }): Promise<Record<string, unknown>> => {
    const signature = member.signature
    const res = await doFetch(`${origin}/api/hl/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        mode: 'direct',
        action: member.action,
        nonce: member.nonce,
        isTestnet: member.isTestnet,
        expected: member.expected,
        signature,
        from: me.address,
      }),
    }).catch((e: unknown) => {
      throw new DeskError('http', `POST /api/hl/submit failed: ${asError(e).message}`, { cause: e })
    })
    const body = await readJson(res)
    if (!res.ok) {
      throw new DeskError('http', `Hyperliquid submit refused: ${errorLine(body, 'the relay refused the action')}`, {
        status: res.status,
        detail: typeof body.code === 'string' ? body.code : undefined,
      })
    }
    return body
  }

  /** The one-time builder-fee cap, when the build says the account needs it. */
  const approveBuilderFee = async (fee: { builder: string; maxFeeRate: string }, isTestnet: boolean): Promise<void> => {
    const nonce = Date.now()
    const action = {
      type: 'approveBuilderFee',
      signatureChainId: `0x${hlSignatureChainId.toString(16)}`,
      hyperliquidChain: isTestnet ? 'Testnet' : 'Mainnet',
      maxFeeRate: fee.maxFeeRate,
      builder: fee.builder.toLowerCase(),
      nonce,
    }
    const signature = await me.signTypedData({
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: hlSignatureChainId,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        'HyperliquidTransaction:ApproveBuilderFee': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'maxFeeRate', type: 'string' },
          { name: 'builder', type: 'address' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
      message: {
        hyperliquidChain: action.hyperliquidChain,
        maxFeeRate: action.maxFeeRate,
        builder: action.builder,
        nonce: BigInt(nonce) as unknown as number,
      },
    })
    const res = await doFetch(`${origin}/api/hl/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ action, nonce, isTestnet, signature, from: me.address }),
    }).catch((e: unknown) => {
      throw new DeskError('http', `POST /api/hl/submit (fee cap) failed: ${asError(e).message}`, { cause: e })
    })
    if (!res.ok) {
      const body = await readJson(res)
      throw new DeskError('http', `Builder-fee approval refused: ${errorLine(body, 'the relay refused it')}`, {
        status: res.status,
      })
    }
  }

  /** Sign a whole offered leg and produce its completion evidence. */
  const signLeg = async (leg: DeskLegView): Promise<DeskLegResult> => {
    const a = leg.artifact as Record<string, unknown>
    if (leg.kind === 'tx') {
      const tx = obj(a.txRequest) as unknown as LegTx & { chainId?: number }
      const chainId = tx.chainId ?? leg.chainId
      if (!chainId) throw new DeskError('unsupported-leg', `Leg ${leg.seq} names no chain to broadcast on.`)
      const hash = await send(tx, chainId)
      return { txHash: hash, chainId, detail: leg.summary }
    }

    if (leg.kind === 'txChain') {
      const chain = obj(a.txChain)!
      let steps = (chain.steps as Array<Record<string, unknown>>).slice()
      const recipe = obj(chain.refresh) as { kind: string; stepIndex: number; params: Record<string, string> } | null
      const txs: Array<{ hash: Hex; chainId: number; title: string }> = []
      for (let i = 0; i < steps.length; i++) {
        let step = steps[i]! as unknown as { title?: string; tx: LegTx & { chainId?: number }; validUntil?: number }
        // A step with a recipe is rebuilt right before it is offered: prices
        // move while approvals mine, and the guard must re-fire per step.
        if (recipe && recipe.stepIndex === i) {
          const fresh = await refreshStep(recipe, step)
          step = { ...step, ...fresh }
          steps = steps.slice()
          steps[i] = step as unknown as Record<string, unknown>
        }
        const chainId = step.tx.chainId ?? leg.chainId
        if (!chainId) throw new DeskError('unsupported-leg', `Leg ${leg.seq} step ${i} names no chain.`)
        const hash = await send(step.tx, chainId)
        txs.push({ hash, chainId, title: String(step.title ?? `step ${i + 1}`) })
      }
      const last = txs[txs.length - 1]
      if (!last) throw new DeskError('unsupported-leg', `Leg ${leg.seq} carries an empty transaction chain.`)
      return { txHash: last.hash, chainId: last.chainId, txs, detail: leg.summary }
    }

    if (leg.kind === 'hlAction' || leg.kind === 'hlBatch') {
      const order = obj(a.orderRequest)!
      const hl = obj(order.hl) ?? {}
      const isTestnet = hl.isTestnet === true
      const expected = obj(hl.expected) ?? {}

      type Member = { kind: string; action: unknown; nonce: number; typedData: unknown; expected: Record<string, unknown> }
      const members: Member[] = []

      if (leg.kind === 'hlBatch') {
        // C2: the members live at the TOP level of orderRequest (`hl.batch` is
        // tolerated), already in submission order with ascending nonces, the
        // `order` member last. A batch never carries a one-time fee approval.
        for (const m of hlBatchOf(order)) {
          members.push({
            kind: str(m.kind) ?? 'action',
            action: m.action,
            nonce: num(m.nonce) ?? 0,
            typedData: m.typedData,
            expected: obj(m.expected) ?? {},
          })
        }
      } else {
        // The single-action path, exactly as the browser card signs it: the
        // one-time builder-fee cap (a wallet-chain signature, not an L1
        // action), then the guarded leverage pre-step, then the order.
        const fee = obj(hl.feeApproval)
        if (fee && typeof fee.builder === 'string' && typeof fee.maxFeeRate === 'string') {
          await approveBuilderFee({ builder: fee.builder, maxFeeRate: fee.maxFeeRate }, isTestnet)
        }
        const pre = obj(hl.pre)
        if (pre) {
          members.push({
            kind: 'leverage',
            action: pre.action,
            nonce: num(pre.nonce) ?? 0,
            typedData: pre.typedData,
            expected: { coin: expected.coin, leverage: obj(pre.expected)?.leverage },
          })
        }
        members.push({
          kind: 'order',
          action: hl.action,
          nonce: num(hl.nonce) ?? 0,
          typedData: order.typedData,
          expected: { coin: expected.coin, kind: expected.kind, isBuy: expected.isBuy },
        })
      }
      if (members.length === 0) {
        throw new DeskError('unsupported-leg', `Leg ${leg.seq} names Hyperliquid but carries nothing to sign.`)
      }

      // Sign every member in ONE pass, then submit in order. The nonce window
      // is shared (the earliest nonce is the clock), so a pause between
      // signatures is what ages the whole leg out.
      const signed: Array<Member & { signature: Hex }> = []
      for (const m of members) signed.push({ ...m, signature: await signHl(m) })

      const batch: Array<{ ok: boolean; orderResponse?: unknown; error?: string }> = []
      let last: Record<string, unknown> | null = null
      let stopped: Error | null = null
      for (const m of signed) {
        try {
          last = await submitHl({ ...m, isTestnet })
          batch.push({ ok: true, orderResponse: last })
        } catch (e) {
          // A failed member stops the batch. Its result is still POSTed: the
          // runner re-arms the step and re-offers it from the failed member
          // (a leverage the venue already applied is skipped by the builder).
          batch.push({ ok: false, error: asError(e).message })
          stopped = asError(e)
          break
        }
      }

      const filled = obj(last?.filled)
      const detail = filled
        ? `${String(expected.kind ?? 'order')} ${String(expected.coin ?? '')} filled ${String(filled.totalSz)} @ ${String(filled.avgPx)}`
        : `${String(expected.kind ?? 'order')} ${String(expected.coin ?? '')}`

      if (leg.kind === 'hlBatch') {
        // Always the batch shape, even a single member: consumers read one thing.
        return {
          batch,
          orderResponse: last,
          detail: stopped ? `${detail.trim()} — stopped at member ${batch.length}: ${stopped.message}` : detail.trim(),
          explorerUrl: typeof last?.explorerUrl === 'string' ? last.explorerUrl : undefined,
        }
      }
      // The single-action path has no re-offer contract: a refusal is the leg's.
      if (stopped) throw stopped
      return {
        orderResponse: last,
        detail: detail.trim(),
        explorerUrl: typeof last?.explorerUrl === 'string' ? last.explorerUrl : undefined,
      }
    }

    if (leg.kind === 'order') {
      const protocol = str(obj(a.orderRequest)?.protocol) ?? 'unknown'
      throw new DeskError(
        'unsupported-leg',
        `Leg ${leg.seq} is a ${protocol} order. pantessa/desk signs Hyperliquid actions and EVM transactions; ` +
          'an off-chain order has its own submit endpoint and prerequisites, so this loop will not guess at it — ' +
          'hand this leg to a human sign link (broker_handoff) or sign it yourself.',
        { detail: leg.summary },
      )
    }

    throw new DeskError(
      'unsupported-leg',
      `Leg ${leg.seq} carries a shape pantessa/desk will not guess at (${leg.kind}). Sign it yourself, or open an issue with the builder id.`,
      { detail: leg.summary },
    )
  }

  /* the loop */
  for (;;) {
    if (Date.now() > deadline) {
      throw new DeskError('http', `Job ${jobId} did not finish within ${Math.round(timeoutMs / 1000)}s.`)
    }
    const res = await doFetch(`${origin}/api/jobs/${jobId}?t=${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json', ...headers },
    }).catch((e: unknown) => {
      throw new DeskError('http', `GET /api/jobs/${jobId} failed: ${asError(e).message}`, { cause: e })
    })
    const body = await readJson(res)
    if (!res.ok) {
      throw new DeskError('http', `GET /api/jobs/${jobId}: ${errorLine(body, 'the Jobs API refused the read')}`, {
        status: res.status,
      })
    }
    const job = obj(body.job) as unknown as DeskJobLike | null
    if (!job) throw new DeskError('http', `GET /api/jobs/${jobId} answered without a job.`)

    const next = deskNextOf(job)
    const step = (job.steps ?? []).find((x) => x.seq === job.currentStep)
    if (next.leg) {
      const leg = next.leg
      if (!seen.has(leg.seq)) {
        seen.add(leg.seq)
        legs.push(leg)
        if (onLeg) await onLeg(leg)
      }
      if (dryRun) return { jobId, status: 'dry', legs, results }
      if (results.length >= maxLegs) {
        throw new DeskError('max-legs', `Stopped after ${maxLegs} signed legs (job ${jobId} is still running).`)
      }
      // A build whose clock has run out is REBUILT, never re-signed: the
      // Hyperliquid nonce window is 90s while the offer stands for 30 min.
      if (leg.staleAfterMs !== null && leg.staleAfterMs <= 0) {
        const tries = (rebuilds.get(leg.seq) ?? 0) + 1
        if (tries > MAX_REBUILDS) {
          throw new DeskError('stale', `Leg ${leg.seq} went stale ${MAX_REBUILDS} times before it could be signed — ask again for a fresh job.`)
        }
        rebuilds.set(leg.seq, tries)
        const again = await doFetch(`${origin}/api/jobs/${jobId}/retry?t=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
        }).catch((e: unknown) => {
          throw new DeskError('http', `POST /api/jobs/${jobId}/retry failed: ${asError(e).message}`, { cause: e })
        })
        if (!again.ok) {
          const rbody = await readJson(again)
          throw new DeskError('stale', `Leg ${leg.seq} is stale and the runner would not rebuild it: ${errorLine(rbody, 'retry refused')}`, {
            status: again.status,
          })
        }
        if (onWaiting) await onWaiting({ seq: leg.seq, status: 'rebuilding', title: leg.summary })
        seen.delete(leg.seq)
        await sleep(pollMs ?? BUILD_RETRY_MS)
        continue
      }
      const signed = (attempts.get(leg.seq) ?? 0) + 1
      if (signed > MAX_LEG_ATTEMPTS) {
        throw new DeskError('http', `Leg ${leg.seq} was re-offered ${MAX_LEG_ATTEMPTS} times without completing — stopping.`)
      }
      attempts.set(leg.seq, signed)
      const result = await signLeg(leg)
      const done = await doFetch(`${origin}/api/jobs/${jobId}/complete?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ seq: leg.seq, result }),
      }).catch((e: unknown) => {
        throw new DeskError('http', `POST /api/jobs/${jobId}/complete failed: ${asError(e).message}`, { cause: e })
      })
      if (!done.ok) {
        const dbody = await readJson(done)
        throw new DeskError('http', `The runner refused leg ${leg.seq}: ${errorLine(dbody, 'completion rejected')}`, {
          status: done.status,
        })
      }
      results.push({ seq: leg.seq, result })
      if (onDone) await onDone(leg.seq, result)
      // A batch that stopped at a failed member IS posted: the runner re-arms
      // the step and re-offers the SAME seq starting from that member.
      if (result.batch?.some((m) => !m.ok)) seen.delete(leg.seq)
      continue // the runner advances inline; read the next leg at once
    }

    // Nothing to sign this tick. A step the runner WITHHELD is the honest
    // end of a dry run: it built nothing because the wallet can't fund the
    // leg, and it says so in its own words.
    const withheldReason =
      step && step.status === 'pending' && obj(step.result)?.withheld === true
        ? String(obj(step.result)?.error ?? 'the runner withheld this step')
        : null
    if (step && onWaiting) {
      await onWaiting({
        seq: step.seq,
        status: String(step.status ?? ''),
        title: String(step.title ?? ''),
        waiting: next.waiting ?? undefined,
        ...(withheldReason ? { withheld: withheldReason } : {}),
      })
    }
    if (dryRun && withheldReason) {
      return { jobId, status: 'dry', legs, results, withheld: { seq: step!.seq, reason: withheldReason } }
    }

    if (job.status === 'done') return { jobId, status: 'done', legs, results }
    if (job.status === 'failed') {
      return { jobId, status: 'failed', legs, results, failReason: job.failReason ?? undefined }
    }
    if (job.status === 'canceled') return { jobId, status: 'canceled', legs, results }
    if (!ACTIVE.has(job.status)) {
      throw new DeskError('http', `Job ${jobId} is in an unknown state "${job.status}".`)
    }
    await sleep(pollMs ?? next.retryAfterMs ?? BUILD_RETRY_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/* ── openAndExecute ───────────────────────────────────────────────────── */

/** One option the desk offered on an open. */
export interface DeskOption {
  id: string
  label: string
  resume: string
  kind: 'funding' | 'restate' | 'decline'
}

export interface OpenAndExecuteOptions {
  /** Origin of the Pantessa deployment, e.g. `https://www.pantessa.com`. */
  base: string
  /** The money intent, as one plain sentence: "2x long $12 of HYPE". */
  ask: string
  /** The wallet that will sign every leg. It proves itself by consent signature. */
  signer: DeskSigner
  /** Your desk identity string — required for the agent-signed path. */
  agentKey: string
  /** Your agent's name, shown as the byline. */
  agent?: string
  /**
   * Pick an option from the desk's plan. The default takes the first funding
   * route when the wallet is short, and "proceed as asked" otherwise. Return
   * `null` to proceed without choosing.
   */
  choose?: (options: DeskOption[], plan: Record<string, unknown>) => DeskOption | null
  /** An https webhook for signed/settled events on this intent. */
  callbackUrl?: string
  /** Extra headers on every desk call (e.g. `x-yf-internal-run` for drills). */
  headers?: Record<string, string>
  fetch?: FetchLike
}

export interface OpenAndExecuteResult {
  intentId: string
  jobId: string
  /** The job's capability token — hand it straight to `driveJob`. */
  token: string
  /** `GET` url the token was read from (origin rebased onto `base`). */
  pollUrl: string
  /** The legs the desk compiled, before any of them is built. */
  steps: Array<{ seq: number; kind: string; note: string }>
  /** The desk's own sentence about what it compiled. */
  say: string
  /** The plan the open returned, verbatim. */
  plan: Record<string, unknown>
  /** The option the loop chose, if any. */
  chosen: DeskOption | null
}

/**
 * The consent text a wallet signs to prove it owns an agent-signed intent.
 *
 * Mirrors `deskExecuteConsentMessage` in the Pantessa app, **byte for byte**.
 * The desk recovers the signer from the text IT builds, so a single character
 * of drift here recovers to a different address and reads to the caller like a
 * wallet bug. The harness pins the two copies line for line.
 *
 * With `issuedAt` (an ISO timestamp) the text carries a freshness line, which
 * the desk checks both ways inside a ten-minute window; without it, the
 * original four-line text. `openAndExecute` signs the fresh form and falls
 * back to the original once if the desk has not shipped it yet.
 *
 * TODO-verify: the `Issued at:` line's exact format is the squad's decision of
 * record (agent-desk squad, C1) but the server side had not landed when this
 * was written — re-pin against `lib/broker-exec.ts` before publishing.
 */
export function deskExecuteConsentMessage(intentId: string, wallet: string, issuedAt?: string): string {
  return [
    'Pantessa agent desk — execute consent',
    `Intent: ${intentId}`,
    `Wallet: ${wallet.toLowerCase()}`,
    ...(issuedAt ? [`Issued at: ${issuedAt}`] : []),
    "Signing lets the desk compile this intent into a job owned by this wallet. It moves nothing by itself; every leg still needs this wallet's own signature.",
  ].join('\n')
}

/**
 * Call one tool on the desk MCP.
 *
 * The desk runs `mcp-handler` with no session id generator, i.e. stateless
 * Streamable HTTP: a bare JSON-RPC `tools/call` needs no `initialize`
 * handshake and no session header, and the reply arrives as a one-frame SSE
 * stream. That is why this file speaks JSON-RPC over `fetch` rather than
 * pulling in the MCP SDK — `pantessa`'s only dependency stays the viem peer.
 */
export async function deskCall(
  base: string,
  name: string,
  args: Record<string, unknown>,
  opts?: { headers?: Record<string, string>; fetch?: FetchLike },
): Promise<Record<string, unknown>> {
  const doFetch = opts?.fetch ?? globalThis.fetch.bind(globalThis)
  const url = `${base.replace(/\/$/, '')}/api/broker/mcp`
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts?.headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  }).catch((e: unknown) => {
    throw new DeskError('http', `POST ${url} failed: ${asError(e).message}`, { cause: e })
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new DeskError('http', `The desk answered ${res.status} for ${name}.`, {
      status: res.status,
      detail: text.slice(0, 300),
    })
  }
  const frame = parseRpcFrame(text)
  if (frame.error) {
    const msg = obj(frame.error)?.message
    throw new DeskError('desk-refused', `${name}: ${typeof msg === 'string' ? msg : 'the desk refused the call'}`)
  }
  const result = obj(frame.result)
  const content = Array.isArray(result?.content) ? (result!.content as Array<Record<string, unknown>>) : []
  const payload = content.find((c) => c.type === 'text')?.text
  const body = typeof payload === 'string' ? payload : ''
  if (result?.isError) throw new DeskError('desk-refused', `${name}: ${body || 'the desk refused the call'}`)
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new DeskError('desk-refused', `${name} answered something that is not JSON: ${body.slice(0, 200)}`)
  }
}

/** Streamable HTTP answers as SSE or plain JSON — read whichever arrived. */
function parseRpcFrame(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) throw new DeskError('desk-refused', 'The desk answered with an empty body.')
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      throw new DeskError('desk-refused', `The desk answered unparseable JSON: ${trimmed.slice(0, 200)}`)
    }
  }
  const frames = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
  const last = frames[frames.length - 1]
  if (!last) throw new DeskError('desk-refused', `The desk answered no data frame: ${trimmed.slice(0, 200)}`)
  try {
    return JSON.parse(last) as Record<string, unknown>
  } catch {
    throw new DeskError('desk-refused', `The desk answered an unparseable frame: ${last.slice(0, 200)}`)
  }
}

/** The default option picker: a funding route when short, else proceed. */
export function firstFundableOption(options: DeskOption[], plan: Record<string, unknown>): DeskOption | null {
  const verdict = obj(obj(plan.quote)?.funding)?.verdict
  if (verdict === 'short') {
    const funding = options.find((o) => o.kind === 'funding')
    if (funding) return funding
  }
  return options.find((o) => o.id === 'proceed') ?? options.find((o) => o.kind === 'restate') ?? null
}

/**
 * Open an intent at the desk, pick an option, consent, and execute — leaving
 * a job this wallet can drive. The returned `{ jobId, token }` go straight
 * into {@link driveJob}.
 *
 * The consent is a plain `personal_sign` over one readable sentence and moves
 * nothing by itself; every leg still needs this wallet's own signature.
 */
export async function openAndExecute(options: OpenAndExecuteOptions): Promise<OpenAndExecuteResult> {
  const { base, ask, signer, agentKey, agent, callbackUrl, headers, choose = firstFundableOption } = options
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const origin = base.replace(/\/$/, '')
  const me = normalizeSigner(signer, {})
  const call = (name: string, args: Record<string, unknown>) => deskCall(origin, name, args, { headers, fetch: doFetch })

  const open = await call('broker_open', {
    ask,
    wallet: me.address,
    agent_key: agentKey,
    ...(agent ? { agent } : {}),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
  })
  const intentId = typeof open.intentId === 'string' ? open.intentId : ''
  if (!intentId) throw new DeskError('desk-refused', 'broker_open returned no intent id.')
  let plan = obj(open.plan) ?? {}

  const offered = Array.isArray(plan.options) ? (plan.options as unknown as DeskOption[]) : []
  const chosen = choose(offered, plan)
  if (chosen && chosen.kind === 'decline') {
    throw new DeskError('desk-refused', 'The option picker chose to walk away — nothing was executed.')
  }
  if (chosen && chosen.id !== 'proceed') {
    const re = await call('broker_choose', { intent_id: intentId, option_id: chosen.id })
    plan = obj(re.plan) ?? plan
  }

  // Signed immediately before the call so the freshness window is the
  // round-trip, not however long the negotiation took.
  const issuedAt = new Date().toISOString()
  let exec: Record<string, unknown>
  try {
    exec = await call('broker_execute', {
      intent_id: intentId,
      issued_at: issuedAt,
      wallet_signature: await me.signMessage(deskExecuteConsentMessage(intentId, me.address, issuedAt)),
    })
  } catch (e) {
    // A desk that has not shipped the freshness line recovers a different
    // address from our text and refuses the wallet proof. That must not read
    // as a wallet bug, so sign the original text once and try again.
    const refusedProof = e instanceof DeskError && e.code === 'desk-refused' && /wallet_signature|consent|recovers/i.test(e.message)
    if (!refusedProof) throw e
    exec = await call('broker_execute', {
      intent_id: intentId,
      wallet_signature: await me.signMessage(deskExecuteConsentMessage(intentId, me.address)),
    })
  }

  const jobId = typeof exec.jobId === 'string' ? exec.jobId : ''
  const drive = obj(exec.drive)
  const pollRaw = typeof drive?.poll === 'string' ? drive.poll : ''
  const token = /[?&]t=([^&]+)/.exec(pollRaw)?.[1] ?? ''
  if (!jobId || !token) {
    throw new DeskError('desk-refused', 'broker_execute returned no job id or capability token.')
  }
  return {
    intentId,
    jobId,
    token: decodeURIComponent(token),
    // The desk answers with its canonical site origin; drive whatever
    // deployment the caller pointed at.
    pollUrl: pollRaw.replace(/^https?:\/\/[^/]+/, origin),
    steps: Array.isArray(exec.steps) ? (exec.steps as OpenAndExecuteResult['steps']) : [],
    say: typeof exec.say === 'string' ? exec.say : '',
    plan,
    chosen,
  }
}
