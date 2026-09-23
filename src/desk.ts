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

/** What kind of signature a leg wants. Mirrors `DeskLegKind` server-side. */
export type DeskLegKind = 'tx' | 'txChain' | 'hlAction' | 'hlBatch' | 'wait' | 'unknown'

/** One offered leg, classified. Mirrors `DeskLegView` server-side. */
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
  /** ms until the material must be re-fetched (deadline calldata, HL nonce ~2 min). */
  staleAfterMs: number | null
}

/** The evidence posted back for a signed leg. Mirrors `DeskLegResult`. */
export interface DeskLegResult {
  txHash?: Hex
  chainId?: number
  /** Hyperliquid: the venue's response to the submitted action(s). */
  orderResponse?: unknown
  /** hlBatch: one entry per member, in order; a missing entry = not submitted. */
  batch?: Array<{ ok: boolean; orderResponse?: unknown; error?: string }>
  /** Every confirmed hash of a txChain leg, in order. */
  txs?: Array<{ hash: Hex; chainId: number; title: string }>
  /** A human line the job card and the desk log show verbatim. */
  detail?: string
  explorerUrl?: string
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

/* ── classifying a leg ────────────────────────────────────────────────── */

/** A raw job step as the Jobs API serves it. */
export interface JobStep {
  seq: number
  kind: string
  status: string
  title?: string
  builder?: string
  artifact?: unknown
  guardReport?: unknown
  valueUsd?: number | null
  result?: unknown
}

/** A job as `GET /api/jobs/{id}?t=` serves it. */
export interface JobView {
  id: string
  status: string
  currentStep: number
  steps: JobStep[]
  valueUsd?: number | null
  failReason?: string | null
}

const HL_NONCE_MAX_AGE_MS = 120_000

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Classify a raw Jobs-API step into the one view every consumer reads.
 *
 * The mirror of `legViewOf` in the server's `lib/desk-wire.ts`. Note the key:
 * single-transaction artifacts are `txRequest`, not `tx`.
 */
export function legViewOfStep(step: JobStep): DeskLegView {
  const a = obj(step.artifact)
  const base = {
    seq: step.seq,
    summary: String((a?.summary as string | undefined) ?? step.title ?? ''),
    valueUsd: num(step.valueUsd),
  }
  if (step.kind === 'wait') {
    return { ...base, kind: 'wait', artifact: null, chainId: null, staleAfterMs: null }
  }
  if (!a) return { ...base, kind: 'unknown', artifact: null, chainId: null, staleAfterMs: null }

  const tx = obj(a.txRequest)
  if (tx) {
    return { ...base, kind: 'tx', artifact: a, chainId: num(tx.chainId), staleAfterMs: null }
  }

  const chain = obj(a.txChain)
  if (chain && Array.isArray(chain.steps)) {
    const steps = chain.steps as Array<Record<string, unknown>>
    const first = obj(steps[0]?.tx)
    const deadlines = steps.map((s) => num(s.validUntil)).filter((n): n is number => n !== null)
    const soonest = deadlines.length ? Math.min(...deadlines) : null
    return {
      ...base,
      kind: 'txChain',
      artifact: a,
      chainId: num(first?.chainId),
      staleAfterMs: soonest === null ? null : soonest * 1000 - Date.now(),
    }
  }

  const order = obj(a.orderRequest)
  if (order) {
    const hl = obj(order.hl)
    if (order.protocol === 'hyperliquid' && hl) {
      const batch = Array.isArray(hl.batch) ? (hl.batch as unknown[]) : null
      const nonces = [num(hl.nonce), ...(batch ?? []).map((m) => num(obj(m)?.nonce))].filter(
        (n): n is number => n !== null,
      )
      const oldest = nonces.length ? Math.min(...nonces) : null
      return {
        ...base,
        kind: batch && batch.length > 0 ? 'hlBatch' : 'hlAction',
        artifact: a,
        chainId: 1337,
        staleAfterMs: oldest === null ? null : oldest + HL_NONCE_MAX_AGE_MS - Date.now(),
      }
    }
    return { ...base, kind: 'unknown', artifact: a, chainId: num(order.chainId), staleAfterMs: null }
  }

  return { ...base, kind: 'unknown', artifact: a, chainId: null, staleAfterMs: null }
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
  onWaiting?: (note: { seq: number; status: string; title: string; withheld?: string }) => void | Promise<void>
  /** Stop after this many signed legs (default 12). */
  maxLegs?: number
  /** Poll interval in ms (default 4000). */
  pollMs?: number
  /** Give up after this long (default 30 min). */
  timeoutMs?: number
  /** Classify every leg and return WITHOUT signing or broadcasting anything. */
  dryRun?: boolean
  /** The chainId that goes inside a one-time Hyperliquid builder-fee approval. */
  hlSignatureChainId?: number
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
    pollMs = 4000,
    timeoutMs = 30 * 60_000,
    dryRun = false,
    hlSignatureChainId = 42161,
  } = options
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const origin = base.replace(/\/$/, '')
  const me = normalizeSigner(signer, rpc)

  const legs: DeskLegView[] = []
  const results: Array<{ seq: number; result: DeskLegResult }> = []
  const publicClients = new Map<number, PublicClient>()
  const seen = new Set<number>()
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
        headers: { 'content-type': 'application/json' },
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
  const submitHl = async (member: {
    action: unknown
    nonce: number
    typedData: unknown
    expected: Record<string, unknown>
    isTestnet: boolean
  }): Promise<Record<string, unknown>> => {
    if (member.nonce + HL_NONCE_MAX_AGE_MS <= Date.now()) {
      throw new DeskError('stale', 'This Hyperliquid build is older than the venue nonce window — ask for a fresh one.')
    }
    const td = obj(member.typedData)
    if (!td) throw new DeskError('unsupported-leg', 'The Hyperliquid action carries no typed data to sign.')
    // Sign the BYTES the API handed back. The action is never re-serialized:
    // its key order is part of the venue's msgpack hash.
    const signature = await me.signTypedData(td as unknown as TypedDataLike)
    const res = await doFetch(`${origin}/api/hl/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
      headers: { 'content-type': 'application/json' },
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
      const hl = obj(order.hl)!
      const isTestnet = hl.isTestnet === true
      const expected = obj(hl.expected) ?? {}
      const fee = obj(hl.feeApproval)
      if (fee && typeof fee.builder === 'string' && typeof fee.maxFeeRate === 'string') {
        await approveBuilderFee({ builder: fee.builder, maxFeeRate: fee.maxFeeRate }, isTestnet)
      }

      // Members, in the order the venue must see them: the guarded pre-action
      // (a leverage set), then the batch or the single order.
      type Member = { action: unknown; nonce: number; typedData: unknown; expected: Record<string, unknown> }
      const members: Member[] = []
      const pre = obj(hl.pre)
      if (pre) {
        members.push({
          action: pre.action,
          nonce: num(pre.nonce) ?? 0,
          typedData: pre.typedData,
          expected: { coin: expected.coin, leverage: obj(pre.expected)?.leverage },
        })
      }
      if (leg.kind === 'hlBatch') {
        for (const raw of hl.batch as unknown[]) {
          const m = obj(raw)
          if (!m) throw new DeskError('unsupported-leg', `Leg ${leg.seq} carries a malformed batch member.`)
          members.push({
            action: m.action,
            nonce: num(m.nonce) ?? 0,
            typedData: m.typedData,
            expected: obj(m.expected) ?? {},
          })
        }
      } else {
        members.push({
          action: hl.action,
          nonce: num(hl.nonce) ?? 0,
          typedData: order.typedData,
          expected: { coin: expected.coin, kind: expected.kind, isBuy: expected.isBuy },
        })
      }

      const batch: Array<{ ok: boolean; orderResponse?: unknown; error?: string }> = []
      let last: Record<string, unknown> | null = null
      for (const m of members) {
        try {
          last = await submitHl({ ...m, isTestnet })
          batch.push({ ok: true, orderResponse: last })
        } catch (e) {
          // A failed member stops the batch — the runner re-offers from it.
          batch.push({ ok: false, error: asError(e).message })
          if (leg.kind === 'hlBatch') {
            const err = new DeskError('http', `Hyperliquid batch stopped at member ${batch.length}: ${asError(e).message}`, {
              detail: JSON.stringify(batch),
              cause: e,
            })
            throw err
          }
          throw e
        }
      }
      const filled = obj(last?.filled)
      const detail = filled
        ? `${String(expected.kind ?? 'order')} ${String(expected.coin ?? '')} filled ${String(filled.totalSz)} @ ${String(filled.avgPx)}`
        : `${String(expected.kind ?? 'order')} ${String(expected.coin ?? '')}`
      return {
        orderResponse: last,
        ...(leg.kind === 'hlBatch' ? { batch } : {}),
        detail: detail.trim(),
        explorerUrl: typeof last?.explorerUrl === 'string' ? last.explorerUrl : undefined,
      }
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
      headers: { accept: 'application/json' },
    }).catch((e: unknown) => {
      throw new DeskError('http', `GET /api/jobs/${jobId} failed: ${asError(e).message}`, { cause: e })
    })
    const body = await readJson(res)
    if (!res.ok) {
      throw new DeskError('http', `GET /api/jobs/${jobId}: ${errorLine(body, 'the Jobs API refused the read')}`, {
        status: res.status,
      })
    }
    const job = obj(body.job) as unknown as JobView | null
    if (!job) throw new DeskError('http', `GET /api/jobs/${jobId} answered without a job.`)

    const step = (job.steps ?? []).find((s) => s.seq === job.currentStep)
    if (step && step.status === 'offered' && step.kind === 'sign' && step.artifact) {
      const leg = legViewOfStep(step)
      if (!seen.has(leg.seq)) {
        seen.add(leg.seq)
        legs.push(leg)
        if (onLeg) await onLeg(leg)
      }
      if (dryRun) return { jobId, status: 'dry', legs, results }
      if (results.length >= maxLegs) {
        throw new DeskError('max-legs', `Stopped after ${maxLegs} signed legs (job ${jobId} is still running).`)
      }
      const result = await signLeg(leg)
      const done = await doFetch(`${origin}/api/jobs/${jobId}/complete?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
        status: step.status,
        title: String(step.title ?? ''),
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
    await sleep(pollMs)
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
 * Mirrors `deskExecuteConsentMessage` server-side, byte for byte.
 */
export function deskExecuteConsentMessage(intentId: string, wallet: string): string {
  return [
    'Pantessa agent desk — execute consent',
    `Intent: ${intentId}`,
    `Wallet: ${wallet.toLowerCase()}`,
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

  const walletSignature = await me.signMessage(deskExecuteConsentMessage(intentId, me.address))
  const exec = await call('broker_execute', { intent_id: intentId, wallet_signature: walletSignature })

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
