# `pantessa` SDK — working rules

This is the published **`pantessa`** npm package (repo `Yeetful/sdk`). Entry
points: `pantessa` (top-level), `pantessa/agent`, `pantessa/client`,
`pantessa/server`, `pantessa/next`, `pantessa/express`, `pantessa/embed`. Built
with `tsup`; tested with `vitest`.

**Renamed from `yeetful` at 1.0.0** (2026-08-05, the pantessa.com domain move).
`compat/yeetful/` is the deprecated `yeetful` package: hand-written re-export
stubs, its own package.json, published separately AFTER `pantessa` so its
`^1.0.0` dependency resolves. Bump + publish it only when `pantessa`'s public
surface changes shape; routine fixes need no compat release.

Renamed exports keep their old names as deprecated aliases (`yeetful` →
`pantessa`, `mountYeetfulChat` → `mountPantessaChat`). `src/agent.test.ts`
imports BOTH names on purpose so a broken alias fails CI — don't "clean that up".

**Never rebrand a wire identifier.** The `yeetful-embed` postMessage source, the
`yf_` / `yfe_` key prefixes, the embed query-param names, and the
`*.yeetful.com` MCP + facilitator hosts are protocol and infrastructure, not
brand. Old SDKs talk to new servers and vice versa; renaming these breaks every
install that hasn't upgraded, and the MCP hosts additionally live inside stored
spend-grant allowlists.

## Versioning — REQUIRED on every change

**Every PR that changes shipped code MUST bump `version` in `package.json` in
the same PR.** Decide the bump (semver, currently `1.x`):

- **MINOR** (`X.Y.0` → `X.Y+1.0`) — any new export/feature or behavior change.
- **MAJOR** (`X` → `X+1`) — a breaking change. Post-1.0 these get a real major
  bump, and **call out "BREAKING:" in the PR title + body** so consumers know to
  read before upgrading.
- **PATCH** (`0.X.Y` → `0.X.Y+1`) — bug fixes or internal changes with **no**
  public-API or behavior change.
- **No bump** only when the diff is docs/comments/tests that don't touch shipped
  `src/` runtime or types.

Bump in the feature PR itself — never as a separate "version bump" PR after the
fact. The git log is the changelog (`0.4.0 — …`, `0.5.0 — …` style commit
subjects). Publishing to npm is a **manual, owner-gated** `npm publish` after
merge — don't publish from here.

## Before opening a PR

`npm run typecheck` (tsc over src + tests) · `npm run build` (tsup, incl. the
DTS/`.d.ts` build) · `npm test` (vitest) — **all green**. The DTS build needs
`@types/express-serve-static-core` present for the `express.ts` Request
augmentation (it's an explicit devDependency — keep it).

## Compatibility

Additive changes (new exports, JSDoc) are backward-compatible: older installs
keep working and don't need consumer code changes — that's why they're a MINOR
bump, not breaking. Never change the x402 wire format or an exported signature
without a BREAKING note.

End commits with:
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
