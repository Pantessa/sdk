/**
 * Pantessa — spend-controlled x402 for AI agents.
 *
 * Published as `pantessa`; the pre-rebrand `yeetful` package is a deprecated
 * re-export of this one. Every renamed export keeps its old name as a
 * deprecated alias, so upgrading is a package swap, not a code change.
 *
 * Top-level entry re-exports the most common primitives. Use the subpath
 * entries for the agent expense account and framework-specific helpers:
 *
 *   - `pantessa/agent`   → grant-aware `pantessa()` paid fetch (expense account)
 *   - `pantessa/client`  → low-level client-side fetch wrapper
 *   - `pantessa/server`  → runtime-agnostic `gate()`
 *   - `pantessa/next`    → Next.js App Router `withPayment()`
 *   - `pantessa/express` → Express `paymentRequired()` middleware
 *   - `pantessa/embed`   → browser-only `mountPantessaChat()` chat-iframe helper
 */

export { pantessa, yeetful, DEFAULT_LEDGER_URL, GrantError } from './agent.js'
export type {
  AgentBudget,
  AgentOptions,
  GrantPolicy,
  GrantViolation,
  HaltReason,
  HaltStatus,
  OrgBudget,
  Receipt,
  PayFn,
} from './agent.js'

export {
  createPaymentClient,
  signPayment,
  signExactAuthorization,
  requirementAtomicAmount,
  PaymentError,
} from './client.js'
export type { ClientOptions } from './client.js'

export { gate, Facilitator, DEFAULT_FACILITATOR_URL } from './server.js'
export type { RouteGateOptions } from './server.js'

export { usdcAddress, usdToAtomic, encodePayment, decodePayment, USDC_DECIMALS } from './utils.js'

export type {
  PaymentPayload,
  PaymentEnvelopeV2,
  PaymentRequirement,
  PaymentRequiredResponse,
  FacilitatorConfig,
  VerifyResult,
  SettleResult,
  X402Network,
  X402Scheme,
  ExactEvmPayload,
} from './types.js'
