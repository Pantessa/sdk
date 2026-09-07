# pantessa

**The Pantessa SDK.** Put the Pantessa agent on your own site — a chat that turns
a sentence like *"buy $10 of AAPL"* or *"stake 0.05 ETH with Lido"* into a
guarded, receipt-backed transaction the visitor signs with their own wallet, on
your page. Underneath it, the x402 primitives Pantessa runs on, so your agents
and services can pay and get paid per call.

```bash
npm install pantessa viem
```

> **Renamed from `yeetful`.** `npm i pantessa && npm rm yeetful`, swap the import
> specifier, done — every renamed export keeps its old name as a deprecated
> alias. The `yeetful` package is a frozen re-export and gets no further fixes.

- [Embed the chat](#embed-the-chat) — `pantessa/embed`, five lines, any site
- [No-code paths](#no-code-paths) — intent links, host buttons, deep links
- [Pay and get paid with x402](#pay-and-get-paid-with-x402) — gate a route, auto-pay a client, give an agent an expense account
- [API reference](#api-reference)

---

## What runs inside the embed

The chat is Pantessa's **native transaction layer**: a planner picks the shape of
the ask, a per-venue builder produces the exact calldata or typed data
(the model never writes an address or a byte of calldata), one shared guardrail
gate re-decodes and re-prices every artifact before it is offered, and the
visitor's wallet signs. Receipts land in the thread and in your dashboard.

What it builds today: Uniswap v3/v4 swaps and CoW orders, tokenized-stock trades
on Robinhood Chain, Aave supply/borrow/repay, Lido staking, Hyperliquid perps
with an autonomous stop-loss/take-profit guardian, NFT sells and buys on
OpenSea, cross-chain moves through NEAR Intents, funding plans when the money is
on the wrong chain, recurring buys (DCA), and multi-step jobs that chain all of
the above. Swaps carry a small venue-native fee (0.20% in the chat); everything else is free.
Details: [pantessa.com/docs/transactions](https://www.pantessa.com/docs/transactions)
· [the trust model](https://www.pantessa.com/docs/trust).

---

## Embed the chat

`pantessa/embed` drops the chat into any page as an iframe. Framework-agnostic,
dependency-free, browser-only — it never imports viem or the payment stack, so
it is safe to load on any host page. Scope it to up to four MCPs with `mcps`, or
run it on the default set.

### Plain script

```html
<div id="pantessa-chat" style="height: 640px"></div>
<script type="module">
  import { mountPantessaChat } from 'https://esm.sh/pantessa@^1/embed'

  const chat = mountPantessaChat({
    container: '#pantessa-chat',      // element or selector (inline mode)
    mcps: ['robinhood-free', 'uniswap-free'],
    key: 'yfe_…',                     // PUBLIC embed key (optional, see below)
    wallet: 'auto',                   // bridge window.ethereum (the default)
    theme: 'light',
    onEvent: (name, data) => console.log(name, data),
  })

  // any button on your page becomes an ask
  chat.sendPrompt('Buy $10 of AAPL on Robinhood Chain')
</script>
```

`mode: 'bubble'` floats a bottom-right launcher instead of filling a container.

### React

Mount once in an effect and destroy in its cleanup (StrictMode double-runs
effects in dev; `destroy()` makes that harmless).

```tsx
import { useEffect, useRef } from 'react'
import { mountPantessaChat, type Eip1193Provider, type PantessaChatHandle } from 'pantessa/embed'

export function PantessaChat({ provider }: { provider?: Eip1193Provider }) {
  const el = useRef<HTMLDivElement>(null)
  const chat = useRef<PantessaChatHandle | null>(null)

  useEffect(() => {
    chat.current = mountPantessaChat({
      container: el.current!,
      mcps: ['robinhood-free', 'uniswap-free'],
      wallet: provider ?? 'auto',
      theme: 'light',
    })
    return () => chat.current?.destroy()
  }, []) // once — see "one mount, any wallet" below

  return <div ref={el} style={{ height: 640 }} />
}
```

### Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `container` | `HTMLElement \| string` | — | Required for `mode: 'inline'`. The iframe fills it. |
| `mode` | `'inline' \| 'bubble'` | `'inline'` | Fill the container, or float a launcher + panel. |
| `mcps` | `string[]` | the default set | Directory slugs from [pantessa.com/servers](https://www.pantessa.com/servers), max 4. |
| `key` | `string` | — | Your **public** `yfe_` embed key. Attributes sessions to your account and bills house-model answers to your plan instead of each visitor's free tier. Safe in page source. |
| `wallet` | `'auto' \| Eip1193Provider \| false` | `'auto'` | Bridge the page's wallet into the chat. `'auto'` uses `window.ethereum`; pass a provider (wagmi, EIP-6963) to choose; `false` turns the bridge off. |
| `address` | `string` | — | Context-only address (what "my portfolio" means) for hosts that don't bridge a wallet. |
| `theme` | `'dark' \| 'light'` | `'dark'` | |
| `origin` | `string` | `https://www.pantessa.com` | Only for self-hosted or local builds of the chat. |
| `onEvent` | `(name, data) => void` | — | The event stream, below. |
| `onReady` | `() => void` | — | Fires once the iframe has mounted and the handshake completed. |
| `zIndex` | `number` | `2147483000` | Bubble mode stacking. |

The handle: `sendPrompt(text, { submit?: boolean })` (submit as the visitor's
message, or only prefill with `submit: false`), `setAddress(address | null)`,
`setTheme(theme)`, `open()` / `close()` (bubble), `destroy()`, and the raw
`iframe`. Calls made before `ready` are queued.

### Events

`onEvent` receives `turn` once per chat turn and `order-signed` when a CoW or
Hyperliquid order signs:

```ts
// name: 'turn'
{ outcome: 'answered' | 'tx-built' | 'signed' | 'settled' | 'clarify' | 'refused' | 'credit-gate' | 'error',
  artifact?: 'tx' | 'tx-chain' | 'job' | 'cow-order' | 'hl-order' | 'vote',
  valueUsd?: number,      // guardrail-priced notional
  txUrl?: string,         // explorer link when there is a receipt
  chainId?: number,
  jobId?: string }

// name: 'order-signed'
{ artifact: 'cow-order' | 'hl-order', valueUsd?: number, txUrl?: string }
```

That is enough for a host-side activity log or a connect → ask → build → sign
funnel without touching the chat's internals. With an embed key, the same
turns feed [your dashboard](https://www.pantessa.com/dashboard/embeds): money
moved, the funnel per page, and dead-end sessions with the verbatim asks.

### The wallet bridge

With `wallet` set, the SDK relays the host page's EIP-1193 provider into the
iframe over `postMessage`. The chat becomes really wallet-connected — swaps,
transactions, and orders sign through the visitor's own wallet, **prompting on
your page**, never inside the frame. There is no separate connect flow in the
embed.

Security model: the bridge grants the iframe the same dapp-level access your
page already has, nothing more. Relayed methods are a strict allowlist
(connect + sign: `eth_requestAccounts`, `personal_sign`, `eth_signTypedData_v4`,
`eth_sendTransaction`, `wallet_switchEthereumChain` / `wallet_addEthereumChain`;
plus read-only RPC such as `eth_call` and balance/gas/receipt lookups). Anything
else is refused with error `4200` without touching the provider. No key
material crosses the frame, and every signature pops the user's wallet UI for
explicit approval. The parent only accepts messages from the embed origin with
`source: 'yeetful-embed'` (a frozen wire identifier) and always posts with an
explicit `targetOrigin`, never `'*'`.

**One mount, any wallet.** `wallet` is captured at mount, and users pick a
wallet *after* the chat is on screen. Rather than remount (which drops the
conversation), hand the SDK a small EIP-1193 facade that forwards `request` to
whichever wallet is selected and emits `accountsChanged` / `chainChanged`
itself when the selection changes — the bridge re-announces and the chat
auto-connects. `setAddress` remains for context-only hosts.

### A complete host app

[agent-examples/agents/robinhood-desk](https://github.com/Pantessa/agent-examples/tree/main/agents/robinhood-desk)
is a standalone portfolio desk for tokenized stocks on Robinhood Chain: it
reads holdings and prices from the chain itself, every button is a
`sendPrompt`, the visitor's wallet signs on the host page through the bridge
(EIP-6963 discovery + the switching-provider pattern above), the activity log
is built from the `turn` events, and it ships a Content-Security-Policy and a
jsdom test of the wire.

If your app has a CSP, `frame-src https://www.pantessa.com` is the only line
the embed needs. Full contract (URL params, every postMessage payload):
[pantessa.com/docs/embed](https://www.pantessa.com/docs/embed).

---

## No-code paths

- **Intent links.** Mint a link that carries an ask —
  `https://www.pantessa.com/i/<slug>` — and share it anywhere. The visitor
  connects, the same guarded pipeline builds, they sign. Creators earn a share
  of the fee on every conversion. [pantessa.com/docs/links](https://www.pantessa.com/docs/links)
- **Host buttons.** A plain `<a>` to an intent link, styled — no script, no
  iframe. [pantessa.com/docs/host-buttons](https://www.pantessa.com/docs/host-buttons)
- **Deep links.** `https://www.pantessa.com/chat?mcps=robinhood-free&prompt=Buy%20%2410%20of%20AAPL`
  lands a visitor in the first-party chat with your MCP set active and the ask
  prefilled, never auto-sent.
- **The agent desk.** Give your own agent hands: an MCP door where an agent
  scans a wallet, plans, and hands the human a link to sign.
  [pantessa.com/docs/desk](https://www.pantessa.com/docs/desk)

---

## Pay and get paid with x402

[x402](https://www.x402.org) is HTTP `402 Payment Required` done properly: the
server quotes a price, the client signs a USDC authorization
([EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)) with a wallet, a
facilitator settles on-chain, and the request goes through. No accounts, no API
keys, gasless for the payer. Pantessa's paid MCP tools run on these primitives;
they are exported so yours can too. `viem` is a peer dependency.

### Gate a route

```ts
// Next.js App Router
import { withPayment } from 'pantessa/next'

export const GET = withPayment(
  { price: '0.01', recipient: '0xYourAddress', network: 'base' },
  async () => Response.json({ secret: 'gm' }),
)
```

```ts
// Express
import { paymentRequired } from 'pantessa/express'
app.get('/premium', paymentRequired({ price: '0.01', recipient: '0xYourAddress', network: 'base' }),
  (req, res) => res.json({ payer: req.x402?.payer }))
```

```ts
// Anywhere else (Hono, Bun, Workers, raw Node): a standard Request in,
// either a 402 Response or a settle() handle out.
import { gate } from 'pantessa/server'

const result = await gate(request, { price: '0.01', recipient: '0xYourAddress', network: 'base' })
if (result.type === 'paymentRequired') return result.response
const body = Response.json({ secret: 'gm' })
const { header } = await result.settle()
body.headers.set('X-PAYMENT-RESPONSE', header)
return body
```

Server options: `price` (USD), `recipient`, `network` (`base` · `base-sepolia` ·
`ethereum` · `optimism` · `arbitrum` · `polygon`, or an array to accept several),
`asset` (override USDC), `description`, `maxTimeoutSeconds` (600),
`facilitator` (`{ url, authHeader }`, or `false` to skip settlement in tests —
the default is the hosted facilitator). If your MCP is claimed on
pantessa.com, `reportUsage()` from `pantessa/server` is a fire-and-forget
earn-side receipt that puts each paid call on your dashboard.

### Auto-pay a client

```ts
import { createPaymentClient } from 'pantessa/client'

const pay = createPaymentClient({
  wallet,                        // any viem WalletClient
  maxAmountAtomic: 1_000_000n,   // never pay more than 1 USDC per call
  allowedNetworks: ['base'],
  onPaymentRequired: async (req) => true, // return false to cancel
})
const res = await pay('https://api.example.com/premium') // use exactly like fetch
```

### Give an agent an expense account

`pantessa/agent` wraps the client in a grant: an allowlist of hosts plus
per-call and per-day budgets, enforced **locally and before signing** — the
guardrail against runaway loops, bugs, and prompt-injected tool calls. Every
call, paid or refused, emits a receipt.

```ts
import { pantessa, GrantError } from 'pantessa/agent'

const pay = pantessa({
  wallet,
  grant: { allow: ['anthropic.yeetful.com'], perCallUsd: 0.05, perDayUsd: 2, expiresAt: '2026-12-31' },
  apiKey: process.env.PANTESSA_API_KEY, // optional yf_ key: sync receipts + enforce dashboard budgets
  onReceipt: (r) => console.log(r.host, `$${r.amountUsd}`, r.txHash ?? r.note),
})

try {
  const res = await pay('https://anthropic.yeetful.com/mcp')
} catch (e) {
  if (e instanceof GrantError) console.error(e.code)
  // NOT_ALLOWED | OVER_PER_CALL | BUDGET_EXCEEDED | EXPIRED | REVOKED
  // | OVER_AGENT_BUDGET | OVER_ORG_BUDGET | AGENT_PAUSED | ACCOUNT_FROZEN
}
```

With an `apiKey`, the SDK also mirrors what the dashboard says: the key's own
daily budget, the organization's budget above it, and the remote kill switch —
a paused agent or frozen account halts all payments until unfrozen.
`pay.agentBudget()`, `pay.orgBudget()`, `pay.status()`,
`pay.spentTodayUsd()`, `pay.remainingTodayUsd()` and `pay.flushLedger()`
(call it before a short-lived script exits) expose the state. Sync is
best-effort and never blocks a payment; `ledgerUrl` must be the canonical
origin (`https://www.pantessa.com`), because `fetch` drops `Authorization`
across a cross-origin redirect. This enforcement is in-process — right for
governing your own agents; for adversarial guarantees back the grant with an
on-chain Spend Permission. Policy details:
[pantessa.com/docs/spend-policy](https://www.pantessa.com/docs/spend-policy).

---

## API reference

### `pantessa/embed`

- `mountPantessaChat(options)` — mounts the chat iframe (inline or bubble) and returns a `PantessaChatHandle`: `sendPrompt` · `setAddress` · `setTheme` · `open` · `close` · `destroy` · `iframe`. Browser-only, zero deps.
- `DEFAULT_EMBED_ORIGIN`, `FIRST_PARTY_EMBED_ORIGINS` — the hosted origin and the closed set of first-party origins the parent accepts (the pre-rename origin redirects; the check survives it).
- Types: `PantessaChatOptions`, `PantessaChatHandle`, `Eip1193Provider`. Deprecated aliases: `mountYeetfulChat`, `YeetfulChatOptions`, `YeetfulChatHandle`.

### `pantessa/server`

- `gate(request, options)` — runtime-agnostic. Returns `{ type: 'paymentRequired', response }` or `{ type: 'ok', payer, settle }`.
- `reportUsage(options)` — fire-and-forget earn-side receipt. Never throws; resolves `true` on a 2xx.
- `Facilitator`, `DEFAULT_FACILITATOR_URL`, `DEFAULT_RECEIPTS_URL`.

### `pantessa/next` · `pantessa/express`

- `withPayment(options, handler)` — wraps a Next.js route handler.
- `paymentRequired(options)` — Express middleware; sets `req.x402.payer` after verification.

### `pantessa/client`

- `createPaymentClient(options)` — a `fetch`-compatible function that handles 402s.
- `signPayment(wallet, requirement)` — sign a payment payload by hand.
- `PaymentError` — thrown when the client declines to pay.

### `pantessa/agent`

- `pantessa(options)` (alias `yeetful`) — the grant-aware paid `fetch` with `spentTodayUsd` / `remainingTodayUsd` / `agentBudget` / `orgBudget` / `status` / `flushLedger`.
- `GrantError` — `.code` is one of the violation codes above.
- `DEFAULT_LEDGER_URL`.

### Helpers (top-level)

- `usdcAddress(network)` · `usdToAtomic(amount, decimals?)` · `USDC_DECIMALS` · `encodePayment` / `decodePayment`.

---

## Development

```bash
npm install
npm run build     # ESM + CJS + d.ts via tsup
npm run typecheck
npm test
```

Every PR that changes shipped code bumps `version` in `package.json` (and the
CHANGELOG) in the same PR. Releases are `npm run build && npm publish`.

## License

MIT © Pantessa
