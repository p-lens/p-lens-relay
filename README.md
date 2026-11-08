# p-lens-relay

> **日本語版が原本です。** [README.ja.md](README.ja.md) is the original; this English text is a translation, and where the two differ the Japanese holds.

The sync server side of P-Lens: books, live plays and ノリ打ち carried over the
Nostr protocol, end to end encrypted, by any relay that passes the
conformance tests.

Nothing but Bun is needed to build, test and run it; on Cloudflare it runs as Workers.

```text
hosts/
  cloudflare/   the official relay and its ticket issuer: Workers and Durable Objects
  bun/          the same on a server of one's own: Bun processes, SQLite files, Docker
packages/
  core/         a relay as pure functions: NIP-01 matching, keeping, replacing, deleting
  gate/         what makes a relay a P-Lens relay
  relay/        the P-Lens relay over SQLite, wherever it runs
  issuer/       the ticket issuer over SQLite, wherever it runs
  tickets/      the blind tickets of PROTOCOL.md §9.2
  sql/          the SQLite port the relay and the issuer keep their data by
  reference/    the reference implementation of PLN-1's keys and seal, with its test vectors
testing/
  fake/         a relay misbehaving on purpose, for testing a client
  conformance/  whether a relay can carry P-Lens
```

- `PROTOCOL.md` is the protocol, PLN-1: what a client writes, what a relay
  must do, what the operator can and cannot read.
- `packages/core` is a relay as pure functions, in memory: one connection's
  message in, the messages out.
- `packages/gate` refuses whatever is not PLN-1, and holds writes to fixed
  caps or to what was paid for (`open`, `capped`, `gated`), judging over a
  view of what the relay holds, so the same judgement runs over memory and
  over SQLite.
- `packages/relay` is a bucket of lines over SQLite: its sessions, its
  storage, how a deployment is set, NIP-11, and the front a request comes in
  by. `packages/issuer` is the issuer the same way: plans kept under their
  codes' hashes, blinded tickets signed within what a plan gives each month,
  a plan made by the operator (`POST /plans` with `ADMIN_TOKEN`) until a
  payment's adapter makes it in the operator's place.
- `packages/tickets` is RSAPBSSA-SHA384-PSS written out in native BigInt (the
  browsers' WebCrypto refuses the long public exponents each ticket's
  information derives), checked against the draft's test vectors; the
  issuer's key is made by `bun --cwd=packages/tickets run make-key`.
- `hosts/cloudflare` and `hosts/bun` are thin shells over `packages/relay`
  and `packages/issuer`, so that both decide by the same code: a host only
  holds sockets and opens SQLite.
- `testing/fake` is a relay misbehaving on purpose, each quirk switchable
  (losing, reordering, repeating, old versions, a stale cache, no `OK`), with
  presets for how Nosflare, nostr-rs-relay and strfry behave.
- `testing/conformance` checks whether a relay can carry P-Lens, with events
  shaped as PLN-1 shapes them, so that it runs against a P-Lens relay too.

## Checking

```sh
bun install
bun run check                       # tsc over every package
bun run test                        # every package's tests but conformance's, which need a relay
```

## Conformance

```sh
bun install
testing/conformance/relays/up.sh                    # nostr-rs-relay on :7777, strfry on :7778 (podman)
bun --cwd=testing/conformance test                  # against ws://127.0.0.1:7777
RELAY_URL=ws://127.0.0.1:7778 bun --cwd=testing/conformance test
```

The fake relay can stand in for one, behaving as a preset (`plain`,
`nosflare`, `nostr-rs-relay`, `strfry`, `chaos`), with any quirk changed by
`FAKE_QUIRKS` and a P-Lens relay's gate put before it by `FAKE_GATE`
(`open` or `capped`):

```sh
FAKE_PRESET=nosflare bun --cwd=testing/fake run serve   # on ws://127.0.0.1:7790
RELAY_URL=ws://127.0.0.1:7790 bun --cwd=testing/conformance test
```

The presets give what the real relays give: plain and strfry pass every test,
nostr-rs-relay keeps the first of two versions in a second, and Nosflare as
shipped also refuses more than 10 events a minute.

Use `127.0.0.1`, not `localhost`: a rootless podman port answers on IPv4 only.

## Running the relay on a server of one's own

`hosts/bun` is the relay as one Bun process, keeping a SQLite file for each
label of its address. On a laptop:

```sh
bun --cwd=hosts/bun run relay                       # on ws://127.0.0.1:7780, its files in hosts/bun/data
RELAY_URL=ws://127.0.0.1:7780 bun --cwd=testing/conformance test
```

On a server (a VPS, say), with Docker or Podman, Caddy in front of it getting
the `wss://` certificate. Point the relay's host at the server by DNS, then:

```sh
cd hosts/bun
cp .env.example .env                                 # ignored by git; RELAY_HOST, ENTITLEMENT
docker compose up -d                                 # or: podman compose up -d
RELAY_URL=wss://<its host> bun --cwd=../../testing/conformance test
```

Rootless Podman binds ports 80 and 443 only once
`net.ipv4.ip_unprivileged_port_start` is 80 or below.

Without containers, `bun --cwd=hosts/bun run compile` makes
`hosts/bun/dist/p-lens-relay` and `p-lens-issuer`, single executables to run
under systemd behind any proxy holding the certificate. They are set by the
environment: `PORT` (7780 and 7781), `BIND_ADDRESS` (`0.0.0.0`), `DATA_DIR`
(`data`), and what `.env.example` lists.

What a relay keeps is its data directory (the `relay-data` volume): back up
its files with SQLite's own `.backup`, or stop the relay and copy them.

## Deploying the official relay

```sh
cd hosts/cloudflare
cp wrangler.relay.production.example.jsonc wrangler.relay.production.jsonc   # ignored by git; fill in its <…>
bunx wrangler deploy --config wrangler.relay.production.jsonc --dry-run --outdir /tmp/p-lens-relay   # builds it without deploying
bun run deploy:relay
RELAY_URL=wss://<its host> bun --cwd=../../testing/conformance test
```

A gated relay needs its issuer first; `wrangler.issuer.production.example.jsonc`
says how to deploy one, and the relay is then given `ISSUER_URL` and
`ISSUER_PUBLIC_KEY`.

`wrangler dev` is not relied on: the shell is thin, and everything under it is
tested by `bun run test`, and run for real by `hosts/bun`.

## Licence

MIT.
