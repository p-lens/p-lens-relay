# p-lens-relay

> **この日本語版が原本です。** [English](README.md) は翻訳で、内容が食い違うときは日本語版に従います。

P-Lens の同期のサーバー側です。帳簿、ライブ計測中の稼働、ノリ打ちを、
Nostr のプロトコルでエンドツーエンド暗号化したまま運びます。適合テストに
通るリレーなら、どれでも運べます。

ビルド・テスト・実行に必要なのは Bun だけです。Cloudflare では Workers として動きます。

```text
hosts/
  cloudflare/   公式のリレーとチケット発行所: Workers と Durable Objects
  bun/          同じものを自前のサーバーで: Bun のプロセス、SQLite のファイル、Docker
packages/
  core/         純粋関数としてのリレー: NIP-01 の照合、保存、置き換え、削除
  gate/         リレーを P-Lens のリレーにする部分
  relay/        SQLite の上の P-Lens リレー。どこで動かしても同じ
  issuer/       SQLite の上のチケット発行所。どこで動かしても同じ
  tickets/      PROTOCOL.md §9.2 のブラインドチケット
  sql/          リレーと発行所がデータを保つための SQLite のポート
  reference/    PLN-1 の鍵と封印の参照実装と、そのテストベクタ
testing/
  fake/         わざと不調にふるまうリレー。クライアントのテスト用
  conformance/  あるリレーで P-Lens を運べるかの確認
```

- `PROTOCOL.md` はプロトコル PLN-1 です。クライアントが書くもの、リレーが
  しなければならないこと、運営者に読めるもの・読めないものを定めます。
- `packages/core` は、メモリ上で純粋関数として動くリレーです。1 本の接続の
  メッセージを 1 つ受け取り、送るメッセージを返します。
- `packages/gate` は PLN-1 でないものを拒み、書き込みを固定の上限か、
  支払われた分に収めます（`open`、`capped`、`gated`）。リレーが持っている
  ものの見え方の上で判断するので、メモリの上でも SQLite の上でも同じ判断が
  動きます。
- `packages/relay` は、SQLite の上の線のバケツです。セッション、保存、
  デプロイの設定、NIP-11、リクエストを受ける入口からなります。
  `packages/issuer` も同じ作りの発行所です。プランはコードのハッシュで
  保存し、ブラインド化したチケットに、プランが毎月許す範囲で署名します。
  支払いのアダプタが運営者の代わりに作るようになるまで、プランは運営者が
  作ります（`ADMIN_TOKEN` 付きの `POST /plans`）。
- `packages/tickets` は RSAPBSSA-SHA384-PSS を、ネイティブの BigInt で
  書いたものです（チケットごとの情報から導く長い公開指数を、ブラウザの
  WebCrypto が受け付けないため）。ドラフトのテストベクタで確かめています。
  発行所の鍵は `bun --cwd=packages/tickets run make-key` で作ります。
- `hosts/cloudflare` と `hosts/bun` は、`packages/relay` と
  `packages/issuer` の薄い殻です。どちらも同じコードで判断し、ホストは
  ソケットを持って SQLite を開くだけです。
- `testing/fake` は、わざと不調にふるまうリレーです。不調（取りこぼし、
  順序の入れ替え、重複、古い版、古いキャッシュ、`OK` を返さない）は
  1 つずつ切り替えられ、Nosflare、nostr-rs-relay、strfry のふるまいを
  まねたプリセットがあります。
- `testing/conformance` は、あるリレーで P-Lens を運べるかを確かめます。
  イベントは PLN-1 の形で作るので、P-Lens のリレーに対しても動きます。

## 確認

```sh
bun install
bun run check                       # すべてのパッケージに tsc
bun run test                        # すべてのパッケージのテスト。リレーが要る conformance は除く
```

## 適合テスト

```sh
bun install
testing/conformance/relays/up.sh                    # nostr-rs-relay を :7777、strfry を :7778 に（podman）
bun --cwd=testing/conformance test                  # ws://127.0.0.1:7777 に対して
RELAY_URL=ws://127.0.0.1:7778 bun --cwd=testing/conformance test
```

本物のリレーの代わりに、偽のリレーを使えます。プリセット（`plain`、
`nosflare`、`nostr-rs-relay`、`strfry`、`chaos`）のとおりにふるまい、
不調は `FAKE_QUIRKS` で、前に置く P-Lens リレーのゲートは `FAKE_GATE`
（`open` か `capped`）で変えられます。

```sh
FAKE_PRESET=nosflare bun --cwd=testing/fake run serve   # ws://127.0.0.1:7790 で
RELAY_URL=ws://127.0.0.1:7790 bun --cwd=testing/conformance test
```

プリセットは本物のリレーと同じ結果になります。plain と strfry はすべての
テストに通り、nostr-rs-relay は 1 秒以内の 2 つの版のうち最初のほうを残し、
Nosflare は出荷時のままだと 1 分に 10 件を超えるイベントも拒みます。

`localhost` ではなく `127.0.0.1` を使ってください。rootless の podman の
ポートは IPv4 でしか応えません。

## 自前のサーバーでリレーを動かす

`hosts/bun` は、1 つの Bun プロセスとしてのリレーです。アドレスのラベル
ごとに SQLite のファイルを 1 つ持ちます。手元のパソコンでは:

```sh
bun --cwd=hosts/bun run relay                       # ws://127.0.0.1:7780 で。ファイルは hosts/bun/data に
RELAY_URL=ws://127.0.0.1:7780 bun --cwd=testing/conformance test
```

サーバー（VPS など）では、Docker か Podman で動かし、前に置いた Caddy が
`wss://` の証明書を取ります。リレーのホスト名を DNS でサーバーに向けてから:

```sh
cd hosts/bun
cp .env.example .env                                 # git では無視される。RELAY_HOST、ENTITLEMENT
docker compose up -d                                 # または: podman compose up -d
RELAY_URL=wss://<そのホスト> bun --cwd=../../testing/conformance test
```

rootless の Podman が 80 番と 443 番を使えるのは、
`net.ipv4.ip_unprivileged_port_start` が 80 以下のときだけです。

コンテナを使わないなら、`bun --cwd=hosts/bun run compile` で
`hosts/bun/dist/p-lens-relay` と `p-lens-issuer` ができます。単体の実行
ファイルなので、証明書を持つ任意のプロキシの後ろで、systemd から動かせます。
設定は環境変数で、`PORT`（7780 と 7781）、`BIND_ADDRESS`（`0.0.0.0`）、
`DATA_DIR`（`data`）と、`.env.example` に並んでいるものです。

リレーが保つのはデータのディレクトリ（`relay-data` ボリューム）です。
SQLite 自身の `.backup` でファイルをバックアップするか、リレーを止めて
コピーしてください。

## 公式のリレーをデプロイする

```sh
cd hosts/cloudflare
cp wrangler.relay.production.example.jsonc wrangler.relay.production.jsonc   # git では無視される。<…> を埋める
bunx wrangler deploy --config wrangler.relay.production.jsonc --dry-run --outdir /tmp/p-lens-relay   # デプロイせずにビルドだけ
bun run deploy:relay
RELAY_URL=wss://<そのホスト> bun --cwd=../../testing/conformance test
```

`gated` のリレーには、先に発行所が要ります。出し方は
`wrangler.issuer.production.example.jsonc` に書いてあり、そのあとリレーに
`ISSUER_URL` と `ISSUER_PUBLIC_KEY` を渡します。

`wrangler dev` には頼りません。殻は薄く、その下はすべて `bun run test` で
テストし、`hosts/bun` で実際に動かしているからです。

## ライセンス

MIT。
