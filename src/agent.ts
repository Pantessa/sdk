/**
 * pantessa/agent — the "agent expense account."
 *
 * Wrap your agent's HTTP calls in a single grant-aware `pay()`. Before any x402
 * payment is signed it enforces a spend grant — an allowlist of hosts plus
 * per-call / per-day / lifetime USD caps and an expiry — then pays via the
 * standard x402 client and emits a receipt for every call.
 *
 * One grant authorizes MANY endpoints (the allowlist). It's a guardrail for
 * your own agents (runaway loops, bugs, prompt-injected tool calls) and the
 * receipt feed behind budgets + audit. Enforcement here is local + instant;
 * for hard, adversarial guarantees back the grant with an on-chain Spend
 * Permission (the wallet contract caps spend regardless of this SDK).
 *
 * @example
 * ```ts
 * import { pantessa } from 'pantessa/agent'
 *
 * const pay = pantessa({
 *   wallet,                                   // viem WalletClient
 *   grant: {
 *     id: 'cmbq…',                            // hosted grant id (pantessa.com)
 *     allow: ['tripadvisor.x402.paysponge.com', 'anthropic.yeetful.com'],
 *     perCallUsd: 0.05,
 *     perDayUsd: 2,
 *     expiresAt: '2026-12-31',
 *   },
 *   apiKey: process.env.PANTESSA_API_KEY,     // yf_… → receipts sync to your dashboard
 *   onReceipt: (r) => console.log(r.host, r.amountUsd, r.txHash),
 * })
 *
 * const res = await pay('https://tripadvisor.x402.paysponge.com/api/v1/location/search?searchQuery=tokyo')
 * // throws GrantError on NOT_ALLOWED / OVER_PER_CALL / BUDGET_EXCEEDED /
 * // EXPIRED / OVER_AGENT_BUDGET (the key's per-day budget) and — for an org
 * // key (0.5) — OVER_ORG_BUDGET (the org's daily cap, the level above) plus
 * // the remote kill switch AGENT_PAUSED / ACCOUNT_FROZEN. All fetched from
 * // /api/agent/policy, refreshed on every receipt sync, and enforced here.
 * ```
 */

import type { WalletClient } from 'viem'
import { createPaymentClient, PaymentError, requirementAtomicAmount } from './client.js'
import { decodePayment } from './utils.js'
import type { PaymentRequirement, SettleResult, X402Network } from './types.js'

export type GrantViolation =
  | 'EXPIRED'
  | 'REVOKED'
  | 'NOT_ALLOWED'
  | 'OVER_PER_CALL'
  | 'BUDGET_EXCEEDED'
  | 'OVER_AGENT_BUDGET'
  // 0.5 — the org level of the two-level budget + the remote kill switch.
  | 'OVER_ORG_BUDGET'
  | 'AGENT_PAUSED'
  | 'ACCOUNT_FROZEN'

/** The remote kill switch (pantessa.com): a reversible freeze that halts ALL
 * payments. AGENT_PAUSED = this key; ACCOUNT_FROZEN = the whole expense
 * account. Surfaced on the policy + every receipt-sync echo. */
export type HaltReason = 'AGENT_PAUSED' | 'ACCOUNT_FROZEN'

export class GrantError extends Error {
  constructor(
    public code: GrantViolation,
    message: string,
  ) {
    super(message)
    this.name = 'GrantError'
  }
}

/** A scoped spend authorization (mirrors the hosted SpendGrant). */
export interface GrantPolicy {
  /** Optional id of the hosted grant this mirrors. */
  id?: string
  /** Exact hostnames this grant may pay (e.g. "tripadvisor.x402.paysponge.com"). */
  allow: string[]
  perCallUsd: number
  perDayUsd: number
  /** Optional lifetime cap across the life of this client instance. */
  totalUsd?: number | null
  /** Unix ms, ISO string, or Date. Omit for no expiry. */
  expiresAt?: number | string | Date
  /** 'active' | 'revoked'. Defaults to active. */
  status?: string
}

/**
 * The hosted per-key budget for this agent (an agent IS an API key on
 * pantessa.com). Fetched from `GET {ledgerUrl}/api/agent/policy` with Bearer
 * auth and echoed back on every receipt-sync response. Budgets are advisory
 * at the rails — the agent pays from its own wallet — so this SDK is the
 * enforcement point: it refuses to pay once the key is over budget.
 */
export interface AgentBudget {
  /** Id of the API key (the agent identity) on pantessa.com. */
  keyId: string
  /** Human label the key was minted with. */
  label?: string | null
  /** Per-day USD budget for this key; null = no budget set (no enforcement). */
  perDayUsd: number | null
  /** USD this key has spent today per the hosted ledger. */
  spentTodayUsd: number
  remainingTodayUsd: number | null
  overBudget: boolean
}

/**
 * The org level of the two-level budget (0.5). When an agent's key belongs to
 * an organization, its policy carries the ORG's daily cap — summed across ALL
 * the org's keys — above this key's own budget. Over EITHER level = stop.
 * Present only for org keys; null for personal keys. Same advisory-at-the-rails
 * model as the per-key budget: the SDK is the enforcement point.
 */
export interface OrgBudget {
  /** Id of the organization on pantessa.com. */
  id: string
  /** Org name, when the policy includes it. */
  name?: string | null
  /** Org-wide per-day USD cap; null = no org cap (per-key budgets govern). */
  perDayUsd: number | null
  /** USD the whole org has spent today per the hosted ledger. */
  spentTodayUsd: number
  remainingTodayUsd?: number | null
  overBudget: boolean
}

/** The remote halt state (kill switch) from the policy / sync echo. */
export interface HaltStatus {
  halted: boolean
  haltReason: HaltReason | null
}

/** A single authorization decision — the audit trail + x402 receipt. */
export interface Receipt {
  host: string
  amountUsd: number
  ok: boolean
  txHash?: string
  /** "settled" on success, or the GrantViolation code on a denial. */
  note: string
  ts: number
}

export interface AgentOptions {
  /** viem WalletClient that signs the EIP-3009 payment. */
  wallet: WalletClient
  /** The spend grant to enforce. */
  grant: GrantPolicy
  /** Underlying fetch (defaults to global fetch). */
  fetch?: typeof fetch
  /** Restrict payments to specific networks (defaults to all). */
  allowedNetworks?: X402Network[]
  /** Called after every decision — wire this to your ledger / dashboard. */
  onReceipt?: (receipt: Receipt) => void | Promise<void>
  /** Human-readable progress logging. */
  onEvent?: (message: string) => void
  /**
   * Pantessa API key (`yf_…`, minted at pantessa.com while signed in). Together
   * with `grant.id` it turns on hosted-ledger sync: every receipt is POSTed to
   * `{ledgerUrl}/api/grants/{grant.id}/ledger` with Bearer auth, so the
   * dashboard's budgets/audit trail include this agent's calls. Sync is
   * best-effort and never blocks or fails a payment.
   *
   * The key also carries a per-day budget set on the dashboard's Agents tab.
   * With `apiKey`, the SDK loads it from `GET {ledgerUrl}/api/agent/policy`
   * before the first payment and refuses to pay (`OVER_AGENT_BUDGET`) once
   * the key is over budget — the budget is advisory at the rails (the agent
   * pays from its own wallet), so this local refusal IS the enforcement.
   * If the policy can't be fetched, payments proceed under the grant alone.
   */
  apiKey?: string
  /**
   * Base URL of the hosted ledger. Defaults to {@link DEFAULT_LEDGER_URL}.
   * Must be the CANONICAL origin (www, current domain) — fetch silently
   * drops the Authorization header when it follows a cross-origin redirect.
   */
  ledgerUrl?: string
}

export interface PayFn {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
  /** USD spent under this grant since UTC midnight (this client instance). */
  spentTodayUsd(): number
  /** USD remaining in today's budget. */
  remainingTodayUsd(): number
  /** USD spent over the life of this client instance. */
  spentTotalUsd(): number
  /**
   * Last-known per-key budget from pantessa.com — null without `apiKey` or
   * until the policy loads. Kept fresh by receipt-sync responses and
   * `flushLedger()`.
   */
  agentBudget(): AgentBudget | null
  /**
   * Last-known ORG budget from pantessa.com (0.5) — null for personal keys, or
   * without `apiKey` / until the policy loads. Kept fresh the same way as
   * `agentBudget()`.
   */
  orgBudget(): OrgBudget | null
  /**
   * Last-known remote halt state (0.5): the kill switch. `{ halted: false }`
   * until the policy loads; flips when the key/account is paused on
   * pantessa.com (refreshed on every sync echo + `flushLedger()`).
   */
  status(): HaltStatus
  /**
   * Resolves once every hosted-ledger sync issued so far has settled (no-op
   * without `apiKey`). Await this before a short-lived script exits so the
   * last receipts aren't dropped with the process. Also re-fetches the
   * per-key budget so a dashboard edit mid-run is picked up.
   */
  flushLedger(): Promise<void>
}

function expiryMs(expiresAt: GrantPolicy['expiresAt']): number {
  if (expiresAt == null) return Infinity
  if (expiresAt instanceof Date) return expiresAt.getTime()
  if (typeof expiresAt === 'number') return expiresAt
  const t = new Date(expiresAt).getTime()
  return Number.isNaN(t) ? Infinity : t
}

function utcDayIndex(ms: number): number {
  return Math.floor(ms / 86_400_000)
}

function hostOf(input: string | URL | Request): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Pull the settlement tx hash from the settle header, if present
 * (`PAYMENT-RESPONSE` on x402 v2, `X-PAYMENT-RESPONSE` on v1). */
function txHashOf(res: Response): string | undefined {
  const header = res.headers.get('payment-response') ?? res.headers.get('x-payment-response')
  if (!header) return undefined
  try {
    return decodePayment<SettleResult>(header).transaction
  } catch {
    return undefined
  }
}

/**
 * Hosted ledger + policy origin. MUST be the canonical origin: `fetch` drops
 * the Authorization header when it follows a cross-origin redirect, so an
 * apex or pre-rebrand host here silently disables budget enforcement and
 * ledger sync rather than erroring.
 */
export const DEFAULT_LEDGER_URL = 'https://www.pantessa.com'

/**
 * Create a grant-aware paid `fetch`. Enforces the grant locally before signing
 * any x402 payment, pays with the wallet, and emits a receipt per call.
 */
export function pantessa(options: AgentOptions): PayFn {
  const { wallet, grant, onReceipt, onEvent } = options
  const log = onEvent ?? (() => {})

  let spentToday = 0
  let spentTotal = 0
  let dayIndex = utcDayIndex(Date.now())

  // ── Hosted-ledger sync (optional): receipts → POST /api/grants/:id/ledger ──
  const ledgerBase = (options.ledgerUrl ?? DEFAULT_LEDGER_URL).replace(/\/+$/, '')
  const ledgerEndpoint =
    options.apiKey && grant.id ? `${ledgerBase}/api/grants/${grant.id}/ledger` : null
  if (options.apiKey && !grant.id) {
    log('hosted-ledger sync disabled: grant.id is not set (use the id of your pantessa.com grant)')
  }
  const ledgerFetch = options.fetch ?? globalThis.fetch
  // fetch silently DROPS the Authorization header when it follows a
  // cross-origin redirect (e.g. apex → www) — surface the real cause.
  const redirectHint = (res: Response) =>
    res.redirected
      ? ` (request was redirected to ${new URL(res.url).origin}, which strips the auth header — set ledgerUrl to that origin)`
      : ''

  // ── Hosted policy (optional): GET /api/agent/policy with the key ──
  // Carries the per-key budget, the ORG budget (0.5), and the kill-switch halt
  // (0.5). Enforced HERE — all advisory at the rails (the agent pays from its
  // own wallet), so this SDK's local refusal IS the enforcement.
  const policyEndpoint = options.apiKey ? `${ledgerBase}/api/agent/policy` : null
  let agent: AgentBudget | null = null
  let org: OrgBudget | null = null
  let halt: HaltStatus = { halted: false, haltReason: null }
  // Settled spend the server snapshot can't know about yet (receipts sync
  // asynchronously) — counted against each budget so it binds between syncs.
  let agentUnsyncedUsd = 0
  let orgUnsyncedUsd = 0
  /** Apply a policy/echo body's org + halt fields (shared by both refreshers). */
  const applyOrgAndHalt = (body: { org?: OrgBudget | null; halted?: boolean; haltReason?: HaltReason | null }) => {
    if ('org' in body) {
      org = body.org ?? null
      orgUnsyncedUsd = 0
    }
    if ('halted' in body) {
      halt = { halted: !!body.halted, haltReason: body.haltReason ?? null }
    }
  }
  const refreshPolicy = async (): Promise<void> => {
    if (!policyEndpoint) return
    try {
      const res = await ledgerFetch(policyEndpoint, {
        headers: { authorization: `Bearer ${options.apiKey}` },
      })
      if (!res.ok) {
        log(`agent policy → ${res.status}${redirectHint(res)}`)
        return
      }
      const body = (await res.json()) as
        | { agent?: AgentBudget; org?: OrgBudget | null; halted?: boolean; haltReason?: HaltReason | null }
        | null
      if (!body) return
      if (body.agent) {
        agent = body.agent
        agentUnsyncedUsd = 0
      }
      applyOrgAndHalt(body)
    } catch (err) {
      log(`agent policy fetch failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  // Load the policy before the first payment; a failed load is logged and
  // payments proceed under the grant alone (degrade open).
  const policyReady = refreshPolicy()

  // A chain (not fire-and-forget) so receipts land in order and flushLedger()
  // can await them; one failed POST is logged and never poisons the chain.
  let ledgerChain: Promise<void> = Promise.resolve()
  const sync = (r: Receipt) => {
    if (!ledgerEndpoint) return
    ledgerChain = ledgerChain
      .then(async () => {
        const res = await ledgerFetch(ledgerEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            host: r.host,
            amountUsd: r.amountUsd,
            ok: r.ok,
            txHash: r.txHash,
            note: r.note,
          }),
        })
        if (!res.ok) {
          log(`ledger sync → ${res.status} for ${r.host}${redirectHint(res)}`)
          return
        }
        // Receipt-sync responses echo the key's budget, the org budget, and
        // the halt state — opportunistic refresh. The snapshot includes the
        // receipt just written (and every earlier synced one, each already
        // subtracted on its own response), so only this receipt's amount
        // leaves each unsynced bucket.
        const body = (await res.json().catch(() => null)) as
          | { agent?: AgentBudget; org?: OrgBudget | null; halted?: boolean; haltReason?: HaltReason | null }
          | null
        if (!body) return
        if (body.agent) {
          agent = body.agent
          if (r.ok) agentUnsyncedUsd = Math.max(0, agentUnsyncedUsd - r.amountUsd)
        }
        if ('org' in body) {
          org = body.org ?? null
          if (r.ok) orgUnsyncedUsd = Math.max(0, orgUnsyncedUsd - r.amountUsd)
        }
        if ('halted' in body) {
          halt = { halted: !!body.halted, haltReason: body.haltReason ?? null }
        }
      })
      .catch((err) => {
        log(`ledger sync failed for ${r.host}: ${err instanceof Error ? err.message : err}`)
      })
  }

  const emit = (r: Receipt) => {
    sync(r)
    void Promise.resolve(onReceipt?.(r)).catch(() => {})
  }
  const deny = (host: string, code: GrantViolation, msg: string): never => {
    emit({ host, amountUsd: 0, ok: false, note: code, ts: Date.now() })
    log(`✗ ${host} — ${code}: ${msg}`)
    throw new GrantError(code, msg)
  }

  const pay = async function pay(
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    // The per-key budget must be known before the first payment (no-op after).
    await policyReady

    // Roll the daily budgets at UTC midnight.
    const today = utcDayIndex(Date.now())
    if (today !== dayIndex) {
      dayIndex = today
      spentToday = 0
      // The server's "today" rolled too — clear the stale daily fields and
      // re-fetch the truth in the background.
      if (agent) {
        agent = {
          ...agent,
          spentTodayUsd: 0,
          remainingTodayUsd: agent.perDayUsd,
          overBudget: agent.perDayUsd != null && agent.perDayUsd <= 0,
        }
      }
      if (org) {
        org = {
          ...org,
          spentTodayUsd: 0,
          remainingTodayUsd: org.perDayUsd,
          overBudget: org.perDayUsd != null && org.perDayUsd <= 0,
        }
      }
      agentUnsyncedUsd = 0
      orgUnsyncedUsd = 0
      void refreshPolicy()
    }

    const host = hostOf(input)

    // ── Pre-flight policy (no network): status → expiry → allowlist → halt → budgets ─
    if ((grant.status ?? 'active') === 'revoked') deny(host, 'REVOKED', 'grant is revoked')
    if (Date.now() > expiryMs(grant.expiresAt)) deny(host, 'EXPIRED', 'grant has expired')
    if (!grant.allow.map((h) => h.toLowerCase()).includes(host)) {
      deny(host, 'NOT_ALLOWED', `${host} is not in this grant's allowlist`)
    }
    // Kill switch (0.5): a remote freeze halts ALL payments, above any budget.
    if (halt.halted) {
      const code: GrantViolation = halt.haltReason === 'ACCOUNT_FROZEN' ? 'ACCOUNT_FROZEN' : 'AGENT_PAUSED'
      deny(
        host,
        code,
        code === 'ACCOUNT_FROZEN'
          ? 'the expense account is frozen on pantessa.com — resume it to pay'
          : `this agent key${agent?.label ? ` "${agent.label}"` : ''} is paused on pantessa.com — resume it to pay`,
      )
    }
    if (agent?.overBudget) {
      deny(
        host,
        'OVER_AGENT_BUDGET',
        `agent key${agent.label ? ` "${agent.label}"` : ''} is over its $${agent.perDayUsd}/day budget ($${agent.spentTodayUsd.toFixed(2)} spent today)`,
      )
    }
    if (org?.overBudget) {
      deny(
        host,
        'OVER_ORG_BUDGET',
        `org${org.name ? ` "${org.name}"` : ''} is over its $${org.perDayUsd}/day cap ($${org.spentTodayUsd.toFixed(2)} spent today across all its agents)`,
      )
    }

    // Price is only known from the 402 challenge — check caps in the hook,
    // which runs after the challenge is parsed and before the payment is signed.
    let pricedUsd = 0
    const client = createPaymentClient({
      wallet,
      fetch: options.fetch,
      allowedNetworks: options.allowedNetworks,
      // Per-call enforcement lives in the hook (not maxAmountAtomic) so an
      // over-cap call surfaces a clean GrantError instead of a filtered no-match.
      onPaymentRequired: (req: PaymentRequirement) => {
        // Version-agnostic price (v2 `amount`, v1 `maxAmountRequired`).
        // Selection already dropped unpriced entries, so this can't be null.
        const price = Number(requirementAtomicAmount(req) ?? 0n) / 1e6
        if (price > grant.perCallUsd) {
          deny(host, 'OVER_PER_CALL', `$${price.toFixed(4)} exceeds per-call cap $${grant.perCallUsd}`)
        }
        if (spentToday + price > grant.perDayUsd) {
          deny(host, 'BUDGET_EXCEEDED', `$${(spentToday + price).toFixed(2)} exceeds today's cap $${grant.perDayUsd}`)
        }
        if (grant.totalUsd != null && spentTotal + price > grant.totalUsd) {
          deny(host, 'BUDGET_EXCEEDED', `$${(spentTotal + price).toFixed(2)} exceeds lifetime cap $${grant.totalUsd}`)
        }
        if (agent && agent.perDayUsd != null) {
          const agentSpent = agent.spentTodayUsd + agentUnsyncedUsd
          if (agentSpent + price > agent.perDayUsd) {
            deny(host, 'OVER_AGENT_BUDGET', `$${price.toFixed(4)} would take this agent key to $${(agentSpent + price).toFixed(2)}, over its $${agent.perDayUsd}/day budget`)
          }
        }
        if (org && org.perDayUsd != null) {
          const orgSpent = org.spentTodayUsd + orgUnsyncedUsd
          if (orgSpent + price > org.perDayUsd) {
            deny(host, 'OVER_ORG_BUDGET', `$${price.toFixed(4)} would take the org to $${(orgSpent + price).toFixed(2)}, over its $${org.perDayUsd}/day cap`)
          }
        }
        pricedUsd = price
        return true
      },
    })

    let res: Response
    try {
      res = await client(input, init)
    } catch (err) {
      if (err instanceof GrantError) throw err // already denied + receipted
      // A rejection from the underlying client (e.g. no acceptable requirement).
      const note = err instanceof PaymentError ? 'payment-failed' : 'error'
      emit({ host, amountUsd: 0, ok: false, note, ts: Date.now() })
      throw err
    }

    // Settled (or a free, non-402 call where pricedUsd stayed 0).
    if (pricedUsd > 0) {
      spentToday += pricedUsd
      spentTotal += pricedUsd
      agentUnsyncedUsd += pricedUsd
      orgUnsyncedUsd += pricedUsd
    }
    const txHash = txHashOf(res)
    emit({ host, amountUsd: pricedUsd, ok: true, txHash, note: 'settled', ts: Date.now() })
    log(`✓ ${host} — $${pricedUsd.toFixed(4)} · today $${spentToday.toFixed(2)}/$${grant.perDayUsd}`)
    return res
  } as PayFn

  pay.spentTodayUsd = () => spentToday
  pay.remainingTodayUsd = () => Math.max(0, grant.perDayUsd - spentToday)
  pay.spentTotalUsd = () => spentTotal
  pay.agentBudget = () => agent
  pay.orgBudget = () => org
  pay.status = () => halt
  pay.flushLedger = async () => {
    await ledgerChain
    // Opportunistic re-sync: picks up a budget edited or a pause toggled on
    // the dashboard mid-run (org cap, per-key budget, and the halt state).
    await refreshPolicy()
  }
  return pay
}

/** @deprecated Renamed to {@link pantessa}. */
export const yeetful = pantessa
