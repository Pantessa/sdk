import { describe, it, expect, vi } from 'vitest'
import type { WalletClient } from 'viem'
// Imports BOTH names on purpose: the call sites still written as `yeetful(`
// exercise the deprecated back-compat alias, so a broken alias fails CI.
import { pantessa, yeetful, GrantError, type GrantPolicy, type Receipt } from './agent.js'

// A wallet stub: createPaymentClient only needs `account` + `signTypedData`.
const wallet = {
  account: { address: '0x1111111111111111111111111111111111111111' },
  signTypedData: vi.fn(async () => ('0x' + '11'.repeat(65)) as `0x${string}`),
} as unknown as WalletClient

const PAYTO = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// base64(JSON) settle response so the SDK can extract a tx hash.
function settleHeader(transaction: string): string {
  return Buffer.from(JSON.stringify({ success: true, transaction })).toString('base64')
}

/**
 * Mock fetch: a request WITHOUT an X-PAYMENT header gets a 402 challenge for
 * `priceAtomic` USDC; the retry WITH the header settles 200.
 */
function mockFetch(priceAtomic = '10000') {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const hasPayment = new Headers(init?.headers).has('X-PAYMENT')
    if (!hasPayment) {
      return new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'base',
              asset: USDC,
              maxAmountRequired: priceAtomic,
              payTo: PAYTO,
              maxTimeoutSeconds: 600,
              extra: { name: 'USD Coin', version: '2' },
            },
          ],
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-payment-response': settleHeader('0xabc') },
    })
  }) as typeof fetch
  return { fn, calls }
}

const HOST = 'tripadvisor.x402.paysponge.com'
const URL_OK = `https://${HOST}/api/v1/location/search?searchQuery=tokyo`

function grant(over: Partial<GrantPolicy> = {}): GrantPolicy {
  return { allow: [HOST], perCallUsd: 0.05, perDayUsd: 2, ...over }
}

describe('pantessa/agent', () => {
  it('pays an allowed call within budget and tracks spend + receipt', async () => {
    const f = mockFetch('10000') // $0.01
    const receipts: Receipt[] = []
    const pay = pantessa({ wallet, grant: grant(), fetch: f.fn, onReceipt: (r) => { receipts.push(r) } })

    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
    expect(pay.spentTodayUsd()).toBeCloseTo(0.01)
    expect(pay.remainingTodayUsd()).toBeCloseTo(1.99)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ host: HOST, amountUsd: 0.01, ok: true, txHash: '0xabc', note: 'settled' })
    expect(f.calls).toHaveLength(2) // 402 challenge + paid retry
  })

  it('blocks a host not on the allowlist without any network call', async () => {
    const f = mockFetch()
    const pay = pantessa({ wallet, grant: grant(), fetch: f.fn })
    await expect(pay('https://evil.com/x')).rejects.toMatchObject({
      name: 'GrantError',
      code: 'NOT_ALLOWED',
    })
    expect(f.calls).toHaveLength(0)
  })

  it('blocks a call above the per-call cap', async () => {
    const f = mockFetch('10000') // $0.01
    const pay = pantessa({ wallet, grant: grant({ perCallUsd: 0.005 }), fetch: f.fn })
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_PER_CALL' })
    expect(pay.spentTodayUsd()).toBe(0)
  })

  it('blocks once the daily budget is exhausted', async () => {
    const f = mockFetch('10000') // $0.01
    const pay = pantessa({ wallet, grant: grant({ perDayUsd: 0.015 }), fetch: f.fn })
    await pay(URL_OK) // 0.01 ok
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' }) // 0.02 > 0.015
    expect(pay.spentTodayUsd()).toBeCloseTo(0.01)
  })

  it('blocks an expired grant', async () => {
    const f = mockFetch()
    const pay = pantessa({ wallet, grant: grant({ expiresAt: Date.now() - 1000 }), fetch: f.fn })
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'EXPIRED' })
  })

  it('GrantError is the documented type', () => {
    const e = new GrantError('NOT_ALLOWED', 'x')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('NOT_ALLOWED')
  })
})

describe('hosted-ledger sync', () => {
  const LEDGER = 'https://yeetful.test'
  const KEY = 'yf_' + 'a'.repeat(64)

  /** Delegates paid-host calls to mockFetch; captures ledger POSTs → 201. */
  function withLedger(payFetch: typeof fetch) {
    const posts: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/api/agent/policy')) {
        // No per-key budget configured for these tests.
        return new Response(JSON.stringify({ error: 'no budget' }), { status: 404 })
      }
      if (url.startsWith(LEDGER)) {
        posts.push({
          url,
          auth: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        })
        return new Response(JSON.stringify({ id: 'led_1' }), { status: 201 })
      }
      return payFetch(input, init)
    }) as typeof fetch
    return { fn, posts }
  }

  it('POSTs settled receipts to the grant ledger with Bearer auth', async () => {
    const f = mockFetch('10000') // $0.01
    const l = withLedger(f.fn)
    const pay = pantessa({
      wallet,
      grant: grant({ id: 'grant123' }),
      fetch: l.fn,
      apiKey: KEY,
      ledgerUrl: LEDGER,
    })
    await pay(URL_OK)
    await pay.flushLedger()

    expect(l.posts).toHaveLength(1)
    expect(l.posts[0]!.url).toBe(`${LEDGER}/api/grants/grant123/ledger`)
    expect(l.posts[0]!.auth).toBe(`Bearer ${KEY}`)
    expect(l.posts[0]!.body).toMatchObject({
      host: HOST,
      amountUsd: 0.01,
      ok: true,
      txHash: '0xabc',
      note: 'settled',
    })
  })

  it('syncs denials too (the audit trail includes refusals)', async () => {
    const f = mockFetch()
    const l = withLedger(f.fn)
    const pay = pantessa({
      wallet,
      grant: grant({ id: 'grant123' }),
      fetch: l.fn,
      apiKey: KEY,
      ledgerUrl: LEDGER,
    })
    await expect(pay('https://evil.com/x')).rejects.toMatchObject({ code: 'NOT_ALLOWED' })
    await pay.flushLedger()

    expect(l.posts).toHaveLength(1)
    expect(l.posts[0]!.body).toMatchObject({ host: 'evil.com', amountUsd: 0, ok: false, note: 'NOT_ALLOWED' })
  })

  it('does not sync without apiKey or grant.id; flushLedger is a no-op', async () => {
    const f = mockFetch('10000')
    const l = withLedger(f.fn)
    const noKey = yeetful({ wallet, grant: grant({ id: 'grant123' }), fetch: l.fn, ledgerUrl: LEDGER })
    await noKey(URL_OK)
    await noKey.flushLedger()

    const warned: string[] = []
    const noId = yeetful({
      wallet,
      grant: grant(),
      fetch: l.fn,
      apiKey: KEY,
      ledgerUrl: LEDGER,
      onEvent: (m) => { warned.push(m) },
    })
    await noId(URL_OK)
    await noId.flushLedger()

    expect(l.posts).toHaveLength(0)
    expect(warned.some((m) => m.includes('grant.id'))).toBe(true)
  })

  it('a failing ledger endpoint never breaks payments or later syncs', async () => {
    const f = mockFetch('10000')
    let failures = 0
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/api/agent/policy')) return new Response('{}', { status: 404 })
      if (url.startsWith(LEDGER)) {
        failures++
        if (failures === 1) throw new Error('network down')
        return new Response('{}', { status: 201 })
      }
      return f.fn(input, init)
    }) as typeof fetch
    const pay = pantessa({
      wallet,
      grant: grant({ id: 'grant123' }),
      fetch: flaky,
      apiKey: KEY,
      ledgerUrl: LEDGER,
    })
    const r1 = await pay(URL_OK) // sync throws — payment unaffected
    const r2 = await pay(URL_OK) // chain recovered, second sync lands
    await pay.flushLedger()
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(failures).toBe(2)
  })
})

describe('x402 v2 challenges (CAIP-2 networks, `amount`, PAYMENT-SIGNATURE)', () => {
  /**
   * Mock fetch shaped like TripAdvisor's live paysponge gateway (2026-06):
   * x402Version 2, prices in `amount`, an EVM entry on "eip155:8453" plus a
   * Solana entry the client must skip, the discovery doc mirrored in the
   * `payment-required` response header, and settlement reported in
   * `payment-response` (no X- prefix).
   */
  function mockFetchV2(priceAtomic = '10000') {
    const challenge = {
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: `https://${HOST}/api/v1/location/search`,
        description: 'Service: Tripadvisor',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: priceAtomic,
          asset: USDC,
          payTo: PAYTO,
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
        },
        {
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          amount: priceAtomic,
          asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          payTo: '9246XrsAEKH6hAyEQe5PvdpUL1p5Ktj9c7ySnwQn6ois',
          maxTimeoutSeconds: 300,
          extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' },
        },
      ],
      extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' } } } },
    }
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
    const paymentHeaders: string[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const sig = headers.get('PAYMENT-SIGNATURE')
      if (!sig) {
        expect(headers.has('X-PAYMENT')).toBe(false)
        return new Response(JSON.stringify(challenge), {
          status: 402,
          headers: { 'content-type': 'application/json', 'payment-required': b64(challenge) },
        })
      }
      paymentHeaders.push(sig)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'payment-response': b64({ success: true, transaction: '0xv2tx' }),
        },
      })
    }) as typeof fetch
    return { fn, paymentHeaders }
  }

  it('pays a v2 challenge: picks the EVM entry, sends the PAYMENT-SIGNATURE envelope', async () => {
    const f = mockFetchV2('10000') // $0.01
    const receipts: Receipt[] = []
    const pay = pantessa({ wallet, grant: grant(), fetch: f.fn, onReceipt: (r) => { receipts.push(r) } })

    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
    expect(pay.spentTodayUsd()).toBeCloseTo(0.01)
    expect(receipts[0]).toMatchObject({ host: HOST, amountUsd: 0.01, ok: true, txHash: '0xv2tx', note: 'settled' })

    expect(f.paymentHeaders).toHaveLength(1)
    const envelope = JSON.parse(Buffer.from(f.paymentHeaders[0]!, 'base64').toString('utf8'))
    expect(envelope.x402Version).toBe(2)
    expect(envelope.accepted).toMatchObject({ network: 'eip155:8453', amount: '10000' })
    expect(envelope.resource).toMatchObject({ url: `https://${HOST}/api/v1/location/search` })
    expect(envelope.payload.authorization).toMatchObject({ value: '10000', to: PAYTO })
    expect(typeof envelope.payload.signature).toBe('string')
  })

  it('enforces grant caps against the v2 `amount` field', async () => {
    const f = mockFetchV2('100000') // $0.10 > $0.05 per-call cap
    const pay = pantessa({ wallet, grant: grant(), fetch: f.fn })
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_PER_CALL' })
    expect(pay.spentTodayUsd()).toBe(0)
  })

  it('a challenge with no priceable entry raises PaymentError, not a crash', async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            // amount missing entirely — the 0.3.0 crash case (BigInt(undefined))
            { scheme: 'exact', network: 'eip155:8453', asset: USDC, payTo: PAYTO },
          ],
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    const receipts: Receipt[] = []
    const pay = pantessa({ wallet, grant: grant(), fetch: fn, onReceipt: (r) => { receipts.push(r) } })

    await expect(pay(URL_OK)).rejects.toMatchObject({ name: 'PaymentError' })
    expect(receipts[0]).toMatchObject({ ok: false, note: 'payment-failed' })
  })
})

describe('per-key agent budget (/api/agent/policy)', () => {
  const LEDGER = 'https://yeetful.test'
  const KEY = 'yf_' + 'b'.repeat(64)

  type ServerAgent = {
    keyId: string
    label?: string | null
    perDayUsd: number | null
    spentTodayUsd: number
    remainingTodayUsd: number | null
    overBudget: boolean
  }

  function agentState(over: Partial<ServerAgent> = {}): ServerAgent {
    return {
      keyId: 'key_1',
      label: 'travel-bot',
      perDayUsd: 2,
      spentTodayUsd: 0,
      remainingTodayUsd: 2,
      overBudget: false,
      ...over,
    }
  }

  /**
   * Mock hosted origin: GET /api/agent/policy and POST …/ledger both read one
   * mutable `state.agent`; like the real API, a Bearer-authed ledger POST
   * echoes the updated { agent } in its response (unless echo: false).
   */
  function withPolicy(
    payFetch: typeof fetch,
    state: { agent: ServerAgent | null; echo?: boolean; policyDown?: boolean },
  ) {
    const policyGets: { auth: string | null }[] = []
    const posts: { body: Record<string, unknown> }[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === `${LEDGER}/api/agent/policy`) {
        policyGets.push({ auth: new Headers(init?.headers).get('authorization') })
        if (state.policyDown) return new Response('{}', { status: 503 })
        if (!state.agent) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify({ agent: state.agent, grant: {} }), { status: 200 })
      }
      if (url.startsWith(LEDGER)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        posts.push({ body })
        const a = state.agent
        if (a && body.ok === true && typeof body.amountUsd === 'number') {
          a.spentTodayUsd = +(a.spentTodayUsd + body.amountUsd).toFixed(6)
          if (a.perDayUsd != null) {
            a.remainingTodayUsd = Math.max(0, a.perDayUsd - a.spentTodayUsd)
            a.overBudget = a.spentTodayUsd >= a.perDayUsd
          }
        }
        const payload = state.echo === false ? { id: 'led_1' } : { id: 'led_1', agent: state.agent }
        return new Response(JSON.stringify(payload), { status: 201 })
      }
      return payFetch(input, init)
    }) as typeof fetch
    return { fn, policyGets, posts }
  }

  function budgetPay(fetchFn: typeof fetch, over: Partial<GrantPolicy> = {}, onEvent?: (m: string) => void) {
    return yeetful({
      wallet,
      grant: grant({ id: 'grant123', ...over }),
      fetch: fetchFn,
      apiKey: KEY,
      ledgerUrl: LEDGER,
      onEvent,
    })
  }

  it('loads the budget at startup with Bearer auth and pays when under it', async () => {
    const f = mockFetch('10000') // $0.01
    const state = { agent: agentState({ spentTodayUsd: 1, remainingTodayUsd: 1 }) }
    const l = withPolicy(f.fn, state)
    const pay = budgetPay(l.fn)

    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
    expect(l.policyGets).toHaveLength(1)
    expect(l.policyGets[0]!.auth).toBe(`Bearer ${KEY}`)

    await pay.flushLedger() // ledger echo + refresh reflect the synced $0.01
    expect(pay.agentBudget()).toMatchObject({ keyId: 'key_1', spentTodayUsd: 1.01, overBudget: false })
  })

  it('refuses pre-flight when the key is already over budget (OVER_AGENT_BUDGET, receipted)', async () => {
    const f = mockFetch('10000')
    const state = { agent: agentState({ spentTodayUsd: 2.5, remainingTodayUsd: 0, overBudget: true }) }
    const l = withPolicy(f.fn, state)
    const pay = budgetPay(l.fn)

    await expect(pay(URL_OK)).rejects.toMatchObject({ name: 'GrantError', code: 'OVER_AGENT_BUDGET' })
    expect(f.calls).toHaveLength(0) // denied before any call to the paid host

    await pay.flushLedger() // the denial lands in the hosted audit trail
    expect(l.posts[0]!.body).toMatchObject({ host: HOST, amountUsd: 0, ok: false, note: 'OVER_AGENT_BUDGET' })
  })

  it('refuses a call that would exceed remainingTodayUsd', async () => {
    const f = mockFetch('10000') // $0.01 > $0.005 remaining
    const state = { agent: agentState({ spentTodayUsd: 1.995, remainingTodayUsd: 0.005 }) }
    const l = withPolicy(f.fn, state)
    const pay = budgetPay(l.fn)

    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_AGENT_BUDGET' })
    expect(f.calls).toHaveLength(1) // 402 challenge read, payment never signed
    expect(pay.spentTodayUsd()).toBe(0)
  })

  it('counts settled-but-unsynced spend against the budget', async () => {
    const f = mockFetch('10000') // $0.01 per call
    const state = { agent: agentState({ perDayUsd: 0.015, remainingTodayUsd: 0.015 }), echo: false }
    const l = withPolicy(f.fn, state)
    const pay = budgetPay(l.fn)

    await pay(URL_OK) // $0.01 settled; server snapshot still says $0 spent
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_AGENT_BUDGET' })
  })

  it('receipt-sync responses keep the budget fresh (no policy re-fetch needed)', async () => {
    const f = mockFetch('10000')
    const state: { agent: ServerAgent | null; policyDown?: boolean } = {
      agent: agentState({ perDayUsd: 0.015, remainingTodayUsd: 0.015 }),
    }
    const l = withPolicy(f.fn, state)
    const pay = budgetPay(l.fn)

    await pay(URL_OK)
    state.policyDown = true // flushLedger's re-fetch fails; only the POST echo can update
    await pay.flushLedger()
    expect(pay.agentBudget()).toMatchObject({ spentTodayUsd: 0.01 })
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_AGENT_BUDGET' })
  })

  it('flushLedger re-fetches the budget (dashboard edits mid-run are picked up)', async () => {
    const f = mockFetch('10000')
    const state = { agent: agentState() }
    const l = withPolicy(f.fn, state)
    const pay = budgetPay(l.fn)

    await pay(URL_OK)
    state.agent = agentState({ perDayUsd: 0.005, spentTodayUsd: 0.01, remainingTodayUsd: 0, overBudget: true })
    await pay.flushLedger()
    expect(pay.agentBudget()?.overBudget).toBe(true)
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_AGENT_BUDGET' })
  })

  it('a key with no budget set enforces nothing', async () => {
    const f = mockFetch('10000')
    const state = { agent: agentState({ perDayUsd: null, remainingTodayUsd: null }) }
    const l = withPolicy(f.fn, state)
    const pay = budgetPay(l.fn)

    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
    expect(pay.agentBudget()).toMatchObject({ perDayUsd: null })
  })

  it('a failing policy endpoint never blocks payments (budgets are advisory)', async () => {
    const f = mockFetch('10000')
    const events: string[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/api/agent/policy')) throw new Error('network down')
      if (url.startsWith(LEDGER)) return new Response('{}', { status: 201 })
      return f.fn(input, init)
    }) as typeof fetch
    const pay = budgetPay(fn, {}, (m) => { events.push(m) })

    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
    expect(pay.agentBudget()).toBeNull()
    expect(events.some((m) => m.includes('agent policy fetch failed'))).toBe(true)
  })
})

describe('ledger sync redirect diagnosis', () => {
  it('names the redirect origin when a cross-origin hop strips the auth header', async () => {
    const f = mockFetch('10000')
    const events: string[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://yeetful.test')) {
        // Simulate fetch having followed apex → www and the Bearer being lost.
        const res = new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
        Object.defineProperty(res, 'redirected', { value: true })
        Object.defineProperty(res, 'url', { value: 'https://www.yeetful.test/api/grants/g1/ledger' })
        return res
      }
      return f.fn(input, init)
    }) as typeof fetch

    const pay = pantessa({
      wallet,
      grant: grant({ id: 'g1' }),
      fetch: fn,
      apiKey: 'yf_' + 'a'.repeat(64),
      ledgerUrl: 'https://yeetful.test',
      onEvent: (m) => { events.push(m) },
    })
    await pay(URL_OK)
    await pay.flushLedger()

    const hint = events.find((m) => m.includes('ledger sync → 401'))
    expect(hint).toContain('redirected to https://www.yeetful.test')
    expect(hint).toContain('set ledgerUrl')

    // The startup policy GET hit the same redirect — same diagnosis there.
    const policyHint = events.find((m) => m.includes('agent policy → 401'))
    expect(policyHint).toContain('set ledgerUrl')
  })
})

describe('org budget + remote kill switch (0.5)', () => {
  const LEDGER = 'https://yeetful.test'
  const KEY = 'yf_' + 'c'.repeat(64)

  type OrgState = { id: string; name?: string | null; perDayUsd: number | null; spentTodayUsd: number; overBudget: boolean }

  /**
   * Mock hosted origin for an ORG key: the policy GET and the ledger POST echo
   * both carry { agent, org, halted, haltReason } off one mutable `state`,
   * mirroring the real /api/agent/policy + sync echo. The per-key budget is
   * null here so only the org level (and the halt) can refuse.
   */
  function withOrgPolicy(
    payFetch: typeof fetch,
    state: { org: OrgState | null; halted?: boolean; haltReason?: string | null; policyDown?: boolean; echo?: boolean },
  ) {
    const posts: { body: Record<string, unknown> }[] = []
    const agent = { keyId: 'orgkey_1', label: 'org-runner', perDayUsd: null, spentTodayUsd: 0, remainingTodayUsd: null, overBudget: false }
    const snapshot = () => ({
      agent,
      org: state.org,
      halted: !!state.halted,
      haltReason: state.haltReason ?? null,
      grant: {},
    })
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === `${LEDGER}/api/agent/policy`) {
        if (state.policyDown) return new Response('{}', { status: 503 })
        return new Response(JSON.stringify(snapshot()), { status: 200 })
      }
      if (url.startsWith(LEDGER)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        posts.push({ body })
        if (state.org && body.ok === true && typeof body.amountUsd === 'number') {
          state.org.spentTodayUsd = +(state.org.spentTodayUsd + body.amountUsd).toFixed(6)
          if (state.org.perDayUsd != null) state.org.overBudget = state.org.spentTodayUsd >= state.org.perDayUsd
        }
        const payload = state.echo === false ? { id: 'led_1' } : { id: 'led_1', ...snapshot() }
        return new Response(JSON.stringify(payload), { status: 201 })
      }
      return payFetch(input, init)
    }) as typeof fetch
    return { fn, posts }
  }

  function orgPay(fetchFn: typeof fetch) {
    return yeetful({ wallet, grant: grant({ id: 'grant123' }), fetch: fetchFn, apiKey: KEY, ledgerUrl: LEDGER })
  }

  it('exposes the org budget and pays when under the org cap', async () => {
    const f = mockFetch('10000') // $0.01
    const l = withOrgPolicy(f.fn, { org: { id: 'org_1', name: 'Acme', perDayUsd: 25, spentTodayUsd: 7, overBudget: false } })
    const pay = orgPay(l.fn)

    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
    expect(pay.orgBudget()).toMatchObject({ id: 'org_1', perDayUsd: 25, overBudget: false })
    expect(pay.status()).toEqual({ halted: false, haltReason: null })
  })

  it('refuses pre-flight when the org is already over its cap (OVER_ORG_BUDGET, receipted)', async () => {
    const f = mockFetch('10000')
    const l = withOrgPolicy(f.fn, { org: { id: 'org_1', perDayUsd: 25, spentTodayUsd: 25, overBudget: true } })
    const pay = orgPay(l.fn)

    await expect(pay(URL_OK)).rejects.toMatchObject({ name: 'GrantError', code: 'OVER_ORG_BUDGET' })
    expect(f.calls).toHaveLength(0) // denied before the paid host
    await pay.flushLedger()
    expect(l.posts[0]!.body).toMatchObject({ host: HOST, amountUsd: 0, ok: false, note: 'OVER_ORG_BUDGET' })
  })

  it('refuses a call that would push the org over its remaining cap (in the price hook)', async () => {
    const f = mockFetch('10000') // $0.01 > $0.005 left
    const l = withOrgPolicy(f.fn, { org: { id: 'org_1', perDayUsd: 25, spentTodayUsd: 24.995, overBudget: false } })
    const pay = orgPay(l.fn)

    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_ORG_BUDGET' })
    expect(f.calls).toHaveLength(1) // 402 read, payment never signed
  })

  it('counts settled-but-unsynced org spend against the org cap', async () => {
    const f = mockFetch('10000') // $0.01 per call
    const l = withOrgPolicy(f.fn, { org: { id: 'org_1', perDayUsd: 0.015, spentTodayUsd: 0, overBudget: false }, echo: false })
    const pay = orgPay(l.fn)

    await pay(URL_OK) // $0.01 settled; server snapshot still says $0
    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'OVER_ORG_BUDGET' })
  })

  it('a paused agent key halts ALL payments (AGENT_PAUSED, no network, receipted)', async () => {
    const f = mockFetch('10000')
    const l = withOrgPolicy(f.fn, { org: null, halted: true, haltReason: 'AGENT_PAUSED' })
    const pay = orgPay(l.fn)

    await expect(pay(URL_OK)).rejects.toMatchObject({ name: 'GrantError', code: 'AGENT_PAUSED' })
    expect(f.calls).toHaveLength(0)
    expect(pay.status()).toEqual({ halted: true, haltReason: 'AGENT_PAUSED' })
    await pay.flushLedger()
    expect(l.posts[0]!.body).toMatchObject({ ok: false, note: 'AGENT_PAUSED' })
  })

  it('a frozen account halts ALL payments (ACCOUNT_FROZEN)', async () => {
    const f = mockFetch('10000')
    const l = withOrgPolicy(f.fn, { org: { id: 'org_1', perDayUsd: 25, spentTodayUsd: 0, overBudget: false }, halted: true, haltReason: 'ACCOUNT_FROZEN' })
    const pay = orgPay(l.fn)

    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'ACCOUNT_FROZEN' })
    expect(f.calls).toHaveLength(0)
  })

  it('resume clears the halt on the next policy refresh (reversible)', async () => {
    const f = mockFetch('10000')
    const state = { org: null as OrgState | null, halted: true, haltReason: 'AGENT_PAUSED' as string | null }
    const l = withOrgPolicy(f.fn, state)
    const pay = orgPay(l.fn)

    await expect(pay(URL_OK)).rejects.toMatchObject({ code: 'AGENT_PAUSED' })
    state.halted = false // resumed on the dashboard
    state.haltReason = null
    await pay.flushLedger() // re-fetches the policy
    expect(pay.status()).toEqual({ halted: false, haltReason: null })
    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
  })

  it('a failing policy endpoint degrades open (no org, not halted)', async () => {
    const f = mockFetch('10000')
    const l = withOrgPolicy(f.fn, { org: null, policyDown: true })
    const pay = orgPay(l.fn)

    const res = await pay(URL_OK)
    expect(res.status).toBe(200)
    expect(pay.orgBudget()).toBeNull()
    expect(pay.status()).toEqual({ halted: false, haltReason: null })
  })
})
