import type { Address } from 'viem'
import { Facilitator, DEFAULT_FACILITATOR_URL } from './facilitator.js'
import type {
  FacilitatorConfig,
  PaymentPayload,
  PaymentRequirement,
  PaymentRequiredResponse,
  SettleResult,
  X402Network,
} from './types.js'
import { decodePayment, encodePayment, usdcAddress, usdToAtomic } from './utils.js'

export interface RouteGateOptions {
  /** Price in USD, e.g. "0.01". Converted to USDC atomic units. */
  price: string | number
  /** Recipient address that receives the funds. */
  recipient: Address
  /** Network(s) to accept. Defaults to `['base']`. Pass an array for multi-chain. */
  network?: X402Network | X402Network[]
  /** Override the payment asset (defaults to USDC for the given network). */
  asset?: Address
  /** Human-readable description of the resource. */
  description?: string
  /** Seconds the signed authorization is valid. Default: 600. */
  maxTimeoutSeconds?: number
  /** Facilitator config, or `false` to skip verification/settlement (trust-mode). */
  facilitator?: FacilitatorConfig | false
  /**
   * Optional resource identifier (defaults to the request URL). Useful for
   * logging / receipts.
   */
  resource?: string
}

/**
 * Runtime-agnostic gate: given a Fetch-API `Request`, either returns a 402
 * `Response` or a `{ settle }` handle. After your handler runs, call `settle()`
 * to finalize the payment and get a `X-PAYMENT-RESPONSE` header to attach.
 *
 * This is the building block used by the framework adapters (`./next`, `./express`).
 */
export async function gate(
  request: Request,
  opts: RouteGateOptions,
): Promise<
  | { type: 'paymentRequired'; response: Response }
  | { type: 'ok'; payer: Address; settle: () => Promise<{ header: string; result: SettleResult }> }
> {
  const requirements = buildRequirements(request, opts)

  const header = request.headers.get('x-payment') ?? request.headers.get('X-PAYMENT')
  if (!header) {
    return { type: 'paymentRequired', response: paymentRequiredResponse(requirements) }
  }

  let payment: PaymentPayload
  try {
    payment = decodePayment<PaymentPayload>(header)
  } catch {
    return {
      type: 'paymentRequired',
      response: paymentRequiredResponse(requirements, 'Invalid X-PAYMENT header'),
    }
  }

  const matched = requirements.find(
    (r) => r.network === payment.network && r.scheme === payment.scheme,
  )
  if (!matched) {
    return {
      type: 'paymentRequired',
      response: paymentRequiredResponse(requirements, 'Payment does not match any accepted requirement'),
    }
  }

  if (opts.facilitator === false) {
    const payer = payment.payload.authorization.from as Address
    return {
      type: 'ok',
      payer,
      settle: async () => ({
        header: encodePayment({ success: true, network: matched.network }),
        result: { success: true },
      }),
    }
  }

  const facilitator = new Facilitator(opts.facilitator ?? { url: DEFAULT_FACILITATOR_URL })
  const verified = await facilitator.verify(payment, matched)
  if (!verified.isValid) {
    return {
      type: 'paymentRequired',
      response: paymentRequiredResponse(
        requirements,
        verified.invalidReason ?? 'Payment verification failed',
      ),
    }
  }

  const payer = (verified.payer ?? payment.payload.authorization.from) as Address

  return {
    type: 'ok',
    payer,
    settle: async () => {
      const result = await facilitator.settle(payment, matched)
      return {
        header: encodePayment({
          success: result.success,
          transaction: result.transaction,
          network: result.network ?? matched.network,
          errorReason: result.errorReason,
          payer,
        }),
        result,
      }
    },
  }
}

function buildRequirements(request: Request, opts: RouteGateOptions): PaymentRequirement[] {
  const networks = Array.isArray(opts.network) ? opts.network : [opts.network ?? 'base']
  const atomic = usdToAtomic(opts.price)
  const resource = opts.resource ?? request.url

  return networks.map((network) => ({
    scheme: 'exact',
    network,
    asset: opts.asset ?? usdcAddress(network),
    maxAmountRequired: atomic,
    payTo: opts.recipient,
    description: opts.description,
    resource,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 600,
    extra: { name: 'USD Coin', version: '2' },
  }))
}

function paymentRequiredResponse(
  accepts: PaymentRequirement[],
  error?: string,
): Response {
  const body: PaymentRequiredResponse = { x402Version: 1, accepts, ...(error ? { error } : {}) }
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  })
}

export { Facilitator, DEFAULT_FACILITATOR_URL } from './facilitator.js'

/** Canonical Pantessa earn-side ingestion endpoint. Canonical origin only —
 *  `fetch` drops auth headers across a redirect, so an apex or pre-rebrand
 *  host here fails silently instead of erroring. */
export const DEFAULT_RECEIPTS_URL = 'https://www.pantessa.com/api/mcp/receipts'

export interface ReportUsageOptions {
  /** Your Pantessa API key (`yf_…`) — attributes the receipt to your account. */
  apiKey: string
  /** Your server's slug on pantessa.com (the one you claimed). */
  mcp: string
  /** Price of the call in USD. */
  amountUsd: number | string
  /** The paying agent's wallet, if known. */
  payer?: string
  /** The tool / route that was called (display). */
  tool?: string
  /** Settlement network, e.g. `'base'`. */
  network?: string
  /** On-chain settlement tx hash, if known. */
  txHash?: string
  /** Override the ingestion endpoint (defaults to {@link DEFAULT_RECEIPTS_URL}). */
  url?: string
  /** Abort the report after this many ms (default 5000). */
  timeoutMs?: number
}

/**
 * Report one paid call your MCP served to your Pantessa dashboard — the earn-side
 * mirror of the agent's ledger sync.
 *
 * Fire-and-forget by design: it **never throws** and resolves to `false` on any
 * failure, so it can't break or slow the request it follows. Call it AFTER
 * settlement and DON'T `await` it on the hot path. On serverless (Vercel/Workers)
 * hand the returned promise to `ctx.waitUntil(...)` so it isn't dropped when the
 * function suspends. Resolves `true` on a 2xx.
 */
export async function reportUsage(opts: ReportUsageOptions): Promise<boolean> {
  const url = opts.url ?? DEFAULT_RECEIPTS_URL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        mcp: opts.mcp,
        amountUsd: typeof opts.amountUsd === 'string' ? Number(opts.amountUsd) : opts.amountUsd,
        payer: opts.payer,
        tool: opts.tool,
        network: opts.network,
        txHash: opts.txHash,
      }),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false // earnings telemetry — never surface an error to the caller
  } finally {
    clearTimeout(timer)
  }
}
