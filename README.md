# pantessa

> **Renamed from `yeetful`.** Yeetful is now Pantessa. `npm i pantessa && npm rm yeetful`,
> swap the import specifier, and you're done — every renamed export keeps its old
> name as a deprecated alias. The `yeetful` package lives on as a thin re-export
> and will not get further fixes; upgrading also gets you the hosted defaults on
> the current domain and an embed origin check that survives the redirect.

**Spend-controlled [x402](https://www.x402.org) for AI agents.** Give an agent an *expense account* — an allowlist of endpoints plus per-call / per-day budgets — and let it pay any x402 service with no API keys. Enforcement is local and instant; every call emits a receipt. Built for [Pantessa](https://www.pantessa.com), MIT-licensed, works anywhere TypeScript does.

```bash
npm install pantessa viem
```

## Agent expense account

Wrap your agent's calls in one grant-aware `pay()`. It refuses anything off the allowlist or over budget **before** signing a payment — your guardrail against runaway loops, bugs, and prompt-injected tool calls.

```ts
import { pantessa, GrantError } from 'pantessa/agent'
import { createWalletClient, http } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const wallet = createWalletClient({
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chain: base,
  transport: http(),
})

const pay = pantessa({
  wallet,
  grant: {
    allow: ['tripadvisor.x402.paysponge.com', 'anthropic.yeetful.com'],
    perCallUsd: 0.05,
    perDayUsd: 2,
    expiresAt: '2026-12-31',
  },
  onReceipt: (r) => console.log(r.host, `$${r.amountUsd}`, r.txHash ?? r.note),
})

try {
  const res = await pay('https://tripadvisor.x402.paysponge.com/api/v1/location/search?searchQuery=tokyo')
  console.log(await res.json())
  console.log(`spent today: $${pay.spentTodayUsd()} / left: $${pay.remainingTodayUsd()}`)
} catch (e) {
  // GrantError.code: NOT_ALLOWED | OVER_PER_CALL | BUDGET_EXCEEDED | EXPIRED | REVOKED
  //   | OVER_AGENT_BUDGET | OVER_ORG_BUDGET | AGENT_PAUSED | ACCOUNT_FROZEN
  if (e instanceof GrantError) console.error(`blocked: ${e.code}`)
}
```

One grant authorizes **many** endpoints (the allowlist). Use `onReceipt` to stream the audit trail to your dashboard or the Pantessa control plane.

### Hosted-ledger sync

Mirror a grant you created at [pantessa.com](https://www.pantessa.com) and pass an API key (minted on the dashboard) — every receipt then syncs to your hosted ledger, so budgets and the audit feed include this agent's calls:

```ts
const pay = pantessa({
  wallet,
  grant: { id: 'your-grant-id', allow: [...], perCallUsd: 0.05, perDayUsd: 2 },
  apiKey: process.env.PANTESSA_API_KEY, // yf_…
})
// …
await pay.flushLedger() // before a short-lived script exits
```

Sync is best-effort and never blocks or fails a payment; denials are synced too (`ok: false` with the violation code).

> **`ledgerUrl` must be the canonical origin** (currently `https://www.pantessa.com`): `fetch` silently drops the `Authorization` header when it follows a cross-origin redirect such as apex → www. If sync or the policy fetch fails after a redirect, the `onEvent` log names the origin to use.

### Per-key agent budgets

On pantessa.com an agent **is** an API key — the dashboard's Agents tab gives each key a per-day USD budget and a spent-today meter. When you pass `apiKey`, the SDK fetches the key's policy (`GET /api/agent/policy`) before the first payment and **refuses to pay** once the key is over budget, or when a call's quoted price would exceed what's left today:

```ts
const pay = pantessa({ wallet, grant: { id: 'your-grant-id', ... }, apiKey: process.env.PANTESSA_API_KEY })

console.log(pay.agentBudget()) // { keyId, label, perDayUsd, spentTodayUsd, remainingTodayUsd, overBudget }
// over budget → pay() throws GrantError('OVER_AGENT_BUDGET') and syncs the
// denial receipt, so the refusal shows up in the dashboard audit trail.
```

Budgets are **advisory at the rails** — the agent pays from its own wallet, so this local refusal is the enforcement point. The snapshot stays fresh opportunistically: receipt-sync responses echo the updated budget, `flushLedger()` re-fetches the policy (picking up mid-run dashboard edits), and settled-but-unsynced spend is counted locally in between. If the policy can't be fetched at all, payments proceed under the grant alone.

> **Local vs. hard enforcement.** This SDK enforces the grant in-process — ideal for governing *your own* agents (runaway loops, bugs, injected tool calls). For adversarial guarantees, back the grant with an on-chain Coinbase **Spend Permission** so the wallet contract caps spend regardless of the SDK.

### Org budgets & remote pause (0.5)

If the key belongs to an **organization** on pantessa.com, the same `apiKey` flow adds two more controls — fetched from the policy, refreshed on every sync echo, and enforced locally just like the per-key budget:

- **Two-level budget.** The org has a daily USD cap *above* each key's own budget — summed across all the org's agents. A call that would breach it throws `GrantError('OVER_ORG_BUDGET')`. Over **either** level stops the payment.
- **Remote kill switch.** An admin can freeze a single agent (`AGENT_PAUSED`) or the whole expense account (`ACCOUNT_FROZEN`) from the dashboard. The SDK halts **all** payments while frozen — a hard stop above any budget arithmetic — and resumes automatically on the next policy refresh once unfrozen.

```ts
const pay = pantessa({ wallet, grant: { id: 'your-org-grant-id', ... }, apiKey: process.env.PANTESSA_API_KEY })

pay.orgBudget() // { id, name, perDayUsd, spentTodayUsd, overBudget } | null (null for personal keys)
pay.status()    // { halted, haltReason: 'AGENT_PAUSED' | 'ACCOUNT_FROZEN' | null }

// org over its cap   → GrantError('OVER_ORG_BUDGET')
// agent/account paused → GrantError('AGENT_PAUSED' | 'ACCOUNT_FROZEN'), before any network call
```

Same honesty as budgets: pause is advisory at the rails for SDK agents paying their own wallet (this local refusal is the enforcement); the chats Pantessa itself executes are hard-stopped server-side, and on-chain hard stops arrive with Spend Permissions.

---

## Low-level x402 primitives

The agent wrapper is built on a full x402 toolkit you can use directly:

```ts
// Server — gate a route for 1¢ USDC
import { withPayment } from 'pantessa/next'

export const GET = withPayment(
  { price: '0.01', recipient: '0xYourAddress', network: 'base' },
  async () => Response.json({ secret: 'gm' })
)
```

```ts
// Client — auto-pay when a server returns 402 (no grant enforcement)
import { createPaymentClient } from 'pantessa/client'

const pay = createPaymentClient({ wallet })
const res = await pay('https://api.example.com/premium')
console.log(await res.json()) // → { secret: 'gm' }
```

---

## Why x402?

x402 is a reborn HTTP `402 Payment Required` — a protocol where servers quote a price, clients sign a stablecoin authorization, and a facilitator settles on-chain. No accounts, no Stripe dashboards, no webhook retries. Works on EVM chains today (USDC on Base, Optimism, Arbitrum, Polygon, Ethereum).

**You get:**
- Per-request pricing for any API — LLM calls, data feeds, premium endpoints, MCP tools.
- One-sentence paywalls for agents: an LLM with a wallet can now pay for what it uses.
- Instant settlement on L2 — no chargebacks, no holds, no 30-day payout delay.

---

## Install

```bash
npm install pantessa viem
# or
pnpm add pantessa viem
# or
yarn add pantessa viem
```

`viem` is a peer dependency so the SDK stays light and stays in sync with whatever viem version your app already uses.

---

## Quickstart

### Server: gate a route

#### Next.js (App Router)

```ts
// app/api/premium/route.ts
import { withPayment } from 'pantessa/next'

export const GET = withPayment(
  {
    price: '0.01',                        // USD
    recipient: '0xYourWalletAddress',     // gets paid
    network: 'base',                      // or ['base', 'optimism']
    description: 'Premium GM endpoint',
  },
  async (req) => {
    return Response.json({ message: 'gm, thanks for the cent' })
  }
)
```

#### Express

```ts
import express from 'express'
import { paymentRequired } from 'pantessa/express'

const app = express()

app.get(
  '/premium',
  paymentRequired({
    price: '0.01',
    recipient: '0xYourWalletAddress',
    network: 'base',
  }),
  (req, res) => {
    res.json({ message: 'gm', payer: req.x402?.payer })
  }
)

app.listen(3000)
```

#### Anywhere else (Hono, Bun, Cloudflare Workers, raw Node)

Use the runtime-agnostic `gate()` helper. Give it a standard `Request`, get back either a 402 `Response` or a `settle()` handle.

```ts
import { gate } from 'pantessa/server'

export default {
  async fetch(request: Request) {
    const result = await gate(request, {
      price: '0.01',
      recipient: '0xYourWalletAddress',
      network: 'base',
    })

    if (result.type === 'paymentRequired') return result.response

    // …do the paid work…
    const body = Response.json({ message: 'gm' })

    const { header } = await result.settle()
    body.headers.set('X-PAYMENT-RESPONSE', header)
    return body
  },
}
```

### Server: track earnings on your dashboard

Claimed your MCP on [pantessa.com](https://www.pantessa.com)? Report each paid call so your earnings — total, last 30 days, calls served, paying agents — show up on your dashboard. `reportUsage()` is **fire-and-forget**: it never throws and never blocks, so call it after `settle()` and don't await it on the hot path (on serverless, hand it to `ctx.waitUntil(...)`).

```ts
import { gate, reportUsage } from 'pantessa/server'

const { payer, settle } = /* …from gate() … */
const { header, result } = await settle()

// non-blocking — do NOT await on the request's critical path
reportUsage({
  apiKey: process.env.PANTESSA_API_KEY!, // a yf_… key from dashboard/keys
  mcp: 'your-server-slug',              // your slug on pantessa.com/servers/<slug>
  amountUsd: 0.01,
  payer,
  tool: 'list_proposals',
  network: 'base',
})
```

Full walk-through: [pantessa.com/docs/earn](https://www.pantessa.com/docs/earn).

### Client: auto-pay

```ts
import { createPaymentClient } from 'pantessa/client'

const pay = createPaymentClient({
  wallet,                           // any viem WalletClient
  maxAmountAtomic: 1_000_000n,      // cap: 1 USDC per call
  allowedNetworks: ['base'],        // only pay on Base
  onPaymentRequired: async (req) => {
    console.log(`Pay ${req.maxAmountRequired} to ${req.payTo}?`)
    return true                     // return false to cancel
  },
})

// Use exactly like fetch.
const res = await pay('https://api.example.com/premium')
```

---

## Configuration

### `RouteGateOptions` — server

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `price` | `string \| number` | **required** | USD amount, e.g. `'0.01'`. Converted to USDC atomic units. |
| `recipient` | `Address` | **required** | Address that receives the payment. |
| `network` | `X402Network \| X402Network[]` | `'base'` | Networks you'll accept. Multi-chain = multi-item discovery. |
| `asset` | `Address` | USDC for network | Override to use a different ERC-20. |
| `description` | `string` | — | Shown to the paying client. |
| `maxTimeoutSeconds` | `number` | `600` | Validity window of the signed authorization. |
| `facilitator` | `FacilitatorConfig \| false` | hosted facilitator | Pass `false` to skip on-chain settlement (testing only). |

Supported networks: `base`, `base-sepolia`, `ethereum`, `optimism`, `arbitrum`, `polygon`.

### `ClientOptions` — client

| Option | Type | Notes |
| --- | --- | --- |
| `wallet` | `WalletClient` | Any viem wallet capable of signing EIP-712 typed data. |
| `maxAmountAtomic` | `bigint` | Reject requirements above this cap — safety belt. |
| `allowedNetworks` | `X402Network[]` | Only pay on these networks. |
| `onPaymentRequired` | `(req) => boolean \| Promise<boolean>` | Approval hook; return `false` to cancel. |
| `fetch` | `typeof fetch` | Override the underlying fetch (e.g. for timeouts). |

---

## How it works

1. **Client requests** a paid resource normally.
2. **Server** responds with `402 Payment Required` and a JSON body listing acceptable requirements (network, asset, amount, recipient).
3. **Client** picks the cheapest requirement, signs an [EIP-3009 `TransferWithAuthorization`](https://eips.ethereum.org/EIPS/eip-3009) with the user's wallet, and retries the request with an `X-PAYMENT` header (base64 JSON).
4. **Server** hands the signed payload to a facilitator which `verify`s the signature and `settle`s the transfer on-chain.
5. **Server** runs the handler and returns the response with an `X-PAYMENT-RESPONSE` header containing the transaction hash.

The signing is gasless for the payer — the facilitator broadcasts the transfer and picks up gas.

---

## Facilitators

By default the SDK uses the hosted facilitator at `https://facilitator.yeetful.com`. Override it anywhere you configure the server:

```ts
withPayment(
  {
    price: '0.01',
    recipient: '0xYourAddress',
    facilitator: {
      url: 'https://your-facilitator.example.com',
      authHeader: 'Bearer your-token',
    },
  },
  handler,
)
```

Pass `facilitator: false` to skip verification and settlement entirely — only useful for local testing.

---

## Advanced

### Accept multiple networks

```ts
withPayment(
  {
    price: '0.01',
    recipient: '0xYourAddress',
    network: ['base', 'optimism', 'arbitrum'],
  },
  handler,
)
```

Clients automatically pick the cheapest network they're configured to use.

### Sign a payment manually

```ts
import { signPayment } from 'pantessa/client'

const payment = await signPayment(wallet, {
  scheme: 'exact',
  network: 'base',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
  maxAmountRequired: '10000', // 0.01 USDC
  payTo: '0xRecipient',
})
```

### Use with AI agents / MCP tools

x402 is a natural fit for agent tooling — drop `withPayment` in front of any MCP tool endpoint and agents with wallets can pay per-call. This SDK is what powers paid tools on [Pantessa](https://www.pantessa.com).

---

## Drive a job with your own signer

`pantessa/desk` is the other half of the agent story: not "pay for a call", but
**"hand me a signer and it gets done."**

Pantessa's [agent desk](https://www.pantessa.com/docs/desk) compiles a plain
sentence into a guarded, multi-leg **job** owned by the wallet that will sign
it. Deterministic builders write every transaction — no model writes calldata —
each leg is guard-checked fail-closed and spend-policy gated at build *and* at
submit, and the wait legs between them verify arrival on-chain before the next
leg is built. **Round-trip across every settlement boundary, batched within
one.** Pantessa never holds your key.

```ts
import { openAndExecute, driveJob } from 'pantessa/desk'
import { privateKeyToAccount } from 'viem/accounts'

const signer = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`)
const base = 'https://www.pantessa.com'

// 1. Open an intent, take a funding route if the wallet is short, consent.
const { jobId, token, steps } = await openAndExecute({
  base,
  ask: 'Fund Hyperliquid with $15 from Base, then 2x long $12 of HYPE',
  signer,
  agentKey: process.env.DESK_KEY!,   // your desk identity
  agent: 'my-agent',                 // the byline on your track record
})

// 2. Drive it. One call signs every leg the runner offers, in order.
const out = await driveJob({
  base, jobId, token, signer,
  rpc: { 8453: process.env.BASE_RPC! },        // your provider (recommended)
  onLeg: (leg) => console.log(`leg ${leg.seq} · ${leg.kind} · ${leg.summary}`),
  onDone: (seq, r) => console.log(`  ✓ ${r.txHash ?? r.detail}`),
})
console.log(out.status) // 'done' | 'failed' | 'canceled'
```

**Try it without signing anything.** `dryRun: true` classifies each leg and
returns before the first broadcast — and if the wallet can't fund a leg, it
comes back with the guard's own sentence instead of spinning:

```ts
const dry = await driveJob({ base, jobId, token, signer, dryRun: true })
dry.legs      // [{ seq: 0, kind: 'txChain', chainId: 8453, summary: 'Swap 1 USDC → ~0.000366 ETH …' }]
dry.withheld  // { seq: 0, reason: 'Nothing to sign yet: this would spend 1 USDC on Base and the wallet holds 0 …' }
```

### What a leg can be

`driveJob` handles every shape the runner offers, so you don't have to:

| `leg.kind` | What it is | What the loop does |
| --- | --- | --- |
| `tx` | one EVM transaction | sign → broadcast → wait for a **successful** receipt → complete with the hash |
| `txChain` | N transactions in order (approve → swap) | runs them in order, re-quoting any step that carries a `refresh` recipe right before it is signed; completes with the last hash |
| `hlAction` | a Hyperliquid L1 action | signs the typed data **verbatim** and submits it through the relay (a one-time builder-fee cap and a leverage pre-step are signed first when the build carries them) |
| `hlBatch` | several L1 actions inside one settlement boundary | signs **every member in one pass**, then submits them in order; a member that fails stops the batch and its partial result is still posted, so the runner re-offers from exactly there |
| `order` | a non-Hyperliquid EIP-712 order (CoW, Seaport) | **refused by name** — it has its own submit endpoint and prerequisites, so this loop will not guess at it |
| `wait` | a settlement wait | left to the runner, which verifies arrival on-chain; the loop polls |

Anything else fails **closed** with a named `DeskError` rather than guessing at
a signature. Every failure this module raises is a `DeskError` with a `code`
(`http`, `desk-refused`, `unsupported-leg`, `no-rpc`, `broadcast`, `withheld`,
`stale`, `max-legs`, …) — a raw `fetch` error never escapes.

### Notes that matter

- **Bring your own RPC.** `DEFAULT_RPC` holds each chain's own public endpoint
  as a convenience, deliberately never publicnode (its free tier refuses
  `eth_getTransactionReceipt`, and this loop polls receipts). Pass `rpc` in
  production; Robinhood Chain's public RPC rate-limits per IP.
- **A Hyperliquid nonce stays signable for 90 seconds** (`HL_NONCE_LIFE_MS`),
  and a batch shares the clock of its earliest member. A build whose window has
  lapsed is **rebuilt, never re-signed**: the loop asks the runner for a fresh
  one (`POST /api/jobs/{id}/retry`) and picks the new build up on the next poll.
- **Completion is advancement, not proof.** The runner re-verifies on-chain, so
  a result the chain disagrees with fails the job closed one leg later. The
  loop never posts a completion for a reverted transaction.
- `openAndExecute` needs a **sequenced** ask (fund → wait → act). A single-step
  ask is refused by name — use the sign-link path (`broker_handoff`) for those.
- **Cadence follows the wire.** Left alone, the loop polls every
  `BUILD_RETRY_MS` while a leg builds and every `SETTLE_RETRY_MS` while one
  settles; pass `pollMs` to force your own. `headers` are stamped on every call
  it makes (the Jobs API, the re-quote route, the relay) — that is where a
  drill puts `x-yf-internal-run`.
- The consent `openAndExecute` signs is a plain `personal_sign` over one
  readable sentence, carrying an `Issued at:` line the desk checks both ways.
  It costs no gas and moves nothing by itself; every leg still needs this
  wallet's own signature. A desk that predates the freshness line gets the
  original text on one automatic retry, so the mismatch never reads as a
  wallet failure.
- **The types are a mirror.** `DeskLegKind`, `DeskLegView`, `DeskLegResult`,
  `DeskNext`, `legViewOf` and `deskNextOf` are line-for-line copies of
  `lib/desk-wire.ts` in the Pantessa app, and the app's harness pins the two in
  sync — so what this SDK calls a leg is exactly what the desk calls one.


---

## Embed the chat

`pantessa/embed` drops the Pantessa chat into any webpage as an iframe — zero
dependencies, framework-agnostic, browser-only (it never imports viem or the
payment stack). Scope it to up to 4 MCPs with `mcps`, or float it as a
bottom-right bubble with `mode: 'bubble'`.

Plain script tag:

```html
<div id="pantessa-chat" style="height: 560px"></div>
<script type="module">
  import { mountPantessaChat } from 'https://esm.sh/pantessa/embed'

  const chat = mountPantessaChat({
    container: '#pantessa-chat',        // element or selector (inline mode)
    mcps: ['uniswap-free'],            // scope the chat to these MCPs (≤4)
    wallet: 'auto',                    // bridge window.ethereum into the chat (the default)
    theme: 'dark',
    onEvent: (name, data) => console.log('pantessa event', name, data),
  })
  // later: chat.sendPrompt('…') · chat.destroy()
</script>
```

**The host-wallet bridge** (`wallet`, new in 0.9): the SDK relays the host
page's EIP-1193 provider into the iframe over `postMessage`, so the embedded
chat can request accounts, read balances, and pop the user's own wallet for
signatures — no separate connect flow inside the embed. The host page already
holds that provider, so the bridge grants the embed the same dapp-level access
the host has, nothing more: every signature/transaction still opens the USER's
wallet UI for approval, relayed reads are restricted to a strict method
allowlist, and no private key material ever crosses the frame. `'auto'`
(default) uses `window.ethereum` when present; pass a provider (e.g. from
wagmi) or `false` to turn the bridge off. `setAddress` remains for
context-only hosts that just want to tell the chat which address to talk
about without wiring a wallet.

React (your own trading UI), mounting in a `useEffect` and syncing the
connected account:

```tsx
import { useEffect, useRef } from 'react'
import { mountPantessaChat, type PantessaChatHandle } from 'pantessa/embed'

function PantessaChat({ address }: { address?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const chat = useRef<PantessaChatHandle | null>(null)

  useEffect(() => {
    chat.current = mountPantessaChat({
      container: ref.current!,
      mcps: ['cow-swap'],
      address,               // initial context goes in the URL
      theme: 'dark',
    })
    return () => chat.current?.destroy()
  }, []) // mount once

  useEffect(() => {
    chat.current?.setAddress(address ?? null) // queued until the embed is ready
  }, [address])

  return <div ref={ref} style={{ height: 560 }} />
}
```

Users usually pick a wallet *after* the chat is on screen, and `wallet` is
captured at mount. Hand the SDK a provider that survives that — a small
EIP-1193 facade that forwards `request` to whichever wallet is selected and
emits `accountsChanged` / `chainChanged` itself when the selection changes —
rather than remounting (a remount drops the conversation). The
[robinhood-desk example](https://github.com/Pantessa/agent-examples/tree/main/agents/robinhood-desk)
does exactly this (EIP-6963 discovery included) and is a complete host app:
holdings read from the chain, every button a `sendPrompt`, an activity log
built from the `onEvent` stream, a real CSP, and a jsdom test of the wire.

`onEvent(name, data)` receives `turn` once per chat turn —
`{ outcome, artifact?, valueUsd?, txUrl?, chainId? }`, outcomes `answered ·
tx-built · signed · settled · clarify · refused · credit-gate · error` — and
`order-signed` when a CoW / Hyperliquid order signs. Enough for a host-side
funnel without touching the chat's internals.

`mountPantessaChat(options)` returns a handle: `{ iframe, setAddress, setTheme,
sendPrompt, open, close, destroy }`. `open`/`close` drive the bubble panel
(no-ops inline); `sendPrompt(text)` injects a prompt as the user's message —
wire it to host CTAs like an "ask about this order" button (pass
`{ submit: false }` to only prefill the input); `destroy` removes all DOM
nodes and listeners. Security: the parent only accepts `postMessage` events
from the embed origin with `source: 'yeetful-embed'`, and always posts back
with an explicit `targetOrigin` (never `'*'`).

---

## API reference

### `pantessa/server`

- `gate(request, options)` — runtime-agnostic. Returns `{ type: 'paymentRequired', response }` or `{ type: 'ok', payer, settle }`.
- `reportUsage(options)` — fire-and-forget earn-side receipt to your Pantessa dashboard. Never throws; resolves `true` on a 2xx.
- `Facilitator` — thin wrapper around verify/settle HTTP endpoints.
- `DEFAULT_FACILITATOR_URL` — the hosted facilitator URL.
- `DEFAULT_RECEIPTS_URL` — the hosted earn-side ingestion URL.

### `pantessa/next`

- `withPayment(options, handler)` — wraps a Next.js route handler.

### `pantessa/express`

- `paymentRequired(options)` — returns an Express `RequestHandler`. Sets `req.x402.payer` after successful verification.

### `pantessa/client`

- `createPaymentClient(options)` — returns a `fetch`-compatible function that handles 402s automatically.
- `signPayment(wallet, requirement)` — sign a payment payload by hand.
- `PaymentError` — thrown when the client declines to pay.

### `pantessa/embed`

- `mountPantessaChat(options)` — mounts the Pantessa chat iframe (inline or bubble); returns a `PantessaChatHandle` (`setAddress` / `setTheme` / `sendPrompt` / `open` / `close` / `destroy`). Browser-only, zero deps. `options.wallet: 'auto' | Eip1193Provider | false` (default `'auto'`) bridges the host page's wallet provider into the chat — allowlisted EIP-1193 methods are relayed over `postMessage`; signatures/txs always pop the user's own wallet UI.

### `pantessa/desk`

- `driveJob(options)` — poll a Pantessa job and sign every leg it offers with your own signer (`tx` / `txChain` incl. re-quotes / `hlAction` / `hlBatch`), completing each one; resolves when the job is `done` / `failed` / `canceled`. `dryRun: true` classifies and stops before the first broadcast.
- `openAndExecute(options)` — `broker_open` → pick an option (default: the first funding route when the wallet is short, else proceed) → consent `personal_sign` → `broker_execute`; returns `{ intentId, jobId, token, steps }`.
- `deskCall(base, tool, args)` — call one desk MCP tool over plain JSON-RPC (the desk is stateless Streamable HTTP: no `initialize`, no session header).
- `legViewOf(step)` / `deskNextOf(job)` — the mirror of the app's `lib/desk-wire.ts`: classify a raw Jobs-API step into a `DeskLegView`, or answer "what should I do right now" for a whole job.
- `HL_DOMAIN_CHAIN_ID`, `HL_NONCE_LIFE_MS`, `LEG_OFFER_TTL_MS`, `BUILD_RETRY_MS`, `SETTLE_RETRY_MS` — the wire's own constants, by name.
- `deskExecuteConsentMessage(intentId, wallet)` — the exact consent bytes the desk recovers.
- `firstFundableOption(options, plan)` — the default option picker.
- `DeskError` / `DEFAULT_RPC`.

### Helpers

- `usdcAddress(network)` — canonical USDC contract for a supported network.
- `usdToAtomic(amount, decimals?)` — safe USD → atomic-units conversion.
- `encodePayment` / `decodePayment` — base64 JSON codec for headers.

---

## Development

```bash
npm install
npm run build     # bundles ESM + CJS + d.ts via tsup
npm run typecheck
npm test
```

To publish:

```bash
npm run build
npm publish
```

---

## License

MIT © Pantessa
