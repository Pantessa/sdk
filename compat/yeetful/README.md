# `yeetful` — deprecated, renamed to [`pantessa`](https://www.npmjs.com/package/pantessa)

Yeetful is now **Pantessa**. This package is a thin re-export of `pantessa` and
receives no further development.

```bash
npm i pantessa && npm rm yeetful
```

Then swap the import specifier — **no other code changes are required**:

```diff
-import { yeetful } from 'yeetful/agent'
-import { mountYeetfulChat } from 'yeetful/embed'
+import { pantessa } from 'pantessa/agent'
+import { mountPantessaChat } from 'pantessa/embed'
```

Every renamed export keeps its old name as a deprecated alias in `pantessa`, so
`yeetful()` and `mountYeetfulChat()` still work if you'd rather change only the
package name today.

## One thing worth upgrading for

`pantessa@1.x` moves the hosted defaults to the current domain and makes the
embed's origin check tolerate the `yeetful.com → pantessa.com` redirect. On
`yeetful@0.10.x` and earlier those defaults are hardcoded to the old origin,
which means:

- **the embed's host-wallet bridge stops working** — the iframe redirects onto
  the new origin, the parent's `event.origin` check rejects it, and every
  child message is dropped with nothing in the console;
- **hosted ledger sync and budget enforcement silently stop** — `fetch` drops
  the `Authorization` header across a cross-origin redirect, so receipts and
  policy fetches fail rather than error.

Pinning `ledgerUrl` / `origin` / `url` to `https://www.pantessa.com` works
around both on the old package; upgrading is the real fix.

MIT © Pantessa
