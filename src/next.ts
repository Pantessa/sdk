import { gate, type RouteGateOptions } from './server.js'

export type NextRouteHandler = (
  request: Request,
  context?: unknown,
) => Promise<Response> | Response

/**
 * Wrap a Next.js App Router route handler with an x402 paywall.
 *
 * @example
 * ```ts
 * // app/api/premium/route.ts
 * import { withPayment } from 'pantessa/next'
 *
 * export const GET = withPayment(
 *   { price: '0.01', recipient: '0xYourAddress', network: 'base' },
 *   async () => Response.json({ secret: 'gm' })
 * )
 * ```
 */
export function withPayment(
  options: RouteGateOptions,
  handler: NextRouteHandler,
): NextRouteHandler {
  return async function paywalled(request, context) {
    const result = await gate(request, options)
    if (result.type === 'paymentRequired') return result.response

    const response = await handler(request, context)

    try {
      const { header } = await result.settle()
      const merged = new Response(response.body, response)
      merged.headers.set('X-PAYMENT-RESPONSE', header)
      return merged
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Payment settlement failed', detail: String(err) }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  }
}

export { gate } from './server.js'
export type { RouteGateOptions } from './server.js'
