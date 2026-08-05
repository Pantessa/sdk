import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction, RequestHandler } from 'express'
import { gate, type RouteGateOptions } from './server.js'

declare module 'express-serve-static-core' {
  interface Request {
    x402?: { payer: string }
  }
}

/**
 * Express middleware that gates a route behind an x402 payment.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { paymentRequired } from 'pantessa/express'
 *
 * const app = express()
 * app.get(
 *   '/premium',
 *   paymentRequired({ price: '0.01', recipient: '0xYourAddress' }),
 *   (req, res) => res.json({ secret: 'gm', payer: req.x402?.payer })
 * )
 * ```
 */
export function paymentRequired(options: RouteGateOptions): RequestHandler {
  return async function middleware(
    req: ExpressRequest,
    res: ExpressResponse,
    next: NextFunction,
  ) {
    try {
      const result = await gate(toFetchRequest(req), options)

      if (result.type === 'paymentRequired') {
        const body = await result.response.text()
        res.status(402)
        result.response.headers.forEach((v, k) => res.setHeader(k, v))
        res.send(body)
        return
      }

      req.x402 = { payer: result.payer }

      // Settle once the response is being sent. We hook into `res.end` so that
      // userland handlers don't need to know about settlement.
      const end = res.end.bind(res) as typeof res.end
      let settled = false
      const settle = async () => {
        if (settled) return
        settled = true
        try {
          const { header } = await result.settle()
          if (!res.headersSent) res.setHeader('X-PAYMENT-RESPONSE', header)
        } catch (err) {
          if (!res.headersSent) {
            res.status(502).json({ error: 'Payment settlement failed', detail: String(err) })
          }
        }
      }
      ;(res as unknown as { end: typeof res.end }).end = ((...args: unknown[]) => {
        void settle().finally(() => end(...(args as Parameters<typeof res.end>)))
        return res
      }) as typeof res.end

      next()
    } catch (err) {
      next(err)
    }
  }
}

function toFetchRequest(req: ExpressRequest): Request {
  const protocol = req.protocol || 'http'
  const host = req.headers.host ?? 'localhost'
  const url = `${protocol}://${host}${req.originalUrl}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(','))
    else if (typeof v === 'string') headers.set(k, v)
  }
  return new Request(url, { method: req.method, headers })
}

export { gate } from './server.js'
export type { RouteGateOptions } from './server.js'
