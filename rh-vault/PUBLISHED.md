# StockLockVault — published (RH Chain mainnet)

Live vault is **V2** (pooled `release(token, amount, to, suiBurnRef)`). v1 no longer accepts deposits.

| Field | Value |
|-------|-------|
| Network | Robinhood Chain mainnet |
| chainId | `4663` |
| **`RH_VAULT_ADDRESS` / StockLockVaultV2** | [`0x3870B3B4767bF96c88828A992448ccF55530f0c9`](https://robinhoodchain.blockscout.com/address/0x3870B3B4767bF96c88828A992448ccF55530f0c9) |
| v1 (retired deposits) | [`0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058`](https://robinhoodchain.blockscout.com/address/0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058) |
| Deployer (admin + releaser + guardian) | `0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc` |

> **Open risk (H-4).** All three roles sit on one EOA. `GUARDIAN_ROLE` exists so a
> separate key can trip the circuit breaker without holding spending power;
> granting it to the releaser defeats that. Not required to keep the bridge up.
| V2 create | see `broadcast/DeployV2.s.sol/4663/run-latest.json` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | https://robinhoodchain.blockscout.com |

## Allowlisted stock tokens

| Ticker | Address |
|--------|---------|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| AMC | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` |
| GME | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` |

## Keeper env

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_VAULT_ADDRESS=0x3870B3B4767bF96c88828A992448ccF55530f0c9
```
