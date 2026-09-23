import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  DeskError,
  DEFAULT_RPC,
  DESK_LEG_RESULT_KEYS,
  LEG_RESULT_KEYS,
  deskCall,
  deskExecuteConsentMessage,
  driveJob,
  firstFundableOption,
  legViewOf,
  openAndExecute,
  type DeskLegResult,
  type DeskSigner,
  type JobStep,
} from './desk.js'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const account = privateKeyToAccount(KEY)

const ADDR = '0x2222222222222222222222222222222222222222'
const HASH_A = '0xaaaa000000000000000000000000000000000000000000000000000000000001'
const HASH_B = '0xbbbb000000000000000000000000000000000000000000000000000000000002'

/* ── a tiny fake Pantessa ─────────────────────────────────────────────── */

interface FakeOpts {
  /** One entry per poll: the job body the Jobs API answers with. */
  jobs: Array<Record<string, unknown>>
  hl?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }
  refresh?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }
  completeStatus?: number
  completeBody?: Record<string, unknown>
  retryStatus?: number
  retryBody?: Record<string, unknown>
}

function fakePantessa(opts: FakeOpts) {
  const calls: Array<{ url: string; body?: Record<string, unknown>; headers: Record<string, string> }> = []
  let poll = 0
  const doFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (url.includes('/api/tx/refresh')) {
      const r = opts.refresh?.(body!) ?? { status: 200, body: { tx: { to: ADDR, data: '0xfeed', value: '0', chainId: 8453 } } }
      return json(r.status, r.body)
    }
    if (url.includes('/api/hl/submit')) {
      const r = opts.hl?.(body!) ?? { status: 200, body: { status: 'filled', filled: { totalSz: '1', avgPx: '10' } } }
      return json(r.status, r.body)
    }
    if (url.includes('/complete')) {
      return json(opts.completeStatus ?? 200, opts.completeBody ?? { ok: true })
    }
    if (url.includes('/retry')) {
      return json(opts.retryStatus ?? 200, opts.retryBody ?? { ok: true })
    }
    if (url.includes('/api/jobs/')) {
      const next = opts.jobs[Math.min(poll, opts.jobs.length - 1)]
      poll++
      return json(200, { job: next })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
  return { doFetch, calls, pollCount: () => poll }
}

/** A signer that records what it was asked to do and never touches a chain. */
function fakeSigner(hashes: string[] = [HASH_A, HASH_B]) {
  const sent: Array<{ tx: Record<string, unknown>; chainId: number }> = []
  const typed: Array<Record<string, unknown>> = []
  const messages: string[] = []
  let i = 0
  const signer = {
    address: account.address,
    type: 'local' as const,
    async signMessage({ message }: { message: string }) {
      messages.push(message)
      return account.signMessage({ message })
    },
    async signTypedData(td: Record<string, unknown>) {
      typed.push(td)
      return '0x' + '11'.repeat(65)
    },
    // driveJob reaches sendTransaction through normalizeSigner's local branch,
    // which builds a WalletClient — so the tests patch that seam instead.
    __sent: sent,
  }
  // A deliberate stub, not a full viem Account — the contract stays honest.
  return { signer: signer as unknown as DeskSigner, sent, typed, messages, next: () => hashes[i++ % hashes.length]! }
}

/** driveJob's broadcast seam: stub viem so nothing leaves the process. */
function withStubbedChain(hashes: string[] = [HASH_A, HASH_B], receiptStatus: 'success' | 'reverted' = 'success') {
  const sent: Array<{ to: string; chainId: number }> = []
  let i = 0
  vi.doMock('viem', async (orig) => {
    const real = (await orig()) as Record<string, unknown>
    return {
      ...real,
      createWalletClient: (cfg: { chain: { id: number } }) => ({
        sendTransaction: async (tx: { to: string }) => {
          sent.push({ to: tx.to, chainId: cfg.chain.id })
          return hashes[i++ % hashes.length]!
        },
      }),
      createPublicClient: () => ({
        waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: receiptStatus, transactionHash: hash }),
      }),
    }
  })
  return { sent }
}

function job(status: string, steps: JobStep[], currentStep = 0, failReason?: string) {
  return { id: 'job_1', status, currentStep, steps, ...(failReason ? { failReason } : {}) }
}

const txStep = (seq = 0): JobStep => ({
  seq,
  kind: 'sign',
  status: 'offered',
  title: 'Bridge 12 USDC',
  builder: 'native-cross-chain',
  valueUsd: 12,
  artifact: { txRequest: { to: ADDR, data: '0xdead', value: '0', chainId: 8453 }, summary: 'Bridge 12 USDC from Base' },
})

const chainStep = (seq = 0, withRefresh = true): JobStep => ({
  seq,
  kind: 'sign',
  status: 'offered',
  title: 'Approve, then swap',
  builder: 'native-swap-uniswap',
  valueUsd: 25,
  artifact: {
    txChain: {
      summary: 'Approve USDC, then swap',
      steps: [
        { label: 'approve', title: 'Approve USDC', tx: { to: ADDR, data: '0x095ea7b3', value: '0', chainId: 8453 } },
        {
          label: 'swap',
          title: 'Swap USDC for ETH',
          tx: { to: ADDR, data: '0xstale', value: '0', chainId: 8453 },
          validUntil: Math.floor(Date.now() / 1000) + 300,
        },
      ],
      ...(withRefresh
        ? { refresh: { kind: 'uniswap-swap', stepIndex: 1, params: { sellToken: 'USDC', buyToken: 'ETH', amountHuman: '25', chainId: '8453' } } }
        : {}),
    },
    summary: 'Approve USDC, then swap',
  },
})

const hlStep = (seq = 0, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): JobStep => ({
  seq,
  kind: 'sign',
  status: 'offered',
  title: 'Long HYPE',
  builder: 'native-hl-exec',
  valueUsd: 12,
  artifact: {
    orderRequest: {
      protocol: 'hyperliquid',
      typedData: { domain: { chainId: 1337 }, types: { Agent: [] }, primaryType: 'Agent', message: { source: 'a', connectionId: '0x01' } },
      hl: {
        action: { type: 'order', orders: [{ a: 1, b: true, p: '10', s: '1', r: false, t: {} }], grouping: 'na' },
        nonce: Date.now(),
        isTestnet: false,
        expected: { coin: 'HYPE', kind: 'open', isBuy: true },
        ...extra,
      },
      ...top,
    },
    summary: 'Long $12 of HYPE',
  },
})

const waitStep = (seq: number): JobStep => ({ seq, kind: 'wait', status: 'running', title: 'Funds arrive on Arbitrum' })

/* ── legViewOfStep ────────────────────────────────────────────────────── */

describe('legViewOfStep', () => {
  it('reads a single transaction off txRequest, not tx', () => {
    const v = legViewOf(txStep())
    expect(v.kind).toBe('tx')
    expect(v.chainId).toBe(8453)
    expect(v.summary).toBe('Bridge 12 USDC from Base')
    expect(v.valueUsd).toBe(12)
  })

  it('reads `tx` as the documented alias of `txRequest` (the brief\'s C1 spelling)', () => {
    // The runner has always written `txRequest`; the squad brief said `tx`, so
    // lib/desk-wire accepts both and this mirror must agree with it exactly.
    const v = legViewOf({ seq: 0, kind: 'sign', status: 'offered', artifact: { tx: { to: ADDR, chainId: 8453 } } })
    expect(v.kind).toBe('tx')
    expect(v.chainId).toBe(8453)
  })

  it('reads a chain, its first chain id and its soonest deadline', () => {
    const v = legViewOf(chainStep())
    expect(v.kind).toBe('txChain')
    expect(v.chainId).toBe(8453)
    expect(v.staleAfterMs).toBeGreaterThan(200_000)
  })

  it('reads a Hyperliquid action as chain 1337 with the nonce window', () => {
    const v = legViewOf(hlStep())
    expect(v.kind).toBe('hlAction')
    expect(v.chainId).toBe(1337)
    expect(v.staleAfterMs).toBeGreaterThan(80_000)
    expect(v.staleAfterMs).toBeLessThanOrEqual(90_000)
  })

  it('reads a batch off the TOP level of orderRequest, and tolerates hl.batch', () => {
    const n = Date.now()
    const member = { kind: 'order', action: {}, nonce: n, typedData: {}, expected: {} }
    const top = legViewOf(hlStep(0, {}, { batch: [member] }))
    expect(top.kind).toBe('hlBatch')
    expect(top.chainId).toBe(1337)
    // The earliest member's nonce is the clock the whole leg shares.
    expect(top.staleAfterMs).toBeGreaterThan(80_000)
    expect(top.staleAfterMs).toBeLessThanOrEqual(90_000)
    expect(legViewOf(hlStep(0, { batch: [member] })).kind).toBe('hlBatch')
  })

  it('classifies a non-HL order as `order`, not unknown', () => {
    const v = legViewOf({ seq: 0, kind: 'sign', status: 'offered', artifact: { orderRequest: { protocol: 'opensea', typedData: {}, chainId: 1 } } })
    expect(v.kind).toBe('order')
    expect(v.chainId).toBe(1)
    expect(v.summary).toContain('opensea')
  })

  it('classifies a wait leg, and never names a shape it cannot read', () => {
    expect(legViewOf(waitStep(1)).kind).toBe('wait')
    expect(legViewOf(waitStep(1)).artifact).toBeNull()
    expect(legViewOf({ seq: 0, kind: 'sign', status: 'offered', artifact: { somethingNew: {} } }).kind).toBe('unknown')
  })
})

/* ── driveJob ─────────────────────────────────────────────────────────── */

describe('driveJob', () => {
  it('dryRun stops before the first broadcast and returns the leg views', async () => {
    const api = fakePantessa({ jobs: [job('waiting_signature', [txStep()])] })
    const { signer } = fakeSigner()
    const out = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, dryRun: true, fetch: api.doFetch })
    expect(out.status).toBe('dry')
    expect(out.legs).toHaveLength(1)
    expect(out.legs[0]!.kind).toBe('tx')
    expect(out.results).toHaveLength(0)
    expect(api.calls.some((c) => c.url.includes('/complete'))).toBe(false)
  })

  it('signs a tx leg, waits for the receipt and completes with the hash', async () => {
    vi.resetModules()
    const { sent } = withStubbedChain()
    const mod = await import('./desk.js')
    const api = fakePantessa({ jobs: [job('waiting_signature', [txStep()]), job('done', [{ ...txStep(), status: 'done' }])] })
    const { signer } = fakeSigner()
    const legs: string[] = []
    const out = await mod.driveJob({
      base: 'http://x',
      jobId: 'job_1',
      token: 't',
      signer,
      fetch: api.doFetch,
      onLeg: (l) => void legs.push(l.kind),
    })
    expect(out.status).toBe('done')
    expect(legs).toEqual(['tx'])
    expect(sent).toEqual([{ to: ADDR, chainId: 8453 }])
    const completion = api.calls.find((c) => c.url.includes('/complete'))!
    expect(completion.body).toMatchObject({ seq: 0, result: { txHash: HASH_A, chainId: 8453 } })
    vi.doUnmock('viem')
  })

  it('runs a txChain in order and re-quotes the step carrying a refresh recipe', async () => {
    vi.resetModules()
    const { sent } = withStubbedChain([HASH_A, HASH_B])
    const mod = await import('./desk.js')
    const api = fakePantessa({
      jobs: [job('waiting_signature', [chainStep()]), job('done', [{ ...chainStep(), status: 'done' }])],
    })
    const { signer } = fakeSigner()
    const out = await mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch })
    expect(out.status).toBe('done')
    expect(sent).toHaveLength(2)
    const refresh = api.calls.find((c) => c.url.includes('/api/tx/refresh'))!
    expect(refresh.body).toMatchObject({ kind: 'uniswap-swap', sellToken: 'USDC', from: account.address })
    const result = api.calls.find((c) => c.url.includes('/complete'))!.body!.result as DeskLegResult
    expect(result.txHash).toBe(HASH_B) // the LAST hash
    expect(result.txs).toHaveLength(2)
    // `txs` entries carry the runner's own per-step label, which the wire declares.
    for (const t of result.txs!) expect(Object.keys(t).sort()).toEqual(['chainId', 'hash', 'title'])
    // …the PER-TRANSACTION label from the chain, not the job step's own title.
    expect(result.txs!.map((t) => t.title)).toEqual(['Approve USDC', 'Swap USDC for ETH'])
  })

  it('retries a pending re-quote, then signs the fresh calldata', async () => {
    vi.resetModules()
    withStubbedChain()
    const mod = await import('./desk.js')
    let n = 0
    const api = fakePantessa({
      jobs: [job('waiting_signature', [chainStep()]), job('done', [{ ...chainStep(), status: 'done' }])],
      refresh: () => (n++ === 0 ? { status: 200, body: { pending: true } } : { status: 200, body: { tx: { to: ADDR, data: '0xfresh', value: '0', chainId: 8453 } } }),
    })
    const { signer } = fakeSigner()
    const out = await mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch })
    expect(out.status).toBe('done')
    expect(n).toBe(2)
  }, 20_000)

  it('refuses a withheld re-quote instead of signing the stale calldata', async () => {
    vi.resetModules()
    withStubbedChain()
    const mod = await import('./desk.js')
    const api = fakePantessa({
      jobs: [job('waiting_signature', [chainStep()])],
      refresh: () => ({ status: 200, body: { blocked: true, blockKind: 'execution', reasons: 'the rebuilt swap would revert' } }),
    })
    const { signer } = fakeSigner()
    await expect(
      mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'withheld' })
  })

  it('never posts a completion for a reverted transaction', async () => {
    vi.resetModules()
    withStubbedChain([HASH_A], 'reverted')
    const mod = await import('./desk.js')
    const api = fakePantessa({ jobs: [job('waiting_signature', [txStep()])] })
    const { signer } = fakeSigner()
    await expect(
      mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'broadcast' })
    expect(api.calls.some((c) => c.url.includes('/complete'))).toBe(false)
  })

  it('signs a Hyperliquid action and submits it direct', async () => {
    const api = fakePantessa({ jobs: [job('waiting_signature', [hlStep()]), job('done', [{ ...hlStep(), status: 'done' }])] })
    const { signer, typed } = fakeSigner()
    const out = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch })
    expect(out.status).toBe('done')
    // The typed data signed is the artifact's own, verbatim.
    expect(typed[0]).toMatchObject({ primaryType: 'Agent', message: { connectionId: '0x01' } })
    const submit = api.calls.find((c) => c.url.includes('/api/hl/submit'))!
    expect(submit.body).toMatchObject({ from: account.address, expected: { coin: 'HYPE', kind: 'open', isBuy: true } })
    expect(submit.body!.mode).toBe('direct')
    const result = api.calls.find((c) => c.url.includes('/complete'))!.body!.result as DeskLegResult
    expect(result.detail).toContain('filled 1 @ 10')
  })

  it('signs the builder-fee cap and the leverage pre-step before the order', async () => {
    const nonce = Date.now()
    const step = hlStep(0, {
      feeApproval: { builder: '0x9cc09ad0d6832ffbbfb1b70f1d9e5d0a6d00892a', maxFeeRate: '0.05%', feeTenthBps: 5 },
      pre: { action: { type: 'updateLeverage' }, nonce, typedData: { primaryType: 'Agent', message: { source: 'a', connectionId: '0x02' } }, expected: { leverage: 2 } },
    })
    const api = fakePantessa({ jobs: [job('waiting_signature', [step]), job('done', [{ ...step, status: 'done' }])] })
    const { signer } = fakeSigner()
    await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch, hlSignatureChainId: 42161 })
    const submits = api.calls.filter((c) => c.url.includes('/api/hl/submit'))
    expect(submits).toHaveLength(3)
    expect((submits[0]!.body!.action as Record<string, unknown>).type).toBe('approveBuilderFee')
    expect((submits[0]!.body!.action as Record<string, unknown>).signatureChainId).toBe('0xa4b1')
    expect((submits[1]!.body!.action as Record<string, unknown>).type).toBe('updateLeverage')
    expect(submits[1]!.body!.expected).toMatchObject({ coin: 'HYPE', leverage: 2 })
    expect((submits[2]!.body!.action as Record<string, unknown>).type).toBe('order')
  })

  it('signs every batch member in one pass, submits in order, and POSTS the partial result when one fails', async () => {
    const n = Date.now()
    const batch = [
      { kind: 'leverage', action: { type: 'updateLeverage' }, nonce: n, typedData: { message: { connectionId: '0x0a' } }, expected: { coin: 'HYPE', leverage: 2 } },
      { kind: 'order', action: { type: 'order', orders: [] }, nonce: n + 1, typedData: { message: { connectionId: '0x0b' } }, expected: { coin: 'HYPE', kind: 'open', isBuy: true } },
    ]
    const step = hlStep(0, {}, { batch })
    let seen = 0
    const api = fakePantessa({
      jobs: [job('waiting_signature', [step]), job('failed', [{ ...step, status: 'failed' }], 0, 'the venue refused the order')],
      hl: () => (++seen === 2 ? { status: 502, body: { error: 'venue rejected the order' } } : { status: 200, body: { status: 'ok' } }),
    })
    const { signer, typed } = fakeSigner()
    const out = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, pollMs: 1, fetch: api.doFetch })

    // Every member is signed BEFORE the first submit — the nonce window is shared.
    expect(typed.map((t) => (t.message as Record<string, unknown>).connectionId)).toEqual(['0x0a', '0x0b'])
    expect(api.calls.filter((c) => c.url.includes('/api/hl/submit'))).toHaveLength(2)
    // The partial result is posted: the runner re-arms and re-offers from the failed member.
    const result = api.calls.find((c) => c.url.includes('/complete'))!.body!.result as DeskLegResult
    expect(result.batch).toHaveLength(2)
    expect(result.batch![0]).toMatchObject({ ok: true })
    expect(result.batch![1]).toMatchObject({ ok: false })
    expect(result.batch![1]!.error).toContain('venue rejected the order')
    expect(out.status).toBe('failed')
  })

  it('submits each batch member with its OWN action, nonce and expected, in mode direct', async () => {
    const n = Date.now()
    const batch = [
      { kind: 'leverage', action: { type: 'updateLeverage', leverage: 2 }, nonce: n, typedData: { message: {} }, expected: { coin: 'HYPE', leverage: 2 } },
      { kind: 'order', action: { type: 'order', orders: [] }, nonce: n + 1, typedData: { message: {} }, expected: { coin: 'HYPE', kind: 'open', isBuy: true } },
    ]
    const step = hlStep(0, {}, { batch })
    const api = fakePantessa({ jobs: [job('waiting_signature', [step]), job('done', [{ ...step, status: 'done' }])] })
    const { signer } = fakeSigner()
    const out = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, pollMs: 1, fetch: api.doFetch })
    const submits = api.calls.filter((c) => c.url.includes('/api/hl/submit'))
    expect(submits.map((c) => c.body!.mode)).toEqual(['direct', 'direct'])
    expect(submits.map((c) => (c.body!.action as Record<string, unknown>).type)).toEqual(['updateLeverage', 'order'])
    expect(submits.map((c) => c.body!.nonce)).toEqual([n, n + 1])
    expect(submits[0]!.body!.expected).toMatchObject({ coin: 'HYPE', leverage: 2 })
    expect(out.status).toBe('done')
    // Even an all-ok batch completes with the batch shape: one thing to read.
    const result = api.calls.find((c) => c.url.includes('/complete'))!.body!.result as DeskLegResult
    expect(result.batch!.every((m) => m.ok)).toBe(true)
  })

  it('asks the runner to REBUILD a batch whose nonce window has lapsed — never re-signs it', async () => {
    const n = Date.now() - 200_000 // well past HL_NONCE_LIFE_MS
    const stale = hlStep(0, {}, { batch: [{ kind: 'order', action: {}, nonce: n, typedData: { message: {} }, expected: { coin: 'HYPE' } }] })
    const fresh = hlStep(0, {}, { batch: [{ kind: 'order', action: { type: 'order' }, nonce: Date.now(), typedData: { message: {} }, expected: { coin: 'HYPE', kind: 'open' } }] })
    const api = fakePantessa({
      jobs: [job('waiting_signature', [stale]), job('waiting_signature', [fresh]), job('done', [{ ...fresh, status: 'done' }])],
    })
    const { signer, typed } = fakeSigner()
    const notes: Array<Record<string, unknown>> = []
    const out = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, pollMs: 1, fetch: api.doFetch, onWaiting: (x) => void notes.push(x) })
    const retry = api.calls.find((c) => c.url.includes('/retry'))
    expect(retry).toBeDefined()
    expect(retry!.url).toContain('t=')
    expect(notes.some((x) => x.status === 'rebuilding')).toBe(true)
    // Exactly one signature — the fresh build's, never the stale one's.
    expect(typed).toHaveLength(1)
    expect(out.status).toBe('done')
  })

  it('gives up rather than rebuilding a leg forever', async () => {
    const n = Date.now() - 200_000
    const stale = hlStep(0, {}, { batch: [{ kind: 'order', action: {}, nonce: n, typedData: { message: {} }, expected: { coin: 'HYPE' } }] })
    const api = fakePantessa({ jobs: [job('waiting_signature', [stale])] })
    const { signer } = fakeSigner()
    await expect(
      driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, pollMs: 1, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'stale' })
    expect(api.calls.some((c) => c.url.includes('/api/hl/submit'))).toBe(false)
  })

  it('fails closed on a non-HL order, naming the protocol', async () => {
    const api = fakePantessa({
      jobs: [job('waiting_signature', [{ seq: 0, kind: 'sign', status: 'offered', title: 'List the NFT', artifact: { orderRequest: { protocol: 'opensea', typedData: {} } } }])],
    })
    const { signer } = fakeSigner()
    const err = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }).catch((e) => e)
    expect(err).toMatchObject({ code: 'unsupported-leg' })
    expect((err as DeskError).message).toContain('opensea')
    expect(api.calls.some((c) => c.url.includes('/complete'))).toBe(false)
  })

  it('surfaces a runner that REFUSES the leg result', async () => {
    vi.resetModules()
    withStubbedChain()
    const mod = await import('./desk.js')
    const api = fakePantessa({
      jobs: [job('waiting_signature', [txStep()])],
      completeStatus: 400,
      completeBody: { error: 'step is not awaiting a signature' },
    })
    const { signer } = fakeSigner()
    await expect(
      mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'http', message: /step is not awaiting a signature/ })
  })

  it('ends a dry run at a WITHHELD step, with the runner\'s own words', async () => {
    // Live 2026-09-23 against a real desk: a fresh throwaway key leaves leg 0
    // `pending` + `withheld` forever, because the guard built nothing. Spinning
    // until the timeout would hide the most useful answer the desk gave.
    const withheld: JobStep = {
      seq: 0,
      kind: 'sign',
      status: 'pending',
      title: 'Swap 1 USDC → ETH on Base',
      result: { withheld: true, error: 'Nothing to sign yet: this would spend 1 USDC on Base and the wallet holds 0 USDC there.' },
    }
    const notes: Array<Record<string, unknown>> = []
    const api = fakePantessa({ jobs: [job('running', [withheld, txStep(1)])] })
    const { signer } = fakeSigner()
    const out = await driveJob({
      base: 'http://x',
      jobId: 'job_1',
      token: 't',
      signer,
      dryRun: true,
      pollMs: 1,
      fetch: api.doFetch,
      onWaiting: (n) => void notes.push(n),
    })
    expect(out.status).toBe('dry')
    expect(out.withheld).toMatchObject({ seq: 0 })
    expect(out.withheld!.reason).toContain('holds 0 USDC there')
    expect(notes[0]).toMatchObject({ seq: 0, status: 'pending' })
    expect(api.pollCount()).toBe(1)
  })

  it('keeps driving past a withheld step when it is NOT a dry run', async () => {
    vi.resetModules()
    withStubbedChain()
    const mod = await import('./desk.js')
    const withheld: JobStep = { seq: 0, kind: 'sign', status: 'pending', title: 'building', result: { withheld: true, error: 'not funded yet' } }
    const api = fakePantessa({
      jobs: [job('running', [withheld]), job('waiting_signature', [txStep(0)]), job('done', [{ ...txStep(0), status: 'done' }])],
    })
    const { signer } = fakeSigner()
    const out = await mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, pollMs: 1, fetch: api.doFetch })
    expect(out.status).toBe('done')
    expect(out.results).toHaveLength(1)
  })

  it('polls through a wait leg and reports a job that failed closed', async () => {
    const api = fakePantessa({
      jobs: [
        job('waiting_settlement', [{ ...txStep(), status: 'done' }, waitStep(1)], 1),
        job('failed', [{ ...txStep(), status: 'done' }, waitStep(1)], 1, 'the bridge never settled'),
      ],
    })
    const { signer } = fakeSigner()
    const out = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch, pollMs: 1 })
    expect(out.status).toBe('failed')
    expect(out.failReason).toBe('the bridge never settled')
    expect(api.pollCount()).toBeGreaterThan(1)
  })

  it('stops at maxLegs rather than signing forever', async () => {
    vi.resetModules()
    withStubbedChain()
    const mod = await import('./desk.js')
    const api = fakePantessa({
      jobs: [job('waiting_signature', [txStep(0)]), job('waiting_signature', [txStep(0), txStep(1)], 1)],
    })
    const { signer } = fakeSigner()
    await expect(
      mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch, maxLegs: 1 }),
    ).rejects.toMatchObject({ code: 'max-legs' })
  })

  it('never lets a raw fetch error escape', async () => {
    const doFetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const { signer } = fakeSigner()
    const err = await driveJob({ base: 'http://x', jobId: 'j', token: 't', signer, fetch: doFetch }).catch((e) => e)
    expect(err).toBeInstanceOf(DeskError)
    expect((err as DeskError).code).toBe('http')
  })

  it('names the chain when no RPC is configured for it', async () => {
    const step = txStep()
    ;((step.artifact as Record<string, unknown>).txRequest as Record<string, unknown>).chainId = 999999
    const api = fakePantessa({ jobs: [job('waiting_signature', [step])] })
    const { signer } = fakeSigner()
    await expect(
      driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'no-rpc', message: /999999/ })
  })

  it('stamps caller headers on EVERY call it makes — jobs, re-quote, relay, retry, complete', async () => {
    vi.resetModules()
    withStubbedChain()
    const mod = await import('./desk.js')
    const api = fakePantessa({
      jobs: [job('waiting_signature', [chainStep()]), job('done', [{ ...chainStep(), status: 'done' }])],
    })
    const { signer } = fakeSigner()
    await mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch, headers: { 'x-yf-internal-run': '1' } })
    expect(api.calls.length).toBeGreaterThan(2)
    expect(api.calls.every((c) => c.headers['x-yf-internal-run'] === '1')).toBe(true)
    expect(api.calls.some((c) => c.url.includes('/api/tx/refresh'))).toBe(true)
  })

  it('posts a lowercase hash and only keys the runner names', async () => {
    vi.resetModules()
    withStubbedChain(['0xAAAA000000000000000000000000000000000000000000000000000000000001'])
    const mod = await import('./desk.js')
    const api = fakePantessa({ jobs: [job('waiting_signature', [txStep()]), job('done', [{ ...txStep(), status: 'done' }])] })
    const { signer } = fakeSigner()
    await mod.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch })
    const result = api.calls.find((c) => c.url.includes('/complete'))!.body!.result as Record<string, unknown>
    expect(result.txHash).toBe('0xaaaa000000000000000000000000000000000000000000000000000000000001')
    expect(String(result.txHash)).toMatch(/^0x[0-9a-f]{64}$/)
    for (const k of Object.keys(result)) expect(mod.LEG_RESULT_KEYS).toContain(k)
    expect(result.note).toBeUndefined()
  })

  it('drops an oversized venue response rather than breaching the completion cap', async () => {
    const huge = 'x'.repeat(20_000)
    const step = hlStep(0)
    const api = fakePantessa({
      jobs: [job('waiting_signature', [step]), job('done', [{ ...step, status: 'done' }])],
      hl: () => ({ status: 200, body: { status: 'filled', filled: { totalSz: '1', avgPx: '10' }, blob: huge } }),
    })
    const { signer } = fakeSigner()
    await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch })
    const posted = api.calls.find((c) => c.url.includes('/complete'))!.body!.result as Record<string, unknown>
    expect(JSON.stringify(posted).length).toBeLessThanOrEqual(8 * 1024)
    expect(posted.orderResponse).toBeUndefined()
    expect(posted.detail).toContain('filled')
  })

  it('mirrors the app\'s DESK_LEG_RESULT_KEYS exactly — same keys, same order', () => {
    // QA's sync pin reads this list against lib/desk-wire.ts, where it is tied
    // to DeskLegResult by `satisfies`. Drift here is drift in the wire.
    expect([...DESK_LEG_RESULT_KEYS]).toEqual([
      'txHash', 'chainId', 'txs', 'orderResponse', 'fill', 'batch', 'detail', 'explorerUrl', 'status',
    ])
    expect(LEG_RESULT_KEYS).toBe(DESK_LEG_RESULT_KEYS)
  })

  it('reports the venue\'s own word and its fill under the keys the wire names', async () => {
    const api = fakePantessa({
      jobs: [job('waiting_signature', [hlStep()]), job('done', [{ ...hlStep(), status: 'done' }])],
      hl: () => ({ status: 200, body: { status: 'filled', filled: { totalSz: '1.5', avgPx: '42.5' }, explorerUrl: 'https://app.hyperliquid.xyz/trade/HYPE' } }),
    })
    const { signer } = fakeSigner()
    await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch })
    const result = api.calls.find((c) => c.url.includes('/complete'))!.body!.result as Record<string, unknown>
    expect(result.status).toBe('filled')
    expect(result.fill).toMatchObject({ totalSz: '1.5', avgPx: '42.5' })
    expect(result.explorerUrl).toBe('https://app.hyperliquid.xyz/trade/HYPE')
    for (const k of Object.keys(result)) expect(DESK_LEG_RESULT_KEYS).toContain(k)
  })

  it('never defaults a chain to publicnode', () => {
    for (const url of Object.values(DEFAULT_RPC)) expect(url).not.toContain('publicnode')
  })
})

/* ── the desk MCP surface ─────────────────────────────────────────────── */

function deskServer(replies: Record<string, unknown>, opts?: { sse?: boolean; toolError?: string }) {
  const calls: Array<{ name: string; args: Record<string, unknown>; headers: Record<string, string> }> = []
  const doFetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { id: number; params: { name: string; arguments: Record<string, unknown> } }
    calls.push({ name: body.params.name, args: body.params.arguments, headers: (init!.headers ?? {}) as Record<string, string> })
    const payload = replies[body.params.name]
    const frame = {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: opts?.toolError ?? JSON.stringify(payload ?? {}) }],
        ...(opts?.toolError ? { isError: true } : {}),
      },
    }
    // The desk is stateless Streamable HTTP: one SSE frame, no session id.
    return opts?.sse === false
      ? new Response(JSON.stringify(frame), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(`event: message\ndata: ${JSON.stringify(frame)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
  }) as unknown as typeof fetch
  return { doFetch, calls }
}

describe('deskCall', () => {
  it('parses the one-frame SSE reply the stateless desk sends', async () => {
    const srv = deskServer({ broker_capabilities: { capabilities: ['a'] } })
    const out = await deskCall('http://x', 'broker_capabilities', {}, { fetch: srv.doFetch })
    expect(out).toMatchObject({ capabilities: ['a'] })
  })

  it('parses a plain JSON reply too, and sends no session header', async () => {
    const srv = deskServer({ broker_capabilities: { ok: true } }, { sse: false })
    await deskCall('http://x', 'broker_capabilities', {}, { fetch: srv.doFetch, headers: { 'x-yf-internal-run': '1' } })
    expect(srv.calls[0]!.headers['mcp-session-id']).toBeUndefined()
    expect(srv.calls[0]!.headers['x-yf-internal-run']).toBe('1')
    expect(srv.calls[0]!.headers.accept).toContain('text/event-stream')
  })

  it('turns a tool error into a DeskError, not a JSON parse crash', async () => {
    const srv = deskServer({}, { toolError: 'Intent x is closed — execution starts from an open intent.' })
    await expect(deskCall('http://x', 'broker_execute', {}, { fetch: srv.doFetch })).rejects.toMatchObject({
      code: 'desk-refused',
      message: /execution starts from an open intent/,
    })
  })
})

describe('openAndExecute', () => {
  const plan = (verdict: string) => ({
    ask: '2x long $12 of HYPE',
    quote: { gate: 'hl', kind: 'action', mcps: [], funding: { askUsd: 12, movableUsd: 3, strandedUsd: 0, verdict } },
    options: [
      { id: 'fund-1', label: 'Just enough (~$14)', resume: 'Fund it, then 2x long $12 of HYPE', kind: 'funding' },
      { id: 'proceed', label: 'Proceed as asked', resume: '2x long $12 of HYPE', kind: 'restate' },
      { id: 'decline', label: 'Walk away', resume: 'Never mind', kind: 'decline' },
    ],
    say: 'the desk will compile this',
  })
  const execReply = {
    intentId: 'int_1',
    state: 'executing',
    jobId: 'job_9',
    steps: [{ seq: 0, kind: 'sign', note: 'Fund it' }],
    drive: { poll: 'https://www.pantessa.com/api/jobs/job_9?t=TOKEN.SIG', complete: 'https://www.pantessa.com/api/jobs/job_9/complete?t=TOKEN.SIG', how: [] },
    say: 'Compiled to a 1-leg job',
  }

  it('opens, takes the funding route when short, consents, and returns the drive handle', async () => {
    const srv = deskServer({
      broker_open: { intentId: 'int_1', state: 'open', plan: plan('short') },
      broker_choose: { intentId: 'int_1', plan: plan('covered') },
      broker_execute: execReply,
    })
    const { signer } = fakeSigner()
    const out = await openAndExecute({
      base: 'http://local:3863',
      ask: '2x long $12 of HYPE',
      signer,
      agentKey: 'my-desk-key',
      agent: 'test-agent',
      fetch: srv.doFetch,
    })
    expect(srv.calls.map((c) => c.name)).toEqual(['broker_open', 'broker_choose', 'broker_execute'])
    expect(srv.calls[0]!.args).toMatchObject({ wallet: account.address, agent_key: 'my-desk-key', agent: 'test-agent' })
    expect(srv.calls[1]!.args).toMatchObject({ option_id: 'fund-1' })
    expect(out).toMatchObject({ intentId: 'int_1', jobId: 'job_9', token: 'TOKEN.SIG' })
    // The desk answers with its canonical origin; the handle follows the caller's.
    expect(out.pollUrl).toBe('http://local:3863/api/jobs/job_9?t=TOKEN.SIG')
  })

  it('signs the exact consent bytes the server derives, freshness line included', async () => {
    const srv = deskServer({ broker_open: { intentId: 'int_1', plan: plan('covered') }, broker_execute: execReply })
    const { signer, messages } = fakeSigner()
    await openAndExecute({ base: 'http://x', ask: 'swap $5 of ETH', signer, agentKey: 'k', fetch: srv.doFetch })
    const call = srv.calls.find((c) => c.name === 'broker_execute')!
    const issuedAt = call.args.issued_at as string
    expect(issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Byte-for-byte: the desk recovers the signer from the text IT builds, so a
    // character of drift recovers to a different address and reads as a wallet bug.
    expect(messages[0]).toBe(deskExecuteConsentMessage('int_1', account.address, issuedAt))
    expect(messages[0]!.split('\n')).toEqual([
      'Pantessa agent desk — execute consent',
      'Intent: int_1',
      `Wallet: ${account.address.toLowerCase()}`,
      `Issued at: ${issuedAt}`,
      "Signing lets the desk compile this intent into a job owned by this wallet. It moves nothing by itself; every leg still needs this wallet's own signature.",
    ])
    expect(call.args.wallet_signature as string).toMatch(/^0x[0-9a-f]{130}$/)
    // agent_key is required on execute and compared timing-safe.
    expect(call.args.agent_key).toBe('k')
  })

  it('pins the consent text byte for byte — five lines, U+2014, no trailing newline', () => {
    const text = deskExecuteConsentMessage('abc123', '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01', '2026-09-23T11:22:33.444Z')
    expect(text).toBe(
      'Pantessa agent desk \u2014 execute consent\n' +
        'Intent: abc123\n' +
        'Wallet: 0xabcdef0123456789abcdef0123456789abcdef01\n' +
        'Issued at: 2026-09-23T11:22:33.444Z\n' +
        "Signing lets the desk compile this intent into a job owned by this wallet. It moves nothing by itself; every leg still needs this wallet's own signature.",
    )
    expect(text.split('\n')).toHaveLength(5)
    expect(text.endsWith('\n')).toBe(false)
    expect(text.charCodeAt('Pantessa agent desk '.length)).toBe(0x2014)
    // The apostrophe is ASCII U+0027, not a curly quote.
    expect(text).toContain("wallet's own signature")
    expect(text).not.toContain('\u2019')
  })

  it('never falls back to another consent spelling — drift fails loudly', async () => {
    // A fallback that costs "one extra signature" HIDES drift; the desk
    // rebuilds this text from our own issued_at, so a mismatch is a bug to
    // see, not to paper over (QA F8).
    const srv = deskServer({ broker_open: { intentId: 'int_1', plan: plan('covered') } })
    const guarded = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { id: number; params: { name: string } }
      if (body.params.name !== 'broker_execute') return srv.doFetch(url as never, init as never)
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'broker_execute needs wallet_signature — it recovers to a different wallet.' }], isError: true } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch
    const { signer, messages } = fakeSigner()
    await expect(
      openAndExecute({ base: 'http://x', ask: 'swap $5 of ETH', signer, agentKey: 'k', fetch: guarded }),
    ).rejects.toMatchObject({ code: 'desk-refused' })
    expect(messages).toHaveLength(1)
  })

  it('does NOT retry the consent when the desk refused for another reason', async () => {
    const srv = deskServer({ broker_open: { intentId: 'int_1', plan: plan('covered') } })
    const guarded = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { id: number; params: { name: string } }
      if (body.params.name !== 'broker_execute') return srv.doFetch(url as never, init as never)
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Intent int_1 is closed — execution starts from an open intent.' }], isError: true } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch
    const { signer, messages } = fakeSigner()
    await expect(
      openAndExecute({ base: 'http://x', ask: 'swap $5 of ETH', signer, agentKey: 'k', fetch: guarded }),
    ).rejects.toMatchObject({ code: 'desk-refused' })
    expect(messages).toHaveLength(1)
  })

  it('skips broker_choose when the wallet already covers the ask', async () => {
    const srv = deskServer({ broker_open: { intentId: 'int_1', plan: plan('covered') }, broker_execute: execReply })
    const { signer } = fakeSigner()
    const out = await openAndExecute({ base: 'http://x', ask: 'swap $5 of ETH', signer, agentKey: 'k', fetch: srv.doFetch })
    expect(srv.calls.map((c) => c.name)).toEqual(['broker_open', 'broker_execute'])
    expect(out.chosen!.id).toBe('proceed')
  })

  it('refuses to execute when the picker walks away', async () => {
    const srv = deskServer({ broker_open: { intentId: 'int_1', plan: plan('short') }, broker_execute: execReply })
    const { signer } = fakeSigner()
    await expect(
      openAndExecute({
        base: 'http://x',
        ask: 'swap $5 of ETH',
        signer,
        agentKey: 'k',
        fetch: srv.doFetch,
        choose: (opts) => opts.find((o) => o.kind === 'decline')!,
      }),
    ).rejects.toMatchObject({ code: 'desk-refused' })
    expect(srv.calls.some((c) => c.name === 'broker_execute')).toBe(false)
  })

  it('names a desk answer that carries no job handle', async () => {
    const srv = deskServer({ broker_open: { intentId: 'int_1', plan: plan('covered') }, broker_execute: { intentId: 'int_1', state: 'executing' } })
    const { signer } = fakeSigner()
    await expect(
      openAndExecute({ base: 'http://x', ask: 'swap $5 of ETH', signer, agentKey: 'k', fetch: srv.doFetch }),
    ).rejects.toMatchObject({ code: 'desk-refused', message: /capability token/ })
  })
})

describe('firstFundableOption', () => {
  const opts = [
    { id: 'fund-1', label: 'f', resume: 'r', kind: 'funding' as const },
    { id: 'proceed', label: 'p', resume: 'r', kind: 'restate' as const },
  ]
  it('takes funding only when the quote says short', () => {
    expect(firstFundableOption(opts, { quote: { funding: { verdict: 'short' } } })!.id).toBe('fund-1')
    expect(firstFundableOption(opts, { quote: { funding: { verdict: 'covered' } } })!.id).toBe('proceed')
    expect(firstFundableOption(opts, {})!.id).toBe('proceed')
  })
  it('never picks the decline option', () => {
    const withDecline = [...opts, { id: 'decline', label: 'w', resume: 'r', kind: 'decline' as const }]
    expect(firstFundableOption(withDecline, {})!.kind).not.toBe('decline')
  })
})
