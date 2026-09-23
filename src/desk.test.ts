import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  DeskError,
  DEFAULT_RPC,
  deskCall,
  deskExecuteConsentMessage,
  driveJob,
  firstFundableOption,
  legViewOfStep,
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
}

function fakePantessa(opts: FakeOpts) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
  let poll = 0
  const doFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ url: String(url), body })
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

const hlStep = (seq = 0, extra: Record<string, unknown> = {}): JobStep => ({
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
    },
    summary: 'Long $12 of HYPE',
  },
})

const waitStep = (seq: number): JobStep => ({ seq, kind: 'wait', status: 'running', title: 'Funds arrive on Arbitrum' })

/* ── legViewOfStep ────────────────────────────────────────────────────── */

describe('legViewOfStep', () => {
  it('reads a single transaction off txRequest, not tx', () => {
    const v = legViewOfStep(txStep())
    expect(v.kind).toBe('tx')
    expect(v.chainId).toBe(8453)
    expect(v.summary).toBe('Bridge 12 USDC from Base')
    expect(v.valueUsd).toBe(12)
  })

  it('does NOT classify an artifact whose only key is `tx`', () => {
    // The README's C1 says `artifact.tx`; the Jobs API serves `txRequest`.
    // Guessing would hand a wallet an unvalidated object.
    const v = legViewOfStep({ seq: 0, kind: 'sign', status: 'offered', artifact: { tx: { to: ADDR, chainId: 8453 } } })
    expect(v.kind).toBe('unknown')
  })

  it('reads a chain, its first chain id and its soonest deadline', () => {
    const v = legViewOfStep(chainStep())
    expect(v.kind).toBe('txChain')
    expect(v.chainId).toBe(8453)
    expect(v.staleAfterMs).toBeGreaterThan(200_000)
  })

  it('reads a Hyperliquid action as chain 1337 with the nonce window', () => {
    const v = legViewOfStep(hlStep())
    expect(v.kind).toBe('hlAction')
    expect(v.chainId).toBe(1337)
    expect(v.staleAfterMs).toBeGreaterThan(100_000)
    expect(v.staleAfterMs).toBeLessThanOrEqual(120_000)
  })

  it('reads a batch as hlBatch', () => {
    const v = legViewOfStep(hlStep(0, { batch: [{ action: {}, nonce: Date.now(), typedData: {}, expected: {} }] }))
    expect(v.kind).toBe('hlBatch')
  })

  it('classifies a wait leg, and a foreign order protocol as unknown', () => {
    expect(legViewOfStep(waitStep(1)).kind).toBe('wait')
    const seaport = legViewOfStep({
      seq: 0,
      kind: 'sign',
      status: 'offered',
      artifact: { orderRequest: { protocol: 'opensea', typedData: {}, chainId: 1 } },
    })
    expect(seaport.kind).toBe('unknown')
    expect(seaport.chainId).toBe(1)
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
    expect(submit.body!.mode).toBeUndefined() // direct
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

  it('runs a batch in order and stops at the first failing member', async () => {
    const n = Date.now()
    const step = hlStep(0, {
      batch: [
        { action: { type: 'updateLeverage' }, nonce: n, typedData: { message: {} }, expected: { coin: 'HYPE', leverage: 2 } },
        { action: { type: 'order', orders: [] }, nonce: n + 1, typedData: { message: {} }, expected: { coin: 'HYPE', kind: 'open', isBuy: true } },
        { action: { type: 'order', orders: [] }, nonce: n + 2, typedData: { message: {} }, expected: { coin: 'HYPE', kind: 'close', isBuy: false } },
      ],
    })
    let seen = 0
    const api = fakePantessa({
      jobs: [job('waiting_signature', [step])],
      hl: () => (++seen === 2 ? { status: 502, body: { error: 'venue rejected the order' } } : { status: 200, body: { status: 'ok' } }),
    })
    const { signer } = fakeSigner()
    await expect(
      driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'http' })
    // Member 3 is never submitted: the batch stops where it broke.
    expect(api.calls.filter((c) => c.url.includes('/api/hl/submit'))).toHaveLength(2)
  })

  it('refuses a Hyperliquid build whose nonce is already outside the venue window', async () => {
    const step = hlStep(0)
    const hl = ((step.artifact as Record<string, unknown>).orderRequest as Record<string, unknown>).hl as Record<string, unknown>
    hl.nonce = Date.now() - 200_000
    const api = fakePantessa({ jobs: [job('waiting_signature', [step])] })
    const { signer } = fakeSigner()
    await expect(
      driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'stale' })
    expect(api.calls.some((c) => c.url.includes('/api/hl/submit'))).toBe(false)
  })

  it('fails closed on a leg shape it will not guess at', async () => {
    const api = fakePantessa({
      jobs: [job('waiting_signature', [{ seq: 0, kind: 'sign', status: 'offered', title: 'List the NFT', artifact: { orderRequest: { protocol: 'opensea', typedData: {} } } }])],
    })
    const { signer } = fakeSigner()
    await expect(
      driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }),
    ).rejects.toMatchObject({ code: 'unsupported-leg' })
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

  it('signs the exact consent bytes the server derives', async () => {
    const srv = deskServer({ broker_open: { intentId: 'int_1', plan: plan('covered') }, broker_execute: execReply })
    const { signer, messages } = fakeSigner()
    await openAndExecute({ base: 'http://x', ask: 'swap $5 of ETH', signer, agentKey: 'k', fetch: srv.doFetch })
    expect(messages[0]).toBe(deskExecuteConsentMessage('int_1', account.address))
    expect(messages[0]).toContain('Pantessa agent desk — execute consent')
    expect(messages[0]).toContain(`Wallet: ${account.address.toLowerCase()}`)
    const sig = srv.calls.find((c) => c.name === 'broker_execute')!.args.wallet_signature as string
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
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
