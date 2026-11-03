import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, hashTypedData, recoverTypedDataAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { DeskError, driveJob, type DeskSigner, type JobStep } from './desk.js'
import {
  SAFE_ABI,
  SAFE_TX_SERVICE,
  SAFE_TX_TYPES,
  ZERO_ADDRESS,
  packSignatures,
  safeProposalBody,
  safeSigner,
  safeTxHash,
  safeTxOf,
  safeTxTypedData,
  type SafeEvent,
  type SafeTxFields,
} from './safe.js'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const owner = privateKeyToAccount(KEY)
const OTHER = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')

const SAFE = '0x3333333333333333333333333333333333333333' as const
const TO = '0x2222222222222222222222222222222222222222' as const
const EXEC_HASH = '0xAAAA000000000000000000000000000000000000000000000000000000000001'
const SERVICE_HASH = '0xbbbb000000000000000000000000000000000000000000000000000000000002'
const RPC = 'http://rpc.test'

/* ── a tiny fake Safe Transaction Service ─────────────────────────────── */

interface FakeService {
  safe?: { nonce: number; threshold: number; owners: string[] }
  /** One entry per poll of GET /v1/multisig-transactions/{hash}/. */
  polls?: Array<{ status?: number; body: Record<string, unknown> }>
  proposeStatus?: number
  proposeBody?: Record<string, unknown>
}

function fakeService(opts: FakeService = {}) {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown>; headers: Record<string, string> }> = []
  let poll = 0
  const doFetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> })
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/multisig-transactions/') && method === 'POST') {
      return json(opts.proposeStatus ?? 201, opts.proposeBody ?? {})
    }
    if (url.includes('/v1/multisig-transactions/')) {
      const next = (opts.polls ?? [{ body: { isExecuted: false } }])[Math.min(poll, (opts.polls?.length ?? 1) - 1)]!
      poll++
      return json(next.status ?? 200, next.body)
    }
    if (url.includes('/v1/safes/')) {
      return json(200, opts.safe ?? { address: SAFE, nonce: 7, threshold: 1, owners: [owner.address], version: '1.4.1+L2' })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
  return { doFetch, calls, pollCount: () => poll }
}

/** Stub viem's clients: the Safe reads answer from here, nothing leaves the process. */
function withStubbedChain(opts: { nonce?: bigint; threshold?: bigint; owners?: string[]; receipt?: 'success' | 'reverted' } = {}) {
  const sent: Array<{ to: string; data: Hex; chainId: number }> = []
  vi.doMock('viem', async (orig) => {
    const real = (await orig()) as Record<string, unknown>
    return {
      ...real,
      createWalletClient: (cfg: { chain: { id: number } }) => ({
        sendTransaction: async (tx: { to: string; data: Hex }) => {
          sent.push({ to: tx.to, data: tx.data, chainId: cfg.chain.id })
          return EXEC_HASH
        },
      }),
      createPublicClient: () => ({
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === 'nonce') return opts.nonce ?? 7n
          if (functionName === 'getThreshold') return opts.threshold ?? 1n
          if (functionName === 'getOwners') return opts.owners ?? [owner.address]
          throw new Error(`unexpected read ${functionName}`)
        },
        waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: opts.receipt ?? 'success', transactionHash: hash }),
      }),
    }
  })
  return { sent }
}

const leg = { to: TO, data: '0xdead' as Hex, value: '0' }

const expectedTx = (nonce = 7n): SafeTxFields => ({
  to: TO,
  value: 0n,
  data: '0xdead',
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO_ADDRESS,
  refundReceiver: ZERO_ADDRESS,
  nonce,
})

/* ── the pure rules ───────────────────────────────────────────────────── */

describe('SafeTx hashing', () => {
  it('hashes over the Safe domain {chainId, verifyingContract} ONLY — no name, no version — and the ten-field struct', () => {
    const tx = expectedTx()
    const explicit = hashTypedData({
      domain: { chainId: 84532, verifyingContract: SAFE },
      types: {
        EIP712Domain: [
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ...SAFE_TX_TYPES,
      },
      primaryType: 'SafeTx',
      message: tx,
    })
    expect(safeTxHash(84532, SAFE, tx)).toBe(explicit)
    expect(safeTxHash(84532, SAFE, tx)).toMatch(/^0x[0-9a-f]{64}$/)
    // Another chain or another nonce is another hash.
    expect(safeTxHash(8453, SAFE, tx)).not.toBe(explicit)
    expect(safeTxHash(84532, SAFE, expectedTx(8n))).not.toBe(explicit)
    expect(SAFE_TX_TYPES.SafeTx.map((f) => f.name)).toEqual(['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'])
  })

  it('matches the hash the deployed Safe answered on Base Sepolia (the drill\'s vector)', () => {
    // Pinned from the 2026-11-03 drill: `getTransactionHash` on the 1-of-1
    // Safe deployed by the burner, for its first transaction. A drift here
    // is a signature the Safe will refuse (GS026).
    // Safe 0x892C…cddA (v1.4.1+L2, deploy tx 0x4561f864…d0d7), the burner
    // 0x5EaaBd…55a0 as `to`, value 0, data 0x, nonce 0.
    const vector = {
      chainId: 84532,
      safe: '0x892C563973A8669cD0fd922eB8C2bEfa9DCdcddA' as const,
      tx: { ...expectedTx(0n), to: '0x5EaaBd731d2Bc0490C2D47e41858e9b0629455a0' as const, data: '0x' as const },
      hash: '0xe06658c6e647c5819d3d6c1499c3430275dca16d5936a8ac7c9590117569f181',
    }
    expect(safeTxHash(vector.chainId, vector.safe, vector.tx)).toBe(vector.hash)
  })

  it('an owner\'s signature over the typed data recovers to the owner', async () => {
    const td = safeTxTypedData(84532, SAFE, expectedTx())
    const signature = await owner.signTypedData(td as never)
    expect(await recoverTypedDataAddress({ ...(td as never), signature } as never)).toBe(owner.address)
  })

  it('turns a leg into a CALL with no gas refund, at the given nonce', () => {
    expect(safeTxOf(leg, 7n)).toEqual(expectedTx())
    expect(safeTxOf({ to: TO }, 1n)).toMatchObject({ data: '0x', value: 0n, nonce: 1n })
    expect(safeTxOf({ to: TO, value: 1500n }, 1n).value).toBe(1500n)
    expect(safeTxOf({ to: TO, value: '0x10' }, 1n).value).toBe(16n)
  })

  it('packs confirmations in ascending owner order, 65 bytes each', () => {
    const a = `0x${'aa'.repeat(65)}`
    const b = `0x${'bb'.repeat(65)}`
    const packed = packSignatures([
      { owner: '0xffff000000000000000000000000000000000000', signature: a },
      { owner: '0x0001000000000000000000000000000000000000', signature: b },
    ])
    expect(packed).toBe(`0x${'bb'.repeat(65)}${'aa'.repeat(65)}`)
  })

  it('the proposal body carries what the service requires, data null when empty', () => {
    const tx = expectedTx()
    const hash = safeTxHash(84532, SAFE, tx)
    const body = safeProposalBody(SAFE, tx, hash, owner.address, '0x01', 'drill')
    expect(body).toEqual({
      safe: SAFE,
      to: TO,
      value: '0',
      data: '0xdead',
      operation: 0,
      gasToken: ZERO_ADDRESS,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: '0',
      refundReceiver: ZERO_ADDRESS,
      nonce: 7,
      contractTransactionHash: hash,
      sender: owner.address,
      signature: '0x01',
      origin: 'drill',
    })
    expect(safeProposalBody(SAFE, { ...tx, data: '0x' }, hash, owner.address, '0x01').data).toBeNull()
    // The service refuses a lowercase address by name ("is not checksumed") —
    // measured on Permit2, which a builder writes lowercase. Every address is EIP-55.
    const permit2Lower = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
    const checksummed = safeProposalBody(SAFE, { ...tx, to: permit2Lower }, hash, owner.address.toLowerCase() as `0x${string}`, '0x01')
    expect(checksummed.to).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
    expect(checksummed.sender).toBe(owner.address)
  })

  it('names Safe\'s own hosts for every chain the desk builds on, never publicnode', () => {
    for (const id of [1, 10, 8453, 42161, 84532]) {
      expect(SAFE_TX_SERVICE[id]).toMatch(/^https:\/\/api\.safe\.global\/tx-service\/[a-z0-9]+\/api$/)
    }
    expect(JSON.stringify(SAFE_TX_SERVICE)).not.toContain('publicnode')
  })
})

/* ── the adapter ──────────────────────────────────────────────────────── */

describe('safeSigner', () => {
  it('refuses order and Hyperliquid legs BY NAME, signs tx / txChain, and has no personal_sign', () => {
    const s = safeSigner({ safeAddress: SAFE, chainId: 84532, owner })
    expect(s.custody).toBe('safe')
    expect(s.address).toBe(SAFE)
    expect(s.supports('tx')).toBeNull()
    expect(s.supports('txChain')).toBeNull()
    expect(s.supports('wait')).toBeNull()
    expect(s.supports('order')).toContain('wave 2')
    expect(s.supports('order')).toContain('setPreSignature')
    expect(s.supports('hlAction')).toContain('unmeasured')
    expect(s.supports('hlBatch')).toContain('unmeasured')
    expect(s.supports('unknown')).toContain('will not guess')
    expect(s.signMessage).toBeUndefined()
    expect(s.signTypedData).toBeUndefined()
  })

  it('refuses a leg for another chain by name, before any read', async () => {
    const svc = fakeService()
    const s = safeSigner({ safeAddress: SAFE, chainId: 84532, owner, fetch: svc.doFetch })
    const err = await s.sendTransaction(leg, 8453).catch((e) => e)
    expect(err).toBeInstanceOf(DeskError)
    expect((err as DeskError).message).toContain('84532')
    expect((err as DeskError).message).toContain('8453')
    expect(svc.calls).toHaveLength(0)
  })

  it('reads the Safe ON-CHAIN when an RPC is given, proposes with the service body, executes with the owner, returns the exec hash', async () => {
    vi.resetModules()
    const { sent } = withStubbedChain({ nonce: 7n })
    const mod = await import('./safe.js')
    const svc = fakeService()
    const events: SafeEvent[] = []
    const s = mod.safeSigner({ safeAddress: SAFE, chainId: 84532, owner, rpc: RPC, fetch: svc.doFetch, origin: 'drill', onEvent: (e) => void events.push(e) })
    const hash = await s.sendTransaction(leg, 84532)

    expect(hash).toBe(EXEC_HASH.toLowerCase())
    // The service saw ONE call: the proposal (the nonce came from the chain).
    expect(svc.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${SAFE_TX_SERVICE[84532]}/v1/safes/${SAFE}/multisig-transactions/`])
    const tx = expectedTx(7n)
    const want = safeTxHash(84532, SAFE, tx)
    const proposal = svc.calls[0]!.body!
    expect(proposal).toMatchObject({ safe: SAFE, to: TO, value: '0', data: '0xdead', operation: 0, nonce: 7, contractTransactionHash: want, sender: owner.address, origin: 'drill' })
    // The signature the service holds is the owner's, over the same hash.
    expect(await recoverTypedDataAddress({ ...(safeTxTypedData(84532, SAFE, tx) as never), signature: proposal.signature as Hex } as never)).toBe(owner.address)
    // Executed from the owner: execTransaction(to the Safe) carrying that one signature.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(SAFE)
    expect(sent[0]!.chainId).toBe(84532)
    const calldata = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: 'execTransaction',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, proposal.signature as Hex],
    })
    expect(sent[0]!.data).toBe(calldata)
    expect(events.map((e) => e.kind)).toEqual(['safe', 'hash', 'proposed', 'executed'])
    expect(events[0]).toMatchObject({ kind: 'safe', source: 'chain', nonce: 7, threshold: 1 })
    vi.doUnmock('viem')
  })

  it('reads the Safe from the SERVICE without an RPC, and refuses an owner the Safe does not list', async () => {
    const svc = fakeService({ safe: { nonce: 3, threshold: 1, owners: [OTHER.address] } })
    const s = safeSigner({ safeAddress: SAFE, chainId: 84532, owner, fetch: svc.doFetch })
    const err = await s.sendTransaction(leg, 84532).catch((e) => e)
    expect(err).toMatchObject({ code: 'signer' })
    expect((err as DeskError).message).toContain(owner.address)
    expect((err as DeskError).message).toContain(OTHER.address)
    expect(svc.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('executor: false proposes and WAITS for the service to report the execution', async () => {
    const svc = fakeService({
      polls: [{ body: { isExecuted: false } }, { body: { isExecuted: true, isSuccessful: true, transactionHash: SERVICE_HASH.toUpperCase().replace('0X', '0x') } }],
    })
    const s = safeSigner({ safeAddress: SAFE, chainId: 84532, owner, executor: false, pollMs: 1, fetch: svc.doFetch })
    const hash = await s.sendTransaction(leg, 84532)
    expect(hash).toBe(SERVICE_HASH)
    expect(svc.pollCount()).toBe(2)
    expect(svc.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'GET'])
  })

  it('executor: false fails closed when the service reports a FAILED execution', async () => {
    const svc = fakeService({ polls: [{ body: { isExecuted: true, isSuccessful: false, transactionHash: SERVICE_HASH } }] })
    const s = safeSigner({ safeAddress: SAFE, chainId: 84532, owner, executor: false, pollMs: 1, fetch: svc.doFetch })
    await expect(s.sendTransaction(leg, 84532)).rejects.toMatchObject({ code: 'broadcast' })
  })

  it('a threshold of 2 waits for the other owner on the service and packs both signatures in owner order', async () => {
    vi.resetModules()
    const { sent } = withStubbedChain({ nonce: 7n, threshold: 2n, owners: [owner.address, OTHER.address] })
    const mod = await import('./safe.js')
    const tx = expectedTx(7n)
    const td = mod.safeTxTypedData(84532, SAFE, tx)
    const sigOwner = await owner.signTypedData(td as never)
    const sigOther = await OTHER.signTypedData(td as never)
    const svc = fakeService({
      polls: [
        { body: { confirmationsRequired: 2, confirmations: [{ owner: owner.address, signature: sigOwner }] } },
        { body: { confirmationsRequired: 2, confirmations: [{ owner: owner.address, signature: sigOwner }, { owner: OTHER.address, signature: sigOther }] } },
      ],
    })
    const s = mod.safeSigner({ safeAddress: SAFE, chainId: 84532, owner, rpc: RPC, pollMs: 1, fetch: svc.doFetch })
    await s.sendTransaction(leg, 84532)
    const packed = mod.packSignatures([
      { owner: owner.address, signature: sigOwner },
      { owner: OTHER.address, signature: sigOther },
    ])
    // ABI-encoded `bytes` is right-padded to 32 bytes — the packed signatures sit inside the calldata, OTHER's (the lower address) first.
    expect(sent[0]!.data.includes(packed.slice(2))).toBe(true)
    expect(packed.slice(2).startsWith(sigOther.slice(2))).toBe(OTHER.address.toLowerCase() < owner.address.toLowerCase())
    expect(svc.pollCount()).toBe(2)
    vi.doUnmock('viem')
  })

  it('a reverted execTransaction is NOT a completed leg', async () => {
    vi.resetModules()
    withStubbedChain({ receipt: 'reverted' })
    const mod = await import('./safe.js')
    const svc = fakeService()
    const s = mod.safeSigner({ safeAddress: SAFE, chainId: 84532, owner, rpc: RPC, fetch: svc.doFetch })
    await expect(s.sendTransaction(leg, 84532)).rejects.toMatchObject({ code: 'broadcast' })
    vi.doUnmock('viem')
  })

  it('a proposal the service already holds is not an error (a retry)', async () => {
    vi.resetModules()
    withStubbedChain()
    const mod = await import('./safe.js')
    const svc = fakeService({ proposeStatus: 422, proposeBody: { nonFieldErrors: ['Tx with safe-tx-hash=0x… already exists'] } })
    const s = mod.safeSigner({ safeAddress: SAFE, chainId: 84532, owner, rpc: RPC, fetch: svc.doFetch })
    await expect(s.sendTransaction(leg, 84532)).resolves.toBe(EXEC_HASH.toLowerCase())
    vi.doUnmock('viem')
  })

  it('a bearer api key and caller headers ride on every service call', async () => {
    const svc = fakeService({ polls: [{ body: { isExecuted: true, isSuccessful: true, transactionHash: SERVICE_HASH } }] })
    const s = safeSigner({ safeAddress: SAFE, chainId: 84532, owner, executor: false, pollMs: 1, apiKey: 'k1', headers: { 'x-yf-internal-run': '1' }, fetch: svc.doFetch })
    await s.sendTransaction(leg, 84532)
    for (const c of svc.calls) {
      expect(c.headers.authorization).toBe('Bearer k1')
      expect(c.headers['x-yf-internal-run']).toBe('1')
    }
  })
})

/* ── through driveJob ─────────────────────────────────────────────────── */

describe('driveJob with a Safe', () => {
  const txStep = (seq = 0): JobStep => ({
    seq,
    kind: 'sign',
    status: 'offered',
    title: 'Send 0.0001 ETH',
    builder: 'native-transfer',
    valueUsd: 0.3,
    artifact: { txRequest: { to: TO, data: '0xdead', value: '0', chainId: 84532 }, summary: 'Send 0.0001 ETH' },
  })
  const cowStep = (): JobStep => ({
    seq: 0,
    kind: 'sign',
    status: 'offered',
    title: 'Swap on CoW',
    artifact: { orderRequest: { protocol: 'cow', chainId: 8453, typedData: { domain: {}, types: {}, primaryType: 'Order', message: { validTo: Math.floor(Date.now() / 1000) + 600 } } } },
  })
  const job = (status: string, steps: JobStep[]) => ({ id: 'job_1', status, currentStep: 0, steps })

  function fakePantessa(jobs: Array<Record<string, unknown>>, service: ReturnType<typeof fakeService>) {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
    let poll = 0
    const doFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('api.safe.global')) return service.doFetch(url, init)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url: String(url), body })
      const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
      if (url.includes('/complete')) return json(200, { ok: true })
      if (url.includes('/api/jobs/')) {
        const next = jobs[Math.min(poll, jobs.length - 1)]
        poll++
        return json(200, { job: next })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    return { doFetch, calls }
  }

  it('drives a tx leg through the Safe and completes with the EXEC hash — the legs are built for the Safe', async () => {
    vi.resetModules()
    withStubbedChain()
    const desk = await import('./desk.js')
    const safe = await import('./safe.js')
    const svc = fakeService()
    const api = fakePantessa([job('waiting_signature', [txStep()]), job('done', [{ ...txStep(), status: 'done' }])], svc)
    const signer = safe.safeSigner({ safeAddress: SAFE, chainId: 84532, owner, rpc: RPC, fetch: api.doFetch })
    const out = await desk.driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, rpc: { 84532: RPC }, fetch: api.doFetch })
    expect(out.status).toBe('done')
    expect(api.calls.find((c) => c.url.includes('/complete'))!.body).toMatchObject({ seq: 0, result: { txHash: EXEC_HASH.toLowerCase(), chainId: 84532 } })
    expect(svc.calls.some((c) => c.method === 'POST')).toBe(true)
    vi.doUnmock('viem')
  })

  it('refuses a CoW order leg through a Safe BY NAME, before any signature or proposal', async () => {
    const svc = fakeService()
    const api = fakePantessa([job('waiting_signature', [cowStep()])], svc)
    const signer = safeSigner({ safeAddress: SAFE, chainId: 8453, owner, fetch: api.doFetch })
    const err = await driveJob({ base: 'http://x', jobId: 'job_1', token: 't', signer, fetch: api.doFetch }).catch((e) => e)
    expect(err).toMatchObject({ code: 'signer' })
    expect((err as DeskError).message).toContain('Leg 0 (order)')
    expect((err as DeskError).message).toContain('wave 2')
    expect(svc.calls).toHaveLength(0)
    expect(api.calls.some((c) => c.url.includes('/complete') || c.url.includes('/api/cow/submit'))).toBe(false)
  })

  it('openAndExecute with a Safe refuses the personal_sign consent in its own words', async () => {
    const srv = (async (url: string) => {
      if (String(url).endsWith('/api/broker/mcp')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ intentId: 'int_1', plan: { options: [] } }) }] } }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const signer: DeskSigner = safeSigner({ safeAddress: SAFE, chainId: 84532, owner, fetch: srv })
    const err = await driveJobLess(srv, signer)
    expect(err).toMatchObject({ code: 'signer' })
    expect((err as DeskError).message).toContain('personal_sign')
    expect((err as DeskError).message).toContain('EIP-1271')
  })
})

async function driveJobLess(srv: typeof fetch, signer: DeskSigner): Promise<unknown> {
  const { openAndExecute } = await import('./desk.js')
  return openAndExecute({ base: 'http://x', ask: 'Buy $1 of ETH', signer, agentKey: 'k', fetch: srv }).catch((e) => e)
}
