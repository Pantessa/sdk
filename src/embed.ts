/**
 * `pantessa/embed` — drop the Pantessa chat into any webpage as an iframe.
 *
 * Framework-agnostic, dependency-free, browser-only. Does NOT import viem or
 * any of the x402 payment stack — safe to load in host pages.
 *
 * Embed contract v1 (matches the website /embed route):
 *   - iframe URL: {origin}/embed?mcps=…&key=…&address=…&theme=…&host=…&page=…
 *     (`key` = the PUBLIC yfe_ embed key; `page` = the full host page URL,
 *     reported for the dashboard's "Your embeds" roster)
 *   - all postMessage payloads: { source: 'yeetful-embed', v: 1, type, ... }
 *   - child→parent: ready | resize {height} | event {name, data?}
 *   - parent→child: address {address} | theme {theme} | prompt {text, send?}
 *   - parent only accepts messages whose origin is in the accepted-origin set
 *     AND whose payload.source === 'yeetful-embed'; parent→child posts always
 *     target a concrete origin (never '*').
 *
 * The `yeetful-embed` source string, the `yfe_` key prefix and the query-param
 * names are FROZEN wire identifiers. They are not brand strings: an old SDK
 * talks to a new /embed and vice versa, so renaming any of them silently
 * breaks every install that hasn't upgraded. The rebrand deliberately does
 * not touch them.
 *
 * Wallet bridge contract v1.1 (additive):
 *   - child→parent: rpc {id, method, params?} — an EIP-1193 request to run
 *     against the host page's wallet provider.
 *   - parent→child: rpc:result {id, result} | rpc:error {id, error: {code,
 *     message}} | wallet {accounts, chainId} — the bridge announcement, sent
 *     after each 'ready' and re-sent on accountsChanged / chainChanged /
 *     disconnect. Empty accounts = bridge available but not connected.
 *   - Relayed methods are strictly allowlisted (see RPC_ALLOWLIST).
 */

/**
 * Minimal EIP-1193 provider surface — kept local so `pantessa/embed` stays
 * dependency-free. `window.ethereum` and every wagmi/viem/ethers-wrapped
 * injected provider satisfies this.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export interface PantessaChatOptions {
  /** Element (or selector) the chat fills. Required for mode 'inline'. */
  container?: HTMLElement | string
  /**
   * Embed origin. Default {@link DEFAULT_EMBED_ORIGIN}.
   *
   * Passing any first-party origin (including the pre-rebrand
   * `https://www.yeetful.com`) opts into the whole first-party set, so an
   * install that predates the rebrand keeps working through the redirect.
   * Passing a self-hosted origin accepts that origin ONLY.
   */
  origin?: string
  /** MCP slugs to scope the chat to (max 4). */
  mcps?: string[]
  /**
   * PUBLIC embed key (`yfe_…`) from the Pantessa dashboard — publishable by
   * design (safe in page source, like a Stripe publishable key). It
   * attributes this embed to your account: the site appears under "Your
   * embeds", and house-model answers meter YOUR plan's credits instead of
   * each visitor's free tier. Omit for an unattributed embed.
   */
  key?: string
  /** Initial wallet-address context (goes in the URL). */
  address?: string
  /** Default 'dark'. */
  theme?: 'dark' | 'light'
  /** 'inline' fills the container; 'bubble' floats a launcher. Default 'inline'. */
  mode?: 'inline' | 'bubble'
  /** Bubble mode stacking. Default 2147483000. */
  zIndex?: number
  /** Chat events forwarded from the iframe. */
  onEvent?: (name: string, data?: unknown) => void
  /** Fired once when the embed signals it is ready. */
  onReady?: () => void
  /**
   * Host-wallet bridge: relay the host page's EIP-1193 provider into the
   * embed so the chat can request accounts, read balances, and pop the
   * user's own wallet for signatures.
   *
   * - `'auto'` (default) — use `window.ethereum` when present, else no
   *   bridge (silent).
   * - an {@link Eip1193Provider} — use that provider (e.g. from wagmi).
   * - `false` — bridge off.
   *
   * Security model: the host page already holds this provider — the bridge
   * grants the embed the same dapp-level access the host page has, nothing
   * more. Every signature / transaction still pops the USER's own wallet UI
   * for explicit approval; relayed reads are restricted to a strict method
   * allowlist; no private key material ever crosses the frame boundary.
   */
  wallet?: 'auto' | Eip1193Provider | false
}

export interface PantessaChatHandle {
  iframe: HTMLIFrameElement
  /** Update the wallet-address context (queued until the embed is ready). */
  setAddress(address: string | null): void
  setTheme(theme: 'dark' | 'light'): void
  /**
   * Inject a prompt into the chat — host CTAs like "ask about this order".
   * Submits as the user's message by default; { submit: false } only prefills
   * the input. Queued until the embed is ready. Bubble mode: open() first if
   * you want the user to see the reply.
   */
  sendPrompt(text: string, opts?: { submit?: boolean }): void
  /** Bubble mode: open the panel (no-op inline). */
  open(): void
  /** Bubble mode: close the panel (no-op inline). */
  close(): void
  /** Remove all DOM nodes + listeners. */
  destroy(): void
}

/** FROZEN wire identifier — see the header note. Never rebrand this. */
const SOURCE = 'yeetful-embed'
const VERSION = 1

/** Where the hosted chat lives today. */
export const DEFAULT_EMBED_ORIGIN = 'https://www.pantessa.com'

/**
 * Origins the hosted chat has served from. `www.yeetful.com` now 307s to
 * `www.pantessa.com`, so an iframe pointed at the old origin ends up running
 * on the new one — a parent that compares `event.origin` against a single
 * pinned constant would drop EVERY child message (no ready, no resize, and no
 * wallet relay) with nothing in the console to explain it. Accepting the whole
 * first-party set, then pinning whichever origin actually answers, makes the
 * bridge survive this redirect and the next one.
 *
 * This stays a CLOSED allowlist: post-redirect origins are never trusted
 * implicitly, only these are.
 */
export const FIRST_PARTY_EMBED_ORIGINS = [
  DEFAULT_EMBED_ORIGIN,
  'https://pantessa.com',
  'https://www.yeetful.com',
  'https://yeetful.com',
] as const

type ChildMessage =
  | { source: typeof SOURCE; v: number; type: 'ready' }
  | { source: typeof SOURCE; v: number; type: 'resize'; height: number }
  | { source: typeof SOURCE; v: number; type: 'event'; name: string; data?: object }
  | { source: typeof SOURCE; v: number; type: 'rpc'; id: string; method: string; params?: unknown[] }

/**
 * EIP-1193 methods the bridge will relay to the host provider. Everything
 * else is refused with error code 4200 without touching the provider.
 */
const RPC_ALLOWLIST = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'net_version',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getLogs',
])

/** Max concurrently in-flight relayed requests; excess → rpc:error -32005. */
const MAX_INFLIGHT_RPC = 16

const CHAT_GLYPH =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-4.2 3.4c-.5.4-1.3 0-1.3-.7V6Z" fill="#fff"/>' +
  '</svg>'

export function mountPantessaChat(opts: PantessaChatOptions = {}): PantessaChatHandle {
  if (typeof window === 'undefined') {
    throw new Error('mountPantessaChat is browser-only')
  }

  const mode = opts.mode ?? 'inline'
  const requestedOrigin = new URL(opts.origin ?? DEFAULT_EMBED_ORIGIN).origin
  // A first-party origin (new or pre-rebrand) accepts the whole first-party
  // set so the redirect can't orphan the bridge; a self-hosted origin accepts
  // itself and nothing else.
  const acceptedOrigins = new Set<string>(
    (FIRST_PARTY_EMBED_ORIGINS as readonly string[]).includes(requestedOrigin)
      ? FIRST_PARTY_EMBED_ORIGINS
      : [requestedOrigin],
  )
  // The origin we actually talk to. Pinned to whichever accepted origin the
  // child speaks from, so parent→child posts land after a redirect too.
  let embedOrigin = requestedOrigin
  const zIndex = opts.zIndex ?? 2147483000

  // --- URL ---------------------------------------------------------------
  const url = new URL('/embed', requestedOrigin)
  const params = new URLSearchParams()
  if (opts.mcps?.length) params.set('mcps', opts.mcps.slice(0, 4).join(','))
  if (opts.key) params.set('key', opts.key)
  if (opts.address) params.set('address', opts.address)
  params.set('theme', opts.theme ?? 'dark')
  params.set('host', window.location.origin)
  // The full page URL feeds the dashboard's "Your embeds" roster (exactly
  // which pages run the chat) — referrer policies usually trim cross-origin
  // referrers to the origin, so the SDK reports it explicitly.
  params.set('page', window.location.href)
  url.search = params.toString()

  // --- iframe ------------------------------------------------------------
  const iframe = document.createElement('iframe')
  iframe.src = url.toString()
  iframe.title = 'Pantessa chat'
  iframe.setAttribute('allow', 'clipboard-write; payment')
  iframe.style.border = '0'
  iframe.style.display = 'block'

  // --- DOM per mode --------------------------------------------------------
  let container: HTMLElement | null = null
  let launcher: HTMLButtonElement | null = null
  let panel: HTMLDivElement | null = null
  let isOpen = false

  if (mode === 'inline') {
    container =
      typeof opts.container === 'string'
        ? document.querySelector<HTMLElement>(opts.container)
        : opts.container ?? null
    if (!container) {
      throw new Error("mountPantessaChat: 'container' (element or selector) is required for inline mode")
    }
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.minHeight = '480px'
    container.appendChild(iframe)
  } else {
    panel = document.createElement('div')
    const p = panel.style
    p.position = 'fixed'
    p.bottom = '96px'
    p.right = '24px'
    p.width = 'min(400px, calc(100vw - 32px))'
    p.height = 'min(640px, calc(100vh - 140px))'
    p.borderRadius = '16px'
    p.overflow = 'hidden'
    p.boxShadow = '0 24px 64px rgba(0, 0, 0, 0.4)'
    p.zIndex = String(zIndex)
    p.opacity = '0'
    p.transform = 'translateY(12px)'
    p.visibility = 'hidden'
    p.pointerEvents = 'none'
    p.transition = 'opacity 160ms ease, transform 160ms ease'
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    panel.appendChild(iframe)

    launcher = document.createElement('button')
    launcher.type = 'button'
    launcher.setAttribute('aria-label', 'Open Pantessa chat')
    const b = launcher.style
    b.position = 'fixed'
    b.bottom = '24px'
    b.right = '24px'
    b.width = '56px'
    b.height = '56px'
    b.borderRadius = '50%'
    b.background = '#0a0a0a'
    b.border = '1px solid rgba(255, 255, 255, 0.16)'
    b.display = 'flex'
    b.alignItems = 'center'
    b.justifyContent = 'center'
    b.cursor = 'pointer'
    b.padding = '0'
    b.zIndex = String(zIndex)
    b.transition = 'transform 120ms ease'
    launcher.innerHTML = CHAT_GLYPH
    launcher.addEventListener('mouseenter', onHoverIn)
    launcher.addEventListener('mouseleave', onHoverOut)
    launcher.addEventListener('click', onLauncherClick)

    document.body.appendChild(panel)
    document.body.appendChild(launcher)
    window.addEventListener('keydown', onKeydown)
  }

  // --- messaging -----------------------------------------------------------
  let ready = false
  let destroyed = false
  const queue: Array<Record<string, unknown>> = []

  function post(msg: Record<string, unknown>) {
    const payload = { source: SOURCE, v: VERSION, ...msg }
    if (!ready) {
      queue.push(payload)
      return
    }
    iframe.contentWindow?.postMessage(payload, embedOrigin)
  }

  /** Post immediately (rpc replies / wallet announcements never queue). */
  function postNow(msg: Record<string, unknown>) {
    iframe.contentWindow?.postMessage({ source: SOURCE, v: VERSION, ...msg }, embedOrigin)
  }

  // --- host-wallet bridge ----------------------------------------------------
  const walletOpt = opts.wallet ?? 'auto'
  const provider: Eip1193Provider | undefined =
    walletOpt === false
      ? undefined
      : walletOpt === 'auto'
        ? ((window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? undefined)
        : walletOpt

  let lastAccounts: string[] = []
  let lastChainId: string | null = null
  let inflightRpc = 0

  function sendWalletAnnouncement() {
    if (destroyed) return
    postNow({ type: 'wallet', accounts: lastAccounts, chainId: lastChainId })
  }

  /** Full announcement: refetch accounts + chainId (each best-effort). */
  async function announceWallet() {
    if (!provider) return
    let accounts: string[] = []
    let chainId: string | null = null
    try {
      const res = await provider.request({ method: 'eth_accounts' })
      accounts = Array.isArray(res) ? (res as string[]) : []
    } catch {
      accounts = []
    }
    try {
      const res = await provider.request({ method: 'eth_chainId' })
      chainId = typeof res === 'string' ? res : null
    } catch {
      chainId = null
    }
    lastAccounts = accounts
    lastChainId = chainId
    sendWalletAnnouncement()
  }

  function onAccountsChanged(...args: unknown[]) {
    lastAccounts = Array.isArray(args[0]) ? (args[0] as string[]) : []
    sendWalletAnnouncement()
  }
  function onChainChanged(...args: unknown[]) {
    lastChainId = typeof args[0] === 'string' ? args[0] : null
    sendWalletAnnouncement()
  }
  function onDisconnect() {
    lastAccounts = []
    sendWalletAnnouncement()
  }

  if (provider?.on) {
    provider.on('accountsChanged', onAccountsChanged)
    provider.on('chainChanged', onChainChanged)
    provider.on('disconnect', onDisconnect)
  }

  function handleRpc(msg: { id: string; method: string; params?: unknown[] }) {
    const { id, method, params } = msg
    if (typeof id !== 'string' || typeof method !== 'string') return
    if (!provider) {
      postNow({ type: 'rpc:error', id, error: { code: 4900, message: 'no host wallet bridge' } })
      return
    }
    if (!RPC_ALLOWLIST.has(method)) {
      postNow({ type: 'rpc:error', id, error: { code: 4200, message: `${method} is not allowed by pantessa/embed` } })
      return
    }
    if (inflightRpc >= MAX_INFLIGHT_RPC) {
      postNow({ type: 'rpc:error', id, error: { code: -32005, message: 'too many pending requests' } })
      return
    }
    inflightRpc++
    // No timeout on purpose: wallet prompts can sit open for minutes.
    provider.request({ method, params }).then(
      (result) => {
        inflightRpc--
        if (!destroyed) postNow({ type: 'rpc:result', id, result })
      },
      (err: unknown) => {
        inflightRpc--
        if (destroyed) return
        const e = err as { code?: unknown; message?: unknown }
        postNow({
          type: 'rpc:error',
          id,
          error: {
            code: typeof e?.code === 'number' ? e.code : -32603,
            message: typeof e?.message === 'string' ? e.message : String(err),
          },
        })
      }
    )
  }

  function onMessage(event: MessageEvent) {
    if (!acceptedOrigins.has(event.origin)) return
    const data = event.data as ChildMessage | undefined
    if (!data || typeof data !== 'object' || data.source !== SOURCE) return
    // Whichever accepted origin answered is the one we reply to from now on.
    embedOrigin = event.origin
    if (data.type === 'ready') {
      ready = true
      for (const msg of queue.splice(0)) iframe.contentWindow?.postMessage(msg, embedOrigin)
      opts.onReady?.()
      // Announce the wallet bridge on every ready — the iframe can reload.
      if (provider) void announceWallet()
    } else if (data.type === 'rpc') {
      handleRpc(data)
    } else if (data.type === 'resize') {
      // Inline only, and only when the host hasn't sized the container itself.
      if (mode === 'inline' && container && container.style.height === '' && typeof data.height === 'number') {
        iframe.style.height = `${data.height}px`
      }
    } else if (data.type === 'event') {
      opts.onEvent?.(data.name, data.data)
    }
  }
  window.addEventListener('message', onMessage)

  // --- bubble handlers -------------------------------------------------------
  function onHoverIn() {
    if (launcher) launcher.style.transform = 'scale(1.06)'
  }
  function onHoverOut() {
    if (launcher) launcher.style.transform = 'scale(1)'
  }
  function onLauncherClick() {
    isOpen ? close() : open()
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && isOpen) close()
  }

  function open() {
    if (mode !== 'bubble' || !panel || destroyed) return
    isOpen = true
    panel.style.visibility = 'visible'
    panel.style.pointerEvents = 'auto'
    panel.style.opacity = '1'
    panel.style.transform = 'translateY(0)'
    launcher?.setAttribute('aria-label', 'Close Pantessa chat')
  }

  function close() {
    if (mode !== 'bubble' || !panel || destroyed) return
    isOpen = false
    panel.style.opacity = '0'
    panel.style.transform = 'translateY(12px)'
    panel.style.pointerEvents = 'none'
    panel.style.visibility = 'hidden'
    launcher?.setAttribute('aria-label', 'Open Pantessa chat')
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    window.removeEventListener('message', onMessage)
    if (provider?.removeListener) {
      provider.removeListener('accountsChanged', onAccountsChanged)
      provider.removeListener('chainChanged', onChainChanged)
      provider.removeListener('disconnect', onDisconnect)
    }
    if (mode === 'bubble') {
      window.removeEventListener('keydown', onKeydown)
      launcher?.removeEventListener('mouseenter', onHoverIn)
      launcher?.removeEventListener('mouseleave', onHoverOut)
      launcher?.removeEventListener('click', onLauncherClick)
      launcher?.remove()
      panel?.remove()
    } else {
      iframe.remove()
    }
  }

  return {
    iframe,
    setAddress: (address) => post({ type: 'address', address }),
    setTheme: (theme) => post({ type: 'theme', theme }),
    sendPrompt: (text, promptOpts) => post({ type: 'prompt', text, send: promptOpts?.submit !== false }),
    open,
    close,
    destroy,
  }
}

// ── Pre-rebrand names ───────────────────────────────────────────────────────
// Kept as aliases, not shims: every published `yeetful` install calls
// mountYeetfulChat, and an embed that throws on upgrade is worse than an
// off-brand identifier. Slated for removal no earlier than the next major.

/** @deprecated Renamed to {@link mountPantessaChat}. */
export const mountYeetfulChat = mountPantessaChat
/** @deprecated Renamed to {@link PantessaChatOptions}. */
export type YeetfulChatOptions = PantessaChatOptions
/** @deprecated Renamed to {@link PantessaChatHandle}. */
export type YeetfulChatHandle = PantessaChatHandle
