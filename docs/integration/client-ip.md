# The client IP

The highest-consequence setting in the library, and the easiest to get wrong.

← [Documentation](../index.md) · [Integration](index.md)

---

## Why it is the highest-consequence setting

The client address becomes the [actor key](../concepts/actors.md). Everything per-client
depends on it: rate limits, the allowlist, the denylist, and every behavioural detector.

`X-Forwarded-For` is a **client-supplied header**. Trust it without knowing how many proxies
sit in front of you and anyone can prepend a fake hop and choose the address you rate-limit,
allowlist and block on.

The failure is silent. Nothing errors, nothing logs, and every per-actor mechanism in this
library becomes an attacker input.

There is deliberately **no convenient default**.

## The three settings

```ts
proxy: { trustProxy: true, trustedProxies: ["10.0.0.0/8"] }   // recommended
proxy: { trustProxy: true, hops: 2 }                          // correct only while the count is
proxy: { trustProxy: false }                                  // default — header ignored entirely
```

### `trustedProxies` — the one to use

The chain is walked **from the right**, discarding your own infrastructure, and the first
address outside it is the client. That is robust against an extra hop appearing, which is
what makes it survive a change to your topology that nobody remembered to tell you about.

### `hops` — correct only while the count is

Counts a fixed number of entries from the right. It is right until somebody adds a CDN,
inserts a sidecar, or moves a service behind an extra load balancer — and then it is wrong
in the direction that lets clients choose their own address.

### `trustProxy: false` — the default

The forwarded header is ignored entirely and the socket address is used. Correct when
nothing sits in front of you, and safe everywhere else in the sense that matters: it can be
*useless* behind a proxy (every request looks like it came from the load balancer), but it
cannot be *forged*.

## Addresses are compared as bytes

`::ffff:127.0.0.1`, `0177.0.0.1` and `127.0.0.001` are all the same address, and all of them
slip past an allowlist that compares strings. Parsing to bytes is the only comparison that
holds.

Invalid CIDRs throw at construction rather than matching silently. A range that matches
nothing is a control you believe you have and do not.

## The peer is checked too

The connecting peer counts as the first hop and is checked the same way.

That is the part that matters on a server reachable **both** through the load balancer and
directly. A request arriving from outside your trusted ranges did not come through your
proxies, so its forwarded header is not evidence of anything and the socket address is used
instead.

Without that check, anyone who finds the origin address picks their own client IP — and
origin addresses are not secret.

## Do not allowlist loopback

The moment you sit behind nginx or beside a sidecar, every request in the world arrives from
`127.0.0.1`.

## On Fetch runtimes

There is no socket, so the address comes from a header. Only `cf-connecting-ip` and
`x-real-ip` are trusted by default: both are single-valued and written by the edge that
terminated the connection.

`x-forwarded-for` is **not** in that list, because a proxy *appends* to it — its leftmost
entry is whatever the client wrote. List it explicitly only if you know your edge replaces
the whole header.

Better still, ask the platform rather than a header:

```ts
createFetchAdapter(detector, {
  clientIp: (request, env) => (env as { cf?: { connectingIp?: string } }).cf?.connectingIp,
});
```

If no address can be found, every visitor is tracked under one empty actor key — which makes
rate limits and behavioural detection apply to your whole site at once. The adapter says so
through `onWarning` the first time it happens.

## When the address is not the right identity anyway

An address is a poor identity: shared by a whole office, changed by a phone every few
minutes. `actorKey` is the single most valuable thing to replace:

```ts
new BotHandler({ actorKey: (facts) => facts.session ?? facts.ip });
```

A session id, an authenticated user id, or an address plus a TLS fingerprint all make the
same detectors sharper — sharp enough that `identity-rotation` becomes worth enabling.

## Related

- [Actors](../concepts/actors.md) — what the key is used for
- [Adapters](adapters.md) — where the address is read
- [Configuration reference](../reference/configuration.md) — `proxy`, `actorKey`, `allowlist`
