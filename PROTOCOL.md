# PLN-1: P-Lens over Nostr

Status: draft. Kind numbers are provisional until the first release that
writes them; they were checked against the NIPs registry on 2026-11-04 and
collide with nothing listed there.

PLN-1 is how P-Lens carries what crosses devices over any Nostr relay:

| Product | What it carries | Who pays on the official relay |
|---|---|---|
| Book sync (帳簿の同期) | a book between its owner's devices, and the owner's live plays between them | the book's owner |
| Book sharing (帳簿の共有) | the same book to editors and viewers the owner invites | the book's owner |
| Sending (稼働の送信) | plays sent by invited senders to a book's inbox | the book's owner |
| Huddles (超ノリ打ち) | people playing together on one business day, each shown the others' plays | whoever started it |

A relay carries; it never decides. Every device keeps the whole of what it
has, and a relay that loses, reorders, repeats or withholds events makes a
device late, never wrong.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Two principles

These come before everything else in this document. A design that trades
either for convenience is wrong.

### 1.1 Playing alone never depends on a relay

A person playing alone, with one device, MUST be able to start a play, follow
it, record it into a book, read and revise the book, and pass any of it on by
hand (copied text, a file), with every relay unreachable, every plan lapsed,
and every part of the client that speaks PLN-1 failed. Concretely, a client:

1. MUST treat the book on the device as the source of truth. What PLN-1
   carries is derived from the book after a write has been made, never on the
   path of the write. A write MUST NOT wait for, or be refused because of, a
   relay, a key, an outbox or a lineage store.
2. MUST derive its lineage (§5) from the book, so that a change the lineage
   store missed (a crash between the two) is found by comparing the book's
   digest with the lineage's tip and written as a change of its own.
3. MUST NOT wait on the network to open. Whatever a relay holds arrives after
   the device's own state is on screen.
4. MUST keep the parts that speak PLN-1 apart from the parts that play alone,
   so that the latter import nothing of the former; and SHOULD load the former
   only when something is synced, so that a fault in it cannot stop the app
   from starting.
5. MUST NOT let a lapsed plan, a refused write or a relay that never answers
   change anything on the device but the sync status shown.
6. MAY need a relay for exactly one thing a person does alone: taking over a
   play another of their devices holds (§6.2). Starting a new play on this
   device never needs one.

A relay going down mid-day therefore costs a group what it shares and nothing
each person keeps: everyone goes on playing and recording, and can pass their
figures on by any other means until the relay is back, when everything kept in
the outbox goes out and everything missed comes in.

### 1.2 The operator never reads a book or a play

Whoever runs a relay — the official one or anyone's own — MUST NOT be able to
read what is in a book or a play. Everything else MAY be readable to them, and
this document says which parts are, so that no one is told more is hidden than
is.

Never readable by the operator:

- anything in a book: its journals, settings, title, files, the names its
  owner gives the people invited, and every change made to it;
- anything about a play: parlor, machine, cabinet, money, tokens, readings,
  results, times of play, whether it was recorded, and a huddle member's name.

Readable by the operator, by design:

| What | Where |
|---|---|
| that P-Lens is in use, and which product each event belongs to | `kind` |
| when an event was made, rounded expiry days, an event's padded size | `created_at`, `expiration`, the content's length |
| which events belong together | the opaque `v` and `d` tags, and the author's pubkey |
| who may write to a book or an inbox, and in what role | the access list (§4.3): pubkeys, roles and mailbox locators, no names |
| how many people a book is shared with or sends to, and how many are in a huddle | the access list; a huddle's distinct authors |
| which product, cap and month a book or huddle is paid for | a redeemed ticket's public information (§9) |
| the network address and timing of every connection | the transport |

Readable by nobody, the operator included: which payment paid for which book or
huddle. Tickets are blind (§9).

A client MUST hold to this as follows:

1. Every event's content MUST be sealed (§3.3), except the access list (§4.3),
   whose content is pubkeys, roles and locators only.
2. An event MUST carry no tags but `v`, `d` and `expiration`, except a
   redemption (§9.3), which carries `claim` too.
3. `v` and `d` MUST be derived from secrets (§3.2). Nothing in them may be read
   back as an id, a date, a name or a count.
4. `expiration` MUST be rounded up to a whole UTC day, so that the hour a
   person's business day turns at is not a fingerprint.
5. Live plays' copies MUST be saved at times rounded to 10 seconds, so that
   the moment of a jackpot is not read from when an event was made.

A client SHOULD test this by composing every event it writes from data full of
marker strings and checking that no marker appears anywhere in the event.

## 2. What a relay must do

### 2.1 Required

A relay carries PLN-1 when it:

- speaks NIP-01: `EVENT`, `REQ`, `CLOSE`, `EOSE`, `OK`, `CLOSED`;
- accepts the kinds in §4 and kind 5 (NIP-09);
- accepts an event of at least 48,000 bytes;
- filters by `ids`, `authors`, `kinds`, `#v`, `#d`, `since`, `until`, and a
  `limit` of at least 100;
- accepts `created_at` up to 600 seconds ahead of its clock;
- lets anyone read and write without NIP-42 AUTH (an official relay MAY gate
  writes, §9);
- accepts at least 60 events a minute from one connection.

`testing/conformance` in this repository checks these against a running relay.

### 2.2 Not relied on

A client MUST NOT rely on:

- the order events come back in: it sorts by `(created_at, id)`;
- a relay's default `limit`;
- NIP-40 expiry being enforced;
- an addressable event's same-second tie being broken by the lowest id
  (Nosflare and nostr-rs-relay keep whichever arrived first), so a client never
  writes one address twice in one second (§3.4);
- paging by `until` past a second holding more than a page of events, so a
  client never writes more than 100 events to one `v` in one second;
- anything said in NIP-11 that it has not tried (§10).

## 3. Common rules

### 3.1 Secrets and derivation

Every secret is 32 random bytes. Every key is derived by HKDF-SHA256 with the
salt `p-lens/pln-1` (UTF-8) and a label as `info`, giving 32 bytes:

```
derive(secret, label) = HKDF-SHA256(ikm = secret, salt = "p-lens/pln-1", info = label, L = 32)
```

| Function | Gives |
|---|---|
| `signingKey(secret, name)` | a BIP-340 secret key: `derive(secret, "sign:" ‖ name ‖ ":" ‖ i)` read as a big-endian integer, for the least `i = 0, 1, …` (decimal) giving a value in `[1, n)` |
| `sealKey(secret, name)` | an AES-256-GCM key: `derive(secret, "seal:" ‖ name)` |
| `locator(secret, name)` | a `v`: the first 16 bytes of `derive(secret, "locator:" ‖ name)`, as 32 lowercase hex digits |
| `address(secret, name)` | a `d`: the first 16 bytes of `HMAC-SHA256(derive(secret, "address"), name)`, as 32 lowercase hex digits |

Names are UTF-8. A business day in a name is `YYYY-MM-DD`.

| Secret | Held by | Derives |
|---|---|---|
| `S`, a book's sync secret | the owner's devices | the owner key `O = signingKey(S, "owner")`; the vault `sealKey(S, "vault")`; the plays of a day (§6) |
| `E_n`, a book's epoch secret | the owner, editors, viewers | the book's seal `sealKey(E_n, "book")` and locator `v = locator(E_n, "book")` |
| `m`, one per invitation | the person invited and the owner's vault | an editor's key `M = signingKey(m, "member")`, a sender's key `X = signingKey(m, "sender")`, the mailbox (§4.4), a sender's seal `sealKey(m, "inbox")` |
| `h`, one per huddle | everyone who scanned its code | its seal and locator for a day (§8) |
| a device secret | one device | a huddle participant's key (§8) |

### 3.2 Opaque tags

- Every event carries exactly one `v` tag: the line it belongs to.
- An addressable event carries exactly one `d`, made by `address`.
- Neither is ever chosen by hand or read as anything.

### 3.3 Seal

```
plaintext = pad(deflateRaw(utf8(json)))          sealJson
plaintext = pad(bytes)                           sealBytes
content   = base64(0x01 ‖ nonce(12 random bytes) ‖ AES-256-GCM(key, nonce, plaintext, aad))
aad       = utf8("pln-1") ‖ 0x00 ‖ utf8(decimal kind) ‖ 0x00 ‖ utf8(v) ‖ 0x00 ‖ utf8(d or "") ‖ 0x00 ‖ utf8(pubkey hex)
```

- `pad` is NIP-44 v2's: a 2-byte big-endian length, the bytes, then zeros to
  NIP-44's padded length. What is padded MUST be 1 to 32,000 bytes, so the
  largest content is 43,732 characters and fits an event a relay must take.
- A part (§5.5) is sealed by `sealBytes`: its bytes padded as they are, not
  deflated again.
- A box moved to another kind, line, address or author does not open.
- Anything larger is split into parts (§5.5).
- A client discards, cheaply and silently, any event it cannot open.

### 3.4 Time and order

- `created_at` is the time of sending. For one address, a client writes
  `max(now, last seen + 1)`, the last seen kept on the device and refreshed by
  catching up.
- Every state (addressable content) carries a `stamp` inside its seal that
  rises with each write by that author. A device keeps the highest `stamp` it
  has seen for each address and drops anything older, so a relay cannot roll
  a state back.
- One device writes from one tab at a time (Web Locks); other tabs read.

## 4. Kinds

| Kind | Class | Product | Author | Tags | Content |
|---|---|---|---|---|---|
| 4738 | regular | sync, sharing | `O` or an editor's `M` | `v` | a change, a base's manifest, or a part (§5) |
| 34738 | addressable | sync, sharing | `O` or `M` | `v`, `d` | a device's tip (§5.4) |
| 34742 | addressable | sharing, sending | `O` | `v`, `d` | the access list, in plain text (§4.3) |
| 34743 | addressable | sharing, sending | `O` | `v`, `d` | a mailbox (§4.4) |
| 34739 | addressable | sync | `O` | `v`, `d`, `expiration` | a play's copy: its head or a piece (§6) |
| 34740 | addressable | sending | a sender's `X` | `v`, `d`, `expiration` | a sent play's latest state (§7) |
| 34741 | addressable | huddles | a participant's `P` | `v`, `d`, `expiration` | a play shown or taken back, or a member's leaving (§8) |
| 28934 | ephemeral (NIP-43) | all | `O` or `P` | `claim`, `v` | a ticket redeemed (§9.3) |
| 5 | regular (NIP-09) | all | the author | `e` | deleting one's own events |

One product is one set of kinds, so that a relay can gate, keep and limit each
product on its own, and an operator can run any subset of them.

### 4.1 Lines

| Line | `v` |
|---|---|
| a book, epoch `n` | `locator(E_n, "book")` |
| a book's plays on a business day | `locator(S, "plays:" ‖ day)` |
| a book's inbox | `locator(S, "inbox")` |
| a book's access list | `locator(S, "access")` |
| an invitee's mailbox | `locator(m, "mailbox")` |
| a huddle on a business day | `locator(h, "huddle:" ‖ day)` |

### 4.2 Roles

Roles are kept by the receiving device, which checks every author against the
book's roster (§5.6). A relay that enforces nothing (`ENTITLEMENT=open`) loses
nothing of correctness.

| Role | Holds | Writes |
|---|---|---|
| owner | `S` | everything of the book |
| editor | `m`, `E_n` | changes and its own tip, signed by `M` |
| viewer | `m`, `E_n` | nothing: it holds no signing key |
| sender | `m` | its own sent plays in the inbox, signed by `X`; it cannot read the book |

An invitee's own devices each join by the same invitation code (§4.4), so
that an editor writes as `M` from any of them, each device under a name of its
own (§5.4).

### 4.3 The access list (34742)

Written by `O` on `locator(S, "access")`, one event per product
(`d = address(S, "sharing")` and `d = address(S, "sending")`). Its content is
not sealed:

```json
{ "product": "sharing",
  "members": [ { "role": "editor", "pubkey": "<hex>", "mailbox": "<v>" },
               { "role": "viewer", "mailbox": "<v>" } ],
  "stamp": 12 }
```

- `product` is `sharing`, whose members are editors and viewers, or `sending`,
  whose members are senders.
- Each pubkey and each mailbox appears once. An object has exactly the fields
  shown and no others, so a name or a note has nowhere to go; a P-Lens relay
  refuses anything else.
- An owner keeps one list per product, at one `d`.

Pubkeys and mailboxes are derived from a secret made for each invitation, so
the list says how many and in what role, never who. A capped or gated relay
(§9) reads it to decide who may write.

### 4.4 Mailboxes (34743)

Written by `O` on the invitee's `locator(m, "mailbox")`, with
`d = address(m, "mailbox")`, sealed by `sealKey(m, "mailbox")`. It carries
what the invitee needs and nothing it should not have:

```json
{ "role": "editor", "epoch": 1, "secret": "<E_n, base64url>", "stamp": 1730000000 }
{ "role": "sender", "title": "<the book's title>", "inbox": "<the inbox's v>", "stamp": 1730000050 }
{ "role": "viewer", "removed": true, "stamp": 1730000100 }
```

| Field | Editor | Viewer | Sender |
|---|---|---|---|
| `role` | yes | yes | yes |
| `epoch` (`n`) and `secret` (`E_n`) | yes | yes | no |
| the book's title, the inbox's `v` | no | no | yes (§7) |
| `removed: true`, in place of the rest | when removed | when removed | when removed |

- `stamp` is the owner's clock in seconds when the mailbox was written, and
  later than the last stamp written there; a device keeps the highest.
- An editor or a viewer reads the book's title from the book itself; a sender,
  who cannot read the book, from the mailbox, as it was when it was written.

An invitation code carries `m`, `O`'s pubkey and the relay's address:

```
p-lens-invite:1:<m>:<O>:<relay address>
```

`m` in base64url without padding, `O` in lowercase hex, the relay's address with
its label (§10). Whoever holds it is that invitee: it is handed to one person,
and shown again on the owner's devices from the vault (§5.6).

## 5. Books

### 5.1 Changes

A book's line holds its changes: a graph of them, each naming the changes it
was made on. There are three sorts:

```
Base  = { sort: "base",  parents: ChangeId[], writer: pubkey, at: seconds,
          book: string, files: { <path>: <text> }, result: StateDigest }
Edit  = { sort: "edit",  parents: [ChangeId], writer: pubkey, at: seconds,
          patches: FilePatch[], result: StateDigest }
Merge = { sort: "merge", parents: [ChangeId, ChangeId], writer: pubkey | "",
          at: seconds, patches: FilePatch[], result: StateDigest }

FilePatch = { path, created: boolean, hunks: [ { at, removed: [line], added: [line] } ] }
```

- A change's state is the book it leaves: a base's is its files; an edit's is
  its patches made on its parent's state; a merge's is its patches made on its
  first parent's state. A state never depends on anything but the change and
  its ancestors, so every device works out the same one.
- A patch's hunks are in order of `at`, the line its stretch begins at in the
  text before (lines split at `\n`; an empty text has none). Each hunk names
  the lines it takes away, so a patch made on a text it was not made from is
  found, never made.
- `result` is the SHA-256, in lowercase hex, of the state as canonical JSON
  (RFC 8785): an object of path to text.
- `ChangeId` is the SHA-256, in lowercase hex, of the change as canonical
  JSON. The same change sent twice is one change, whoever sent it.
- `at` is seconds since the epoch; `book` is the book's id on the devices,
  carried so that a device joining keeps the book under the same id.
- A device that makes a change and does not reach its `result` stops on that
  line and says so. It never goes on as a different book.
- A change comes in an event its `writer` signed; a merge with an empty
  `writer` may come in anyone's. Which changes are taken is the roster's to
  say (§5.6), never who carried them.

### 5.2 Heads

The book on a device is the state of its line's one head: the change no other
change it holds names as a parent. A device holding two or more heads merges
them (§5.3), two at a time, lowest `ChangeId` first, until one is left.

A device writes a change of its own, an edit on its head, whenever its book is
no longer its head's state, however the book came to differ: compared by
digest, so that a write the line missed (§1.1) is never lost.

### 5.3 Merging

Two heads are merged three ways, from their merge base: the common ancestor
that is no ancestor of another common ancestor; where there are several, the
one furthest from the line's first base, then the lowest `ChangeId`.

| File | How |
|---|---|
| `settings.json`, `pln:roster` (§5.6) | key by key at its top level; the result must parse |
| any other | line by line |

- What only one side changed is taken from it; what both changed alike is
  taken once.
- Lines each side added at one place are both kept, the lower `ChangeId`'s
  first.
- The merge is `{ sort: "merge" }` with the two heads in `ChangeId` order, its
  patches made on the first's state, `writer` empty and `at` the later of the
  two: every device that merges the same two heads makes the same change.
- A conflict stops the merge and is put to a person, never guessed at: one
  place changed two ways, a key set two ways, one `play-id` recorded on both
  sides, a state the client's hledger cannot read, or JSON that does not
  parse. The person's choice is written as a merge with their own `writer`
  and the time they made it.
- A book in conflict stays writable at its own head; the merge is offered
  again as either side moves.

### 5.4 Tips

Each device writing a line keeps its heads in a 34738 state:
`d = address(E_n, "tip:" ‖ pubkey ‖ ":" ‖ device)`, `device` being 32
lowercase hex digits the device draws when it begins or joins the line, so
that one author's devices never write one address.

```json
{ "heads": ["<ChangeId>"], "base": { "id": "<ChangeId>", "created_at": 1730000000 }, "stamp": 7 }
```

- `base` is the latest base among the heads' ancestors, and when its event
  was made.
- A device joining a line reads every tip, then the line from the earliest
  `base.created_at` named, less 3,600 seconds.
- On every catch-up a device reads every tip. A head it does not hold, or a
  parent of a change it holds, sends it to read the line again from the
  earliest `base.created_at` named, less 3,600 seconds: a change is known by
  its `ChangeId`, which is no event id to ask for.
- Any device holding a signed event may send it again, so what a relay lost
  comes back from whoever has it.

### 5.5 Bases and parts

- Only `O` writes a base: on starting a line, and after 300 changes or 1 MB of
  patches since the last base its head descends from; never while it holds
  more than one head. Its parents are the head it was made from (none when
  the line starts).
- `O` also writes a base on catching up, where nothing waits in its outbox and
  the relay holds nothing of the line in the second its head's base was made:
  the relay lost the line, and a device joining reads from the new base.
- A 4738 event's sealed JSON is `{ "change": Change }`, or a manifest
  `{ "parts": ["<event id>", …], "sha256": "<hex>" }` where the change's
  deflated canonical JSON is over 32,000 bytes: cut into pieces of 32,000
  bytes, each sealed by `sealBytes` as a 4738 event of its own (a part), the
  manifest naming the parts' event ids in order and the SHA-256 of the
  deflated whole. Parts are sent before their manifest.
- A device keeps a 4738 it cannot open as JSON until a manifest names it.
- `O` MAY delete, by NIP-09, a superseded base and changes over 90 days older
  than the latest base.

### 5.6 The roster

The roster is a file of the book's state at the path `pln:roster`, which a
device keeps with its line and never shows as part of the book. It is a JSON
object written one key to a line, as `settings.json` is, and merged key by key
as it is (§5.3). It is absent until the owner first invites anyone.

```json
{
  "epoch": { "n": 1, "secret": "<sealed>" },
  "member:<mailbox v>": { "role": "editor", "pubkey": "<M, hex>", "vault": "<sealed>" },
  "member:<mailbox v>": { "role": "viewer", "vault": "<sealed>" },
  "member:<mailbox v>": { "role": "sender", "pubkey": "<X, hex>", "vault": "<sealed>" }
}
```

- `epoch` is the book's epoch `n` and its secret `E_n`; absent, the line is at
  epoch 0, whose secret the sync code carries.
- A member is keyed by their mailbox's `v` (§4.4), which every role has. An
  editor's entry names `M`, a sender's `X`; a viewer's names no key. A sender
  is in the roster so that the owner's devices know whose sent plays to open
  (§7); a sender writes nothing to the book's line.
- The vault is what only the owner's devices read: each `vault` is
  `{ "name": <what the owner calls them>, "m": <m, base64url> }`, and `secret`
  is `E_n` in base64url, each sealed by `sealJson` under `sealKey(S, "vault")`
  at the place kind 4738, `v` empty, `d` the key it is under (`epoch` or
  `member:<mailbox v>`), pubkey `O`.

Whether a change is taken is worked out from the change and what it was made
on, so that every device holding the same changes takes the same ones. A
change is taken when each of its parents is — a base, whole in itself, when
each of its parents the device holds is, so that one read from without what
it was made on is taken all the same — and:

| Change | Taken when |
|---|---|
| a base | its `writer` is `O` |
| an edit by `O` | always |
| an edit by anyone else | its `writer` is an editor's `M` in its parent's roster, its patches do not touch `pln:roster`, and the state it leaves keeps the title `main.journal` gives (`; book-title-p:`) and `settings.json`'s `order` and `businessDayTurn` as they were |
| a merge with an empty `writer` | it is the merge its parents come to (§5.3), worked out again |
| a merge a person settled | its `writer` is `O`; or an editor's `M` in its first parent's roster, and the roster it leaves is its parents' merged key by key from their merge base |

A change not taken is held but never a head, and so is every change made on
one. A line not shared with anyone has no roster: every change on it is `O`'s,
or a merge any device would make alike.

### 5.7 One's own devices

The owner's other devices join a book's line by its sync code, shown as a QR
code or text on a device already on the line:

```
p-lens-sync:1:<S>:<E_n>:<relay address>
```

`S` and `E_n` in base64url without padding, the relay's address with its
label (§10). The code is the book's key: whoever holds it is the owner.

### 5.8 Inviting, removing, leaving, renewing

- **Inviting**: an owner's device makes `m` and writes, in this order, an edit
  adding the member to the roster, the access list of the member's product
  (§4.3) as the roster now stands, and the member's mailbox: the epoch's
  secret to an editor or a viewer, the book's title and inbox to a sender. The invitation code
  (§4.4) is handed to the person, and shown again from the vault on any of the
  owner's devices.
- **Joining**: a device reads its mailbox, signed by `O`. A sender's device
  keeps the book's title and inbox as somewhere to send plays to, and nothing
  of the book. Any other device takes the epoch's secret; then the line as a joining owner's device does (§5.4), every author's
  tips with it, and takes the book as the latest head among the changes taken
  (§5.6) leaves it. It keeps the book in the role the mailbox gives.
- **Writing**: an editor's devices write their changes and tips as `M`. A
  viewer writes nothing; whatever its book became on its own is put back to
  its head's state.
- **Removing an editor or viewer**: an owner's device catches up, makes
  `E_{n+1}`, and writes, in this order: an edit `R` taking the member out of
  the roster and setting `epoch` to `n+1`, on the old line; a base on `R`, and
  its tip, on the new line; `removed` to the removed one's mailbox, while the
  access list still lists it, so that a capped or gated relay (§9) takes it;
  the access list; and the new epoch to every remaining mailbox.
- **Moving to a new epoch**: a device learns of `E_{n+1}` from its mailbox, or,
  on an owner's device, from its head's roster. It reads the new line from
  then on, and none of the old. Once it holds a base read off the new line
  whose roster says `n+1` (the epoch's floor), it takes as heads only changes
  on the floor or made on it; its own book is then compared with its head's
  state by digest (§5.2), so that anything it wrote that the new line lacks
  goes as an edit of its own. Its changes on the old line are not sent again.
- **What a removal leaves open**: until a device learns of the new epoch, it
  may take a change the removed member wrote meanwhile, and carry it into the
  new epoch in an edit of its own; and the removed member may read what was
  written on the old line meanwhile. A capped or gated relay (§9) refuses the
  removed member's writes once the access list no longer lists them.
- **Removing a sender**: an owner's device writes an edit taking the sender
  out of the roster, `removed` to their mailbox while the access list for
  sending still lists it, and then that access list; no new epoch, as a
  sender holds nothing of the book. From the edit
  on, the owner's devices open nothing the sender's `X` writes.
- **Leaving**: the leaver's devices forget the line. Their books stay as they
  stood. The owner removes them to stop them reading.
- **Renewing** (a lost device, or a move to another relay): the owner settles
  the old line, makes a new `S`, `E` and `m` for everyone, writes a base on the
  new line naming the old tips, and writes `renewed` to the old mailboxes.

## 6. Plays between one's own devices

A play followed live is copied between the owner's devices on the line of its
book and its business day.

- `v = locator(S, "plays:" ‖ day)`, sealed by `sealKey(S, "plays:" ‖ day)`,
  signed by `O`; `day` is the play's business day. A device reads today's,
  yesterday's and the day before's lines in one filter.
- A play's book is the one it is to be recorded into: the one said for it, or
  else the one the device holding it would record it into when it first
  copied it, which that device keeps with the play.
- Everything on the line is a copy (34739): one device's play at one
  generation, `gen`. Which device wrote it, `device` (32 lowercase hex digits,
  the same as in its tips), is inside the seal.
- `expiration` is the start of the UTC day three days after the play's
  business day.

### 6.1 Copies

A copy is a head and, for a long log, the pieces the head names:

| Address | Content |
|---|---|
| `address(S, "copy:" ‖ playId ‖ ":" ‖ gen ‖ ":" ‖ device)` | the head: `{playId, gen, device, stamp, play, pieces, tail}`, or, once the play has left the line, `{playId, gen, device, stamp, ended}` |
| `address(S, "piece:" ‖ playId ‖ ":" ‖ gen ‖ ":" ‖ device ‖ ":" ‖ i)` | piece `i`: `{playId, gen, device, index, lines}` |

- `play` is the play as the device keeps it, without its log and without the
  history of its log.
- The log is its lines in order. `pieces` lists the SHA-256 (lowercase hex) of
  the canonical JSON (RFC 8785) of each piece's `lines`, and `tail` holds the
  lines after the last of them; the log is the pieces' lines and then the
  tail's. A writer makes every piece's `lines` at most 30,000 bytes as JSON, so
  that any piece fits one seal, and keeps the pieces it made before where the
  log only grew, so that adding a line rewrites the head alone. Where the play
  and its tail do not fit one seal, the tail is made a piece too and left
  empty.
- A reader holds a copy once it has a piece for every hash its head lists, and
  until then keeps the copy it had.
- `ended` is `deleted` when the play was given up, and `moved` when it is to
  be recorded into another book.
- `stamp` rises with every head one device writes for the play (§3.4).

### 6.2 Holding

- The holder of a play is the device of the head with the greatest
  `(gen, SHA-256(playId ‖ ":" ‖ device))`, the hash compared as lowercase hex;
  every device picks the same. Only the holder writes the play.
- **Starting a play** never needs the relay: the device holds it at `gen` 0
  and copies it, its copies waiting in the outbox.
- **Taking a play over** does (§1.1): a device writes a copy of the holder's
  copy as it has it, at the holder's `gen` + 1, and holds the play once the
  relay has said within 3 seconds that it kept every piece and the head; it
  refuses to take over otherwise, and goes on following.
- **Yielding**: a device holding a play that sees a head above its own lets
  the play go and follows it. Whatever it wrote that the new holder's copy
  does not have is lost, and the device says so.
- **Leaving the line**: the holder writes `ended`, and a device following the
  play lets it go.
- **Recording** waits on nothing. A device overtaken without knowing it
  records a play another device records too; the book's merge puts the play
  recorded twice to a person (§5.3). A recorded play stays on its line, to be
  set right and recorded again, until its day is past.

### 6.3 Freshness

- The holder writes its copy 3 seconds after a change, at most once every 3
  seconds, and once more as the page is hidden, each at a time rounded down
  to 10 seconds (§1.2) and later than the last for its address (§3.4).
- There are no pulses: a play changes at the pace of a person typing, and the
  relay keeps only the latest head of each address.

## 7. Sending

A sender plays on their own device and sends the plays they choose to a
book's owner, who records them into the book; the sender reads nothing of the
book, and senders read nothing of each other.

- Every sender writes to the book's one inbox, `v = locator(S, "inbox")`, which
  their mailbox gives them (§4.4): kind 34740, signed by their own `X` and sealed
  by their own `sealKey(m, "inbox")`, `expiration` as a copy's (§6).
- A sent play is a head and, for a long log, its pieces, as a copy is (§6.1),
  at `gen` 0, `device` the sending device's own name: the head at
  `d = address(m, "play:" ‖ playId)`, piece `i` at
  `d = address(m, "piece:" ‖ playId ‖ ":" ‖ i)`. Its `play` leaves out what is
  the sender's own: the book they keep it in, their recording of it, and the
  savings their book keeps at its parlor (the parlor's `pools` empty).
- A play is sent from when the person chooses to, written 3 seconds after it
  changes and at most every 30 seconds, and once more as the page is hidden. A
  play given up, or sent no longer, is written as `ended: "deleted"`. There is
  no pulse: two hundred senders every 3 seconds would be 67 events a second at
  the owner.
- The owner's devices read the inbox by `#v`, kind and the authors the roster
  names as senders, open each event with the key of the sender its author is,
  and drop events by any other author. On reopening, the owner receives every
  sender's latest states at once; nothing of them is kept on the owner's
  devices, the relay holding each until its expiration.
- The owner records a sent play into the book as it last came, its tally
  naming who sent it; recorded again, it replaces what the book has of it.

## 8. Huddles

- A huddle's code is `p-lens-huddle:2:<h>:<day>:<relay>`: `h` in base64url,
  the business day it was begun on as `YYYY-MM-DD`, and the address of the
  relay its line is at, its label included (§10). It is shown as a QR code
  only. A code whose day is not the reader's business day is refused as over.
- `v = locator(h, "huddle:" ‖ day)`; sealed by `sealKey(h, "huddle:" ‖ day)`.
- A participant signs with
  `P = signingKey(derive(h, "device:" ‖ seed), "participant:" ‖ day)`, the
  seed 32 random bytes the device keeps with the huddle: the same device
  reading the code again the same day is the same participant, and no
  participant can replace another's states. A member is known by `P`'s
  pubkey.
- States (34741), each at an address of its own under the participant,
  sealed JSON:

  | Address | Content |
  |---|---|
  | `address(h, "play:" ‖ playId)` | the play as its device has it, without its book, marks or history, under the member and the name they go by and when it was shown; or, once taken back, the play's id alone |
  | `address(h, "word")` | that the member came in, or left, and when: written as the device opens the line and again under a new name, so the others have the member in the room before any play; and as it leaves. The later stands. |

  Every content names its member; a device drops one that names another
  member than its author.
- A play's state is written when its log changes, at most every 3 seconds in
  a room of up to 6 people, every 10 up to 20, every 30 beyond, and once more
  as the page is hidden. There are no pulses: a play changes at the pace of a
  person typing, and the relay keeps only the latest state of each address.
- A device keeps the line open while its page is in sight, and lets it go a
  few seconds after the page is hidden; on showing again it reads every state
  of the line at once.
- A member from whom nothing has arrived for 90 minutes is shown as idle. No
  keep-alive is sent.
- Totals and settling are computed on each device from the same states and
  are never written.

## 9. The official relay's gate

A relay runs in one of three modes, set by `ENTITLEMENT`:

| Mode | For | Writes accepted |
|---|---|---|
| `open` | anyone's own relay | everything in §4 |
| `capped` | the official relay before payment | everything in §4, within the caps in §9.4 |
| `gated` | the official relay with payment | what a redeemed ticket covers, within its caps |

Reads are never gated: everything read is sealed, and gating reads would only
cost the clients NIP-42.

In every mode, a P-Lens relay refuses what is not PLN-1 (`blocked:` or
`invalid:`), so that a client's mistake cannot leave anything readable in its
store:

- a kind not in §4;
- a tag its kind does not carry, a tag twice, a third part in a tag, a `v` or
  `d` that is not 32 lowercase hex digits;
- an `expiration` that is not a whole UTC day;
- content that cannot be a seal (§3.3: base64 of version 1, a nonce, a padded
  length NIP-44 gives, and a tag), except an access list's and a redemption's,
  which is empty;
- a deletion carrying a reason or any tag but `e` and `k`.

Unless it is open, it also takes:

- a mailbox only from its owner, and only for a mailbox on that owner's access
  list;
- a sent play only from a sender on an access list.

### 9.1 What is paid for

| Product | Bound to | Cap |
|---|---|---|
| sync | `O` | one book; also opens its plays (34739) |
| sharing | `O` | members in its sharing access list (editors and viewers) |
| sending | `O` | members in its sending access list (senders) |
| huddles | the huddle's `v` | distinct authors |

- A book's line (4738, 34738) opens with either sync or sharing. An editor on
  the owner's sharing list may write it while the owner pays for sharing.
- A mailbox opens with the product of the access list it is on.
- On a gated relay, a deletion is taken only from an owner who pays for
  something or a member on a list, so that deletions cannot fill the store
  unpaid.

### 9.2 Tickets

- Issued by a separate issuer, behind which sits whatever takes the payment.
  The relay knows only the issuer's public key, and names the issuer and that
  key in its NIP-11 document (`pln.issuer: { url, key }`). A client blinds
  under the key the relay names, never one the issuer hands it, so that the
  issuer cannot single a device out by a key of its own.
- A ticket is a partially blind RSA signature (RSAPBSSA-SHA384-PSS-Randomized:
  RFC 9474 with draft-amjad-cfrg-partially-blind-rsa) over a random message of
  64 bytes, with public information
  `pln-1;product=<sync|sharing|sending|huddles>;cap=<n>;period=<YYYY-MM>`.
  Each public information derives a public exponent half as long as the
  modulus, which WebCrypto in browsers refuses; `packages/tickets` computes
  it in BigInt.
- A ticket is redeemed as its `claim`: the public information, the message
  and the signature, each base64url, joined by dots. Once spent, the relay
  knows it by its message's SHA-256.
- The payer's device holds a plan code. A plan is a set of items, each a
  product at a cap with a number of tickets a month, for a run of months; a
  bundle is a plan of several items, the issuer's matter alone, since the relay
  only ever sees one product's tickets.

#### Asking the issuer

```
POST <issuer>/tickets
{ "code": "<plan code>", "tickets": [ { "info": "<public information>", "blinded": "<base64>" }, … ] }

200 { "signatures": [ "<base64>", … ] }       in the order asked
400 { "error": { "type": "too-many", "product", "cap", "period", "left" } }
    and "not-in-plan", "wrong-period", "plan-not-started", "plan-over",
    "too-many-at-once" (over 64), "malformed"
404 { "error": { "type": "unknown-plan" } }
```

- A month's tickets may be asked for during that month, and the next month's
  during the last 7 days of this one.
- The issuer keeps each plan under its code's SHA-256 and counts what it has
  issued for each item and month; it keeps no blinded message and no time of
  asking.
- A device SHOULD ask for a month's tickets all at once, at a random moment
  in the week before the month (or on first opening in it), and redeem each
  only when a line needs it, so that the time of asking does not point to the
  time of redeeming.

### 9.3 Redeeming

A 28934 event signed by what the ticket binds (`O`, or for a huddle a
participant `P`), with a `claim` tag holding the ticket and a `v` tag naming
the line (`locator(S, "access")` for a book's products; the huddle's own `v`).
The relay checks the signature and that the ticket was never spent, then binds
the product, cap and month to `O` or the `v`. It answers with `OK` and a
reason, or `invalid:` and why. A redemption is never stored and never passed
on to a subscriber.

- A ticket may be redeemed from 7 days before its month.
- Writes go on for 3 days after its month, so that a device opening on the
  first has time to redeem the next.
- Where two grants hold at once, the larger cap holds.

Tickets for one person's books are redeemed one by one under each book's own
`O`, so the relay cannot tell that two books are the same person's.

### 9.4 Caps

| Product | `capped` | `gated` |
|---|---|---|
| sharing | 30 members | the ticket's cap |
| sending | 200 members | the ticket's cap (more by arrangement) |
| huddles | 30 authors | the ticket's cap (4, 10 or 30) |

A write over a cap is answered `restricted: full`; so is a member's write
while a smaller plan leaves the owner's list over its cap, until the owner
trims it. A write with no paid month
is answered `restricted: pass-required`; reads go on for 30 days after a month
lapses, so that a book can be moved to another relay, and the line is pruned
after.

## 10. Choosing a relay

A client tries a relay once per client version before using it:

1. Reads NIP-11 and lowers its part size and `limit` to what is stated.
2. With a throwaway key: writes a 44 KB event and reads it back by `ids` and
   `#v`; sees an event cross to another subscription as it is written; writes
   one address twice a second apart; writes 20 events in 15 seconds; deletes
   them by NIP-09.
3. Calls the relay `usable`, `usable-smaller{limit}` or `unusable{reason}`.

A line's code always carries its relay's address. A device keeps only which
relay to start new lines on for each product, the official one by default.

When a relay's NIP-11 document says `"pln": { "labels": N }`, a device
starting a book or a huddle gives it an address of its own: the relay's address
followed by `/` and a label, two lowercase hex digits drawn at random below
`N`. Every line of that book (the book, its plays, its access lists, its
mailboxes, its inbox) uses that address, and so does every code made for it.
A relay that says nothing of labels is used at its address as it is.

## 11. Connecting and catching up

- One WebSocket per address carries every line at it: one for each book and
  each huddle on a relay with labels, one for the relay otherwise.
- On hiding, everything unsent goes out once; the socket closes on `OK` or
  after 3 seconds. The device keeps its lines and everything it read of them
  until the page is gone.
- On showing, coming online or losing the socket, it opens again at once, with
  backoff from 1 to 60 seconds and jitter while it keeps failing.
- Each time the socket opens, the live subscription is asked again from that
  moment (`since = now − 30`), then each line catches up, paging by the
  oldest `created_at` (`limit = min(500, max_limit)`) and dropping repeated
  ids:
  - a book's changes from its mark (`since = mark − 3600`,
    `until = now + 600 + random(0..3600)`), and its tips whole;
  - copies, sent plays and huddle states whole the first time, and from the
    mark after (`since = mark − 120`), so that a socket opened again carries
    only what changed. A state signed more than two minutes before it reached
    the relay may be missed until its author writes again, or the page is
    opened anew.
- At every `EOSE` the device reconciles: tips, missing changes. A line's mark
  moves to when its finished catch-up began, never by live events; a book's
  is kept on the device, the others' for as long as the page is open.
- The outbox keeps signed events in the device's storage until `OK true` or
  `duplicate:`, and sends the same event again until then, at most 40 a minute;
  of a copy's head it keeps only the latest for each address.
- While visible, if nothing has arrived for 45 seconds, the device asks for
  a random id; no `EOSE` in 10 seconds reopens the socket.

## 12. Running a relay

Every P-Lens relay in this repository decides by the same code
(`packages/relay`, over `packages/core` and `packages/gate`); a host is a thin
shell over it.

- **Official** (`hosts/cloudflare`): a Cloudflare Worker in front of one
  Durable Object, a bucket, for each host and label (§10), so that a socket
  ends in the one bucket holding everything its book or huddle needs, the
  gate's lists and grants included. A bucket holds its sockets by WebSocket
  hibernation and sleeps between messages; it keeps its events in its own
  SQLite, and each socket carries its own subscriptions through hibernation,
  in SQLite only when they are larger than a socket may carry. It is woken by
  an alarm only when something it keeps runs out. Nothing is ever moved between
  buckets: a label is fixed when a line starts. Each product may have a host
  of its own, so that one can later be moved to a deployment of its own by
  DNS.
- **One's own on Cloudflare**: the same, with `ENTITLEMENT=open`.
- **One's own on a server** (`hosts/bun`): one Bun process, with a SQLite file
  for each label, behind a proxy that holds the certificate (Caddy, in the
  compose file given). One process keeps one host's buckets, by their labels
  alone; a host of its own is a process of its own.
- **One's own anywhere**: any relay passing `testing/conformance` (strfry,
  nostr-rs-relay). Rely on `O`'s NIP-09 deletions to keep it small.

## Appendix A: test vectors

`packages/reference` holds the reference implementation of §3 (derivation,
padding, the seal) and `packages/reference/vectors/pln-1.json`: every key,
seal key, line and address of §3 and §4.1 worked out from fixed secrets,
NIP-44's padded lengths, and one sealed play copy with its nonce and its
deflated bytes. Deflating is
not deterministic between implementations, so an implementation checks that it
seals the given deflated bytes to the given content, and that it opens the
content back to the JSON.

```sh
bun --cwd=packages/reference test         # the reference against the vectors, and @noble's HKDF, HMAC and AES-GCM against both
bun --cwd=packages/reference run vectors  # write the vectors again, only when §3 changes
```
