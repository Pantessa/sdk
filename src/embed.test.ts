// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPantessaChat, type PantessaChatHandle } from './embed.js'

const ORIGIN = 'https://www.pantessa.com'
/** The pre-rebrand origin an existing install still points its iframe at. */
const LEGACY_ORIGIN = 'https://www.yeetful.com'

function makeContainer(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/** Dispatch a window message as if it came from the embed iframe. */
function dispatch(origin: string, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { origin, data }))
}

const readyMsg = { source: 'yeetful-embed', v: 1, type: 'ready' }

/** Flush pending microtasks/timers so async announcements land. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const ACCOUNT = '0x3333333333333333333333333333333333333333'

/** Fake EIP-1193 provider: vi.fn request + on/removeListener capture + emit. */
function makeProvider() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    request: vi.fn(async ({ method }: { method: string; params?: unknown[] }): Promise<unknown> => {
      if (method === 'eth_accounts') return [ACCOUNT]
      if (method === 'eth_chainId') return '0x2105'
      return null
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    }),
    removeListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
    }),
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
  }
}

const handles: PantessaChatHandle[] = []
function mount(opts: Parameters<typeof mountPantessaChat>[0]) {
  const h = mountPantessaChat(opts)
  handles.push(h)
  return h
}

afterEach(() => {
  for (const h of handles.splice(0)) h.destroy()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

// The domain move (www.yeetful.com 307s to www.pantessa.com) means an iframe
// pointed at the old origin RUNS on the new one. A parent pinned to a single
// constant would drop every child message silently — no ready, no resize, no
// wallet relay — so the accepted-origin set is load-bearing, not cosmetic.
describe('mountPantessaChat — origin handling across the domain move', () => {
  it('accepts a child speaking from the post-redirect origin and replies there', async () => {
    // A pre-rebrand install: the caller still pins the old origin explicitly.
    const h = mount({ container: makeContainer(), origin: LEGACY_ORIGIN })
    expect(new URL(h.iframe.src).origin).toBe(LEGACY_ORIGIN)

    const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')
    // …but the redirect means the frame actually lives on the new origin.
    dispatch(ORIGIN, readyMsg)
    await flush()

    h.setTheme('light')
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'yeetful-embed', v: 1, type: 'theme', theme: 'light' },
      ORIGIN,
    )
  })

  it('fires onReady for a post-redirect child', async () => {
    const onReady = vi.fn()
    mount({ container: makeContainer(), origin: LEGACY_ORIGIN, onReady })
    dispatch(ORIGIN, readyMsg)
    await flush()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('ignores a foreign origin even when the payload shape is right', async () => {
    const onReady = vi.fn()
    const onEvent = vi.fn()
    mount({ container: makeContainer(), onReady, onEvent })
    dispatch('https://evil.example', readyMsg)
    dispatch('https://evil.example', { source: 'yeetful-embed', v: 1, type: 'event', name: 'turn' })
    await flush()
    expect(onReady).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('a self-hosted origin accepts only itself — no first-party set', async () => {
    const onReady = vi.fn()
    mount({ container: makeContainer(), origin: 'https://chat.acme.dev', onReady })
    // Our origins carry no privilege over someone else's deployment.
    dispatch(ORIGIN, readyMsg)
    await flush()
    expect(onReady).not.toHaveBeenCalled()

    dispatch('https://chat.acme.dev', readyMsg)
    await flush()
    expect(onReady).toHaveBeenCalledTimes(1)
  })
})

describe('mountPantessaChat', () => {
  it('throws a clear error outside the browser (SSR guard)', () => {
    vi.stubGlobal('window', undefined)
    expect(() => mountPantessaChat({})).toThrow('mountPantessaChat is browser-only')
  })

  it('builds the /embed URL with mcps, address, theme and host params', () => {
    const h = mount({
      container: makeContainer(),
      mcps: ['uniswap-free', 'snapshot-free'],
      address: '0x1111111111111111111111111111111111111111',
      theme: 'light',
    })
    const url = new URL(h.iframe.src)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/embed')
    expect(url.searchParams.get('mcps')).toBe('uniswap-free,snapshot-free')
    expect(url.searchParams.get('address')).toBe('0x1111111111111111111111111111111111111111')
    expect(url.searchParams.get('theme')).toBe('light')
    expect(url.searchParams.get('host')).toBe(window.location.origin)
    // the SDK always reports the full page URL for the embeds roster
    expect(url.searchParams.get('page')).toBe(window.location.href)
  })

  it('passes the public embed key through as ?key=', () => {
    const h = mount({ container: makeContainer(), key: 'yfe_0123456789abcdef01234567' })
    expect(new URL(h.iframe.src).searchParams.get('key')).toBe('yfe_0123456789abcdef01234567')
  })

  it('defaults theme to dark, omits mcps/address/key when unset, caps mcps at 4', () => {
    const h = mount({ container: makeContainer() })
    const url = new URL(h.iframe.src)
    expect(url.searchParams.get('theme')).toBe('dark')
    expect(url.searchParams.has('mcps')).toBe(false)
    expect(url.searchParams.has('address')).toBe(false)
    expect(url.searchParams.has('key')).toBe(false)

    const h2 = mount({ container: makeContainer(), mcps: ['a', 'b', 'c', 'd', 'e'] })
    expect(new URL(h2.iframe.src).searchParams.get('mcps')).toBe('a,b,c,d')
  })

  it('respects a custom origin and requires a container inline', () => {
    const h = mount({ container: makeContainer(), origin: 'http://localhost:3000' })
    expect(new URL(h.iframe.src).origin).toBe('http://localhost:3000')
    expect(() => mountPantessaChat({})).toThrow(/container/)
    expect(() => mountPantessaChat({ container: '#nope' })).toThrow(/container/)
  })

  it('ignores messages from the wrong origin or wrong source', () => {
    const onReady = vi.fn()
    mount({ container: makeContainer(), onReady })

    dispatch('https://evil.example', readyMsg)
    expect(onReady).not.toHaveBeenCalled()

    dispatch(ORIGIN, { source: 'not-yeetful', v: 1, type: 'ready' })
    dispatch(ORIGIN, null)
    dispatch(ORIGIN, 'ready')
    expect(onReady).not.toHaveBeenCalled()

    dispatch(ORIGIN, readyMsg)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('queues setAddress/setTheme until ready, then flushes to the embed origin', () => {
    const h = mount({ container: makeContainer() })
    const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

    h.setAddress('0x2222222222222222222222222222222222222222')
    h.setTheme('light')
    expect(postMessage).not.toHaveBeenCalled()

    dispatch(ORIGIN, readyMsg)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      { source: 'yeetful-embed', v: 1, type: 'address', address: '0x2222222222222222222222222222222222222222' },
      ORIGIN
    )
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      { source: 'yeetful-embed', v: 1, type: 'theme', theme: 'light' },
      ORIGIN
    )

    // After ready, calls post immediately (still to the embed origin, never '*').
    h.setAddress(null)
    expect(postMessage).toHaveBeenLastCalledWith(
      { source: 'yeetful-embed', v: 1, type: 'address', address: null },
      ORIGIN
    )
  })

  it('sendPrompt posts a prompt message (submit by default, prefill on submit:false)', () => {
    const h = mount({ container: makeContainer() })
    const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

    h.sendPrompt('quote 100 USDC to WETH on CoW')
    expect(postMessage).not.toHaveBeenCalled() // queued until ready

    dispatch(ORIGIN, readyMsg)
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'yeetful-embed', v: 1, type: 'prompt', text: 'quote 100 USDC to WETH on CoW', send: true },
      ORIGIN
    )

    h.sendPrompt('how do solvers work?', { submit: false })
    expect(postMessage).toHaveBeenLastCalledWith(
      { source: 'yeetful-embed', v: 1, type: 'prompt', text: 'how do solvers work?', send: false },
      ORIGIN
    )
  })

  it('applies resize height inline only when the container has no explicit height', () => {
    const container = makeContainer()
    const h = mount({ container })
    dispatch(ORIGIN, { source: 'yeetful-embed', v: 1, type: 'resize', height: 720 })
    expect(h.iframe.style.height).toBe('720px')

    const sized = makeContainer()
    sized.style.height = '600px'
    const h2 = mount({ container: sized })
    dispatch(ORIGIN, { source: 'yeetful-embed', v: 1, type: 'resize', height: 720 })
    expect(h2.iframe.style.height).toBe('100%')
  })

  it('forwards chat events to onEvent', () => {
    const onEvent = vi.fn()
    mount({ container: makeContainer(), onEvent })
    dispatch(ORIGIN, { source: 'yeetful-embed', v: 1, type: 'event', name: 'swap_quoted', data: { pair: 'USDC/ETH' } })
    expect(onEvent).toHaveBeenCalledWith('swap_quoted', { pair: 'USDC/ETH' })
  })

  it('bubble mode mounts a launcher + hidden panel, toggles open/close, Escape closes', () => {
    const h = mount({ mode: 'bubble' })
    const launcher = document.querySelector<HTMLButtonElement>('button[aria-label="Open Pantessa chat"]')
    expect(launcher).toBeTruthy()
    const panel = h.iframe.parentElement as HTMLElement
    expect(panel.style.visibility).toBe('hidden')

    h.open()
    expect(panel.style.visibility).toBe('visible')
    expect(panel.style.opacity).toBe('1')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(panel.style.visibility).toBe('hidden')

    launcher!.click()
    expect(panel.style.visibility).toBe('visible')
    launcher!.click()
    expect(panel.style.visibility).toBe('hidden')
  })

  it('open/close are no-ops inline', () => {
    const h = mount({ container: makeContainer() })
    expect(() => {
      h.open()
      h.close()
    }).not.toThrow()
  })

  describe('host-wallet bridge', () => {
    const rpcMsg = (id: string, method: string, params?: unknown[]) => ({
      source: 'yeetful-embed',
      v: 1,
      type: 'rpc',
      id,
      method,
      ...(params ? { params } : {}),
    })

    it("announces the wallet after 'ready' with fetched accounts + chainId", async () => {
      const provider = makeProvider()
      const h = mount({ container: makeContainer(), wallet: provider })
      const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

      expect(postMessage).not.toHaveBeenCalled()
      dispatch(ORIGIN, readyMsg)
      await flush()

      expect(provider.request).toHaveBeenCalledWith({ method: 'eth_accounts' })
      expect(provider.request).toHaveBeenCalledWith({ method: 'eth_chainId' })
      expect(postMessage).toHaveBeenCalledWith(
        { source: 'yeetful-embed', v: 1, type: 'wallet', accounts: [ACCOUNT], chainId: '0x2105' },
        ORIGIN
      )

      // Iframe reload → a second 'ready' re-announces.
      dispatch(ORIGIN, readyMsg)
      await flush()
      const walletPosts = postMessage.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'wallet')
      expect(walletPosts).toHaveLength(2)
    })

    it("wallet:'auto' (the default) picks up window.ethereum", async () => {
      const provider = makeProvider()
      ;(window as unknown as { ethereum?: unknown }).ethereum = provider
      try {
        const h = mount({ container: makeContainer() })
        const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')
        dispatch(ORIGIN, readyMsg)
        await flush()
        expect(postMessage).toHaveBeenCalledWith(
          { source: 'yeetful-embed', v: 1, type: 'wallet', accounts: [ACCOUNT], chainId: '0x2105' },
          ORIGIN
        )
        expect(provider.on).toHaveBeenCalledWith('accountsChanged', expect.any(Function))
      } finally {
        delete (window as unknown as { ethereum?: unknown }).ethereum
      }
    })

    it('wallet:false disables the bridge — no announce, rpc → 4900', async () => {
      const provider = makeProvider()
      ;(window as unknown as { ethereum?: unknown }).ethereum = provider
      try {
        const h = mount({ container: makeContainer(), wallet: false })
        const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')
        dispatch(ORIGIN, readyMsg)
        await flush()
        expect(postMessage.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'wallet')).toHaveLength(0)
        expect(provider.request).not.toHaveBeenCalled()

        dispatch(ORIGIN, rpcMsg('r1', 'eth_accounts'))
        expect(postMessage).toHaveBeenLastCalledWith(
          {
            source: 'yeetful-embed',
            v: 1,
            type: 'rpc:error',
            id: 'r1',
            error: { code: 4900, message: 'no host wallet bridge' },
          },
          ORIGIN
        )
      } finally {
        delete (window as unknown as { ethereum?: unknown }).ethereum
      }
    })

    it('relays an allowlisted rpc with params and posts rpc:result to the embed origin', async () => {
      const provider = makeProvider()
      provider.request.mockResolvedValueOnce('0xde0b6b3a7640000')
      const h = mount({ container: makeContainer(), wallet: provider })
      const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

      dispatch(ORIGIN, rpcMsg('r2', 'eth_getBalance', [ACCOUNT, 'latest']))
      await flush()

      expect(provider.request).toHaveBeenCalledWith({ method: 'eth_getBalance', params: [ACCOUNT, 'latest'] })
      expect(postMessage).toHaveBeenCalledWith(
        { source: 'yeetful-embed', v: 1, type: 'rpc:result', id: 'r2', result: '0xde0b6b3a7640000' },
        ORIGIN
      )
    })

    it('refuses a disallowed method with 4200 without touching the provider', async () => {
      const provider = makeProvider()
      const h = mount({ container: makeContainer(), wallet: provider })
      const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

      dispatch(ORIGIN, rpcMsg('r3', 'eth_sign', [ACCOUNT, '0xdead']))
      await flush()

      expect(provider.request).not.toHaveBeenCalled()
      expect(postMessage).toHaveBeenCalledWith(
        {
          source: 'yeetful-embed',
          v: 1,
          type: 'rpc:error',
          id: 'r3',
          error: { code: 4200, message: 'eth_sign is not allowed by pantessa/embed' },
        },
        ORIGIN
      )
    })

    it("surfaces a provider rejection as rpc:error with the provider's code", async () => {
      const provider = makeProvider()
      provider.request.mockRejectedValueOnce({ code: 4001, message: 'User rejected the request.' })
      const h = mount({ container: makeContainer(), wallet: provider })
      const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

      dispatch(ORIGIN, rpcMsg('r4', 'eth_sendTransaction', [{ to: ACCOUNT }]))
      await flush()

      expect(postMessage).toHaveBeenCalledWith(
        {
          source: 'yeetful-embed',
          v: 1,
          type: 'rpc:error',
          id: 'r4',
          error: { code: 4001, message: 'User rejected the request.' },
        },
        ORIGIN
      )

      // A codeless rejection falls back to -32603.
      provider.request.mockRejectedValueOnce(new Error('boom'))
      dispatch(ORIGIN, rpcMsg('r5', 'eth_chainId'))
      await flush()
      expect(postMessage).toHaveBeenLastCalledWith(
        { source: 'yeetful-embed', v: 1, type: 'rpc:error', id: 'r5', error: { code: -32603, message: 'boom' } },
        ORIGIN
      )
    })

    it('re-announces on accountsChanged / chainChanged / disconnect', async () => {
      const provider = makeProvider()
      const h = mount({ container: makeContainer(), wallet: provider })
      const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

      dispatch(ORIGIN, readyMsg)
      await flush()

      const next = '0x4444444444444444444444444444444444444444'
      provider.emit('accountsChanged', [next])
      expect(postMessage).toHaveBeenLastCalledWith(
        { source: 'yeetful-embed', v: 1, type: 'wallet', accounts: [next], chainId: '0x2105' },
        ORIGIN
      )

      provider.emit('chainChanged', '0x1')
      expect(postMessage).toHaveBeenLastCalledWith(
        { source: 'yeetful-embed', v: 1, type: 'wallet', accounts: [next], chainId: '0x1' },
        ORIGIN
      )

      provider.emit('disconnect')
      expect(postMessage).toHaveBeenLastCalledWith(
        { source: 'yeetful-embed', v: 1, type: 'wallet', accounts: [], chainId: '0x1' },
        ORIGIN
      )
    })

    it('destroy removes the provider listeners', () => {
      const provider = makeProvider()
      const h = mount({ container: makeContainer(), wallet: provider })
      expect(provider.on).toHaveBeenCalledTimes(3)

      h.destroy()
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
        const registered = provider.on.mock.calls.find((c) => c[0] === event)![1]
        expect(provider.removeListener).toHaveBeenCalledWith(event, registered)
      }
    })

    it('caps concurrent in-flight relays at 16 → -32005', async () => {
      const provider = makeProvider()
      provider.request.mockImplementation(() => new Promise(() => {})) // never settles
      const h = mount({ container: makeContainer(), wallet: provider })
      const postMessage = vi.spyOn(h.iframe.contentWindow!, 'postMessage')

      for (let i = 0; i < 16; i++) dispatch(ORIGIN, rpcMsg(`q${i}`, 'eth_blockNumber'))
      expect(provider.request).toHaveBeenCalledTimes(16)
      expect(postMessage).not.toHaveBeenCalled() // all still pending

      dispatch(ORIGIN, rpcMsg('q16', 'eth_blockNumber'))
      expect(provider.request).toHaveBeenCalledTimes(16) // 17th never reaches the provider
      expect(postMessage).toHaveBeenCalledWith(
        {
          source: 'yeetful-embed',
          v: 1,
          type: 'rpc:error',
          id: 'q16',
          error: { code: -32005, message: 'too many pending requests' },
        },
        ORIGIN
      )
    })
  })

  it('destroy removes DOM nodes and stops listening', () => {
    const onReady = vi.fn()
    const container = makeContainer()
    const h = mount({ container, onReady })
    expect(container.contains(h.iframe)).toBe(true)

    h.destroy()
    expect(container.contains(h.iframe)).toBe(false)
    dispatch(ORIGIN, readyMsg)
    expect(onReady).not.toHaveBeenCalled()

    const hb = mount({ mode: 'bubble' })
    hb.destroy()
    expect(document.querySelector('button[aria-label="Open Pantessa chat"]')).toBeNull()
    expect(document.body.contains(hb.iframe)).toBe(false)
    hb.open()
    expect((hb.iframe.parentElement as HTMLElement).style.visibility).toBe('hidden')
  })
})

describe('1.0.1 — host-page findings from the robinhood-desk example', () => {
  it('delegates fullscreen into the frame so the chat’s own fullscreen button works', () => {
    const h = mount({ container: makeContainer() })
    expect(h.iframe.getAttribute('allow')).toContain('fullscreen')
    expect(h.iframe.allowFullscreen).toBe(true)
    // The composer's voice button needs the mic delegated into the frame.
    expect(h.iframe.getAttribute('allow')).toContain('microphone')
    // and nothing wallet-shaped is delegated — signatures happen on the host page
    expect(h.iframe.getAttribute('allow')).not.toMatch(/ethereum|wallet/i)
  })

  it('does not pin a CSS-sized inline iframe to px when the chat reports its current height', () => {
    const container = makeContainer()
    const h = mount({ container })
    // The host sized the container with a stylesheet (no inline style) and the
    // iframe is filling it at 640px; the chat (h-dvh) reports exactly that.
    Object.defineProperty(h.iframe, 'getBoundingClientRect', {
      value: () => ({ height: 640, width: 400, top: 0, left: 0, right: 400, bottom: 640, x: 0, y: 0, toJSON() {} }),
    })
    dispatch(ORIGIN, { source: 'yeetful-embed', v: 1, type: 'resize', height: 640 })
    expect(h.iframe.style.height).toBe('100%')
    // A genuinely different height still applies (content grew past the frame).
    dispatch(ORIGIN, { source: 'yeetful-embed', v: 1, type: 'resize', height: 900 })
    expect(h.iframe.style.height).toBe('900px')
  })
})
