# Lightning Fork Swap backend

This is the swap backend of Lightning Fork Swap: non-custodial swaps between
on-chain BTC on the **Bitcoin BLAKE2b chain** and that chain's Lightning
network. It is a fork of [Boltz](https://github.com/BoltzExchange/boltz-backend)
by way of [SwapMarket's fork](https://github.com/SwapMarket/boltz-backend),
which carries fixes Boltz did not publish before suspending its own service.

| | |
| --- | --- |
| Base | `SwapMarket/boltz-backend` master `5598c992` = `BoltzExchange/boltz-backend` 3.13.0 (`4d131ef8`, 2026-07-27) + 9 SwapMarket commits |
| Branch | `blake2b` |
| Used with | [Lightning Fork](https://github.com/paulscode/lightning-fork) (lnd 0.21.3 for the BLAKE2b chain), Bitcoin Knots 29.4.x on the BLAKE2b chain |
| Scope | BTC only: submarine (chain → Lightning) and reverse (Lightning → chain) swaps. Liquid, EVM, Ark and chain swaps are still compiled in but not configured. |

The deployment that runs it (config, the txindex shim, nginx) lives in the
[lightning-fork-swap](https://github.com/paulscode/lightning-fork-swap)
repository.

## What the chain changes

The Bitcoin BLAKE2b chain kept Bitcoin's genesis block, `bc1` addresses,
transaction format and key derivation, so Boltz's swap scripts and signing
work unchanged. Taproot swap trees use no `OP_IF`, which the chain's temporary
data rules forbid in tapscript until 2027-09-01. What differs:

- block headers from height 961,640 can be 164 bytes, and their block id is
  a BLAKE2b construction;
- Lightning invoices carry the required feature bit 512 (`option_blake2b`),
  and an invoice from a SHA256-chain node looks the same otherwise;
- a node on the SHA256 chain answers every ordinary query the same way.

## Changes from the base

Each change is one commit on `blake2b`, with its tests.

### For the chain

1. **164-byte block headers** (`8ee16cdf`). `boltzr/src/chain/header_v2.rs`
   (new) reads the header width from the top bit of the version word and
   computes a v2 block id: tagged SHA256, merge-mining hook, two BLAKE2b-256
   passes in one of four ASIC layouts, XOR mask. It is ported from
   `btcd-blake2b/wire/blake2b.go`. `Block::parse` in `boltzr/src/chain/utils.rs`
   splits such a block before decoding its transactions. Without this, every
   block from ZMQ `rawblock` or `getblock … 0` failed to parse, and a rescan
   advanced its tip past lockups it never saw.
   - Tests: 81 mainnet headers (`header_v2_mainnet.json`), 64 headers from the
     Go reference covering every layout and flag (`header_v2_reference.json`),
     and one whole mainnet block (`block_v2_974606.hex`).
2. **Invoices with bit 512** (`5c666c41`).
   - `vendor/lightning-types` is `lightning-types` 0.3.1 with bits 512/513
     treated as known in `requires_unknown_bits` and a `supports_blake2b()`.
     It is wired in with `[patch.crates-io]` in `Cargo.toml`.
   - `boltzr/src/lightning/invoice.rs` adds `decode_blake2b`, which also
     **refuses** invoices and offers without the bit (`NotBlake2bChain`).
   - It is used by the gRPC `DecodeInvoiceOrOffer`, which every TypeScript
     path decodes through, and by the public BOLT12 offer endpoint. Rust
     paths that only serve Core Lightning still use `decode`.
3. **lnd 0.21.3 accepted** (`6e2e8f38`), `lib/VersionCheck.ts`.
4. **Chain identity check** (`c1fecb16`), `lib/chain/ChainIdentity.ts`.
   - On mainnet the backend refuses to start unless block 961640 is
     `0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb`, and
     stops if a ten-minute recheck finds otherwise.
   - A node that cannot answer is refused at start. Regtest is not checked.
5. **Pruned nodes** (`c0d7b4ed`). `NodeInfo` read the oldest channel's
   funding transaction at startup. That needs `-txindex` or an unpruned
   block, so the backend stopped starting once channels aged.
   - It now takes the block time from the header at the height encoded in
     the short channel id.
   - New `IChainClient.getBlockHeader`.
   - The deployment pairs this with a txindex shim for the other lookups by
     transaction id.

### Security fixes

Found by a review of the submarine and reverse swap paths.

6. **Reverse swaps: the hold invoice must outlast the refund** (`0fcd488c`).
   lnd cancels an accepted hold invoice `invoices.holdexpirydelta` (18)
   blocks before its HTLC expires. The invoice asked for only 15 blocks more
   than the on-chain timeout, so lnd cancelled it at the timeout or before.
   The payer then had their payment back and could still claim the lockup
   with the preimage.
   - `TimeoutDeltaProvider.sameCurrencyBuffer` is 60 (was 15).
   - `LightningNursery` cancels the invoice and locks nothing up unless every
     accepted HTLC expires at least `holdExpiryDelta + 12` blocks after the
     lockup's timeout.
   - `MusigSigner` co-signs a claim only once the invoice is settled.
   - lnd now reports HTLC expiries (`Htlc.expiryHeight`).
7. **Coinbase lockups refused** (`c885b4e6`). A coinbase cannot be spent for
   100 blocks, and nodes on this chain do not relay a spend of one for 6480.
   A miner could fund a swap from its coinbase, be paid, and mine its own
   refund after the timeout.
   - `UtxoNursery` fails such a swap (`COINBASE_LOCKUP`), using
     `TxView.isCoinbase()`.
8. **Confirmation depth** (`dc1cb59b`). A lockup was paid against at one
   confirmation.
   - `requiredConfirmations` in a `[[currencies]]` section (default 1) now
     applies to Bitcoin-like chains. A shallower confirmed lockup leaves the
     swap in `transaction.confirmed`, and every block re-checks such swaps,
     which also covers restarts and reorganisations.
   - `RefundWatcher` uses the same setting.
   - The public status reads `transaction.mempool` until the lockup is deep
     enough.
9. **Lockup errors after a broadcast** (`81e862d9`). An error after the
   wallet was asked to send (a lost RPC answer, a database error) failed the
   reverse swap and cancelled its invoice while the lockup could be on chain.
   - `CoreWalletProvider` now reports a node refusal as `NotBroadcastError`.
   - Only that, or an error before sending, fails the swap. Anything else
     leaves the invoice held and logs an error naming the wallet label.

## Configuration this fork expects

Beyond upstream's, for a BTC-only deployment:

```toml
network = "mainnet"            # the sidecar defaults to regtest without it

[swap]
deferredClaimSymbols = []      # claim each swap on its own: a batch that fails
                               # is retried whole and would stall the others
cltvDelta = 72

[[pairs]]
base = "BTC"
quote = "BTC"
swapTypes = ["submarine", "reverse"]
  [pairs.timeoutDelta]
  chain = 1440                 # required by the sidecar even with chain swaps off
  reverse = 1440
  swapMinimal = 1440
  swapMaximal = 2880
  swapTaproot = 10080

[[currencies]]
symbol = "BTC"
network = "bitcoinMainnet"
maxZeroConfAmount = 0
requiredConfirmations = 3
```

- The backend needs exactly one wallet loaded in Knots.
- It finds ZMQ through `getzmqnotifications` and connects at the RPC host.
- It needs `getrawtransaction` by id for recent transactions: `-txindex`, or
  the shim in front of a pruned node.

## Building and testing

```sh
npm ci                                   # also generates protos the Rust build needs
npx tsc --noEmit -p . && npx jest test/unit
cd boltzr && cargo test --bin boltzr -- chain::header_v2 lightning::invoice
docker build -f docker/boltz/Dockerfile --build-arg NODE_VERSION=24-bookworm-slim \
  --build-arg SOURCE=local -t lfswap/boltz:dev .
```

- The Rust tests link against `libpq`. `PQ_LIB_DIR` can point at a copy.
- The full TypeScript unit suite (119 suites) passes on `81e862d9`.
- The Rust tests for the changed modules pass.
- The full Rust suite needs Postgres and the regtest services, and has not
  been run on this fork.
- End-to-end swaps on a regtest BLAKE2b chain live in the deployment
  repository (`e2e/`).

## Following upstream

Upstream Boltz has been suspended since 2026-08-03; its last public commit is
from 2026-07-27. If it or SwapMarket publish more fixes:
- rebase `blake2b` onto the new base;
- re-run the unit suites and the deployment repository's regtest end-to-end
  suite;
- check that `requires_unknown_bits` in a newer `lightning-types` still needs
  the vendored patch.
