# Arena RH StockLockVault (Robinhood Chain)

Lock vault for **RH → Sui** stock wrap on [The Arena](../). Users deposit allowlisted Robinhood stock ERC-20s; keepers mint 1:1 wraps on Sui after `DepositLocked`. After Sui `RedeemBurned`, a `RELEASER` unlocks tokens back to the user.

Sui wrap package (live): `0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db`

## Chain

| Network | chainId | RPC | Explorer |
|---------|---------|-----|----------|
| RH mainnet | `4663` | `https://rpc.mainnet.chain.robinhood.com` | https://robinhoodchain.blockscout.com |
| RH testnet | `46630` | `https://rpc.testnet.chain.robinhood.com` | https://explorer.testnet.chain.robinhood.com |

## Stock token allowlist (mainnet defaults)

| Ticker | Address | Notes |
|--------|---------|-------|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | Official / docs |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | Official / docs |
| GME | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | Blockscout verified RH token |
| AMC | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` | RHJ final terms ledger address |

Override any of these at deploy time with `RH_NVDA` / `RH_AMC` / `RH_GME` / `RH_TSLA`.

## Build & test

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd rh-vault
make install   # forge-std + OpenZeppelin v5.3.0 into lib/
forge build
forge test -vv
```

## Deploy (chain 4663)

**Do not mainnet-deploy without a funded key and explicit go.** Prefer compile+test.

```bash
export PRIVATE_KEY=0x…          # deployer; becomes admin+releaser by default
export ADMIN=0x…                # optional
export RELEASER=0x…             # optional — operator that calls release after Sui burn
# optional token overrides:
# export RH_NVDA=0x… RH_AMC=0x… RH_GME=0x… RH_TSLA=0x…

forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --broadcast \
  --chain-id 4663
```

Testnet (optional, chain `46630`):

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --broadcast \
  --chain-id 46630
```

After deploy, set keeper env:

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_VAULT_ADDRESS=0x…   # StockLockVault address
```

## Roles

- `DEFAULT_ADMIN_ROLE` — allowlist tokens (`setTokenAllowed` / `setTokensAllowed`), grant roles
- `RELEASER_ROLE` — `release(depositId, to)` after Sui burn attestation

## Bridge CTA (Arena pad): approve + deposit

User flow on RH Chain (ethers / viem / wallet):

1. `token.approve(vault, amount)`
2. `vault.deposit(token, amount, suiRecipientBytes32)`

`suiRecipient` is the **32-byte Sui address** (left-padded `bytes32`). Pad CTA should convert `0x` + 64 hex chars.

### Minimal ABI snippet

```json
[
  {
    "type": "function",
    "name": "approve",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "spender", "type": "address" },
      { "name": "amount", "type": "uint256" }
    ],
    "outputs": [{ "name": "", "type": "bool" }]
  },
  {
    "type": "function",
    "name": "deposit",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "token", "type": "address" },
      { "name": "amount", "type": "uint256" },
      { "name": "suiRecipient", "type": "bytes32" }
    ],
    "outputs": [{ "name": "depositId", "type": "uint256" }]
  },
  {
    "type": "function",
    "name": "release",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "depositId", "type": "uint256" },
      { "name": "to", "type": "address" }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "pendingBalance",
    "stateMutability": "view",
    "inputs": [
      { "name": "user", "type": "address" },
      { "name": "token", "type": "address" }
    ],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "type": "event",
    "name": "DepositLocked",
    "inputs": [
      { "name": "token", "type": "address", "indexed": true },
      { "name": "depositor", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false },
      { "name": "suiRecipient", "type": "bytes32", "indexed": false },
      { "name": "depositId", "type": "uint256", "indexed": true }
    ]
  },
  {
    "type": "event",
    "name": "Released",
    "inputs": [
      { "name": "depositId", "type": "uint256", "indexed": true },
      { "name": "to", "type": "address", "indexed": true },
      { "name": "token", "type": "address", "indexed": false },
      { "name": "amount", "type": "uint256", "indexed": false }
    ]
  }
]
```

### ethers example

```js
const vault = new ethers.Contract(RH_VAULT_ADDRESS, STOCK_LOCK_VAULT_ABI, signer);
const token = new ethers.Contract(RH_NVDA, ["function approve(address,uint256) returns (bool)"], signer);
const amount = ethers.parseUnits("1", 18);
const suiRecipient = ethers.zeroPadValue(suiAddress, 32); // 0x + 64 hex
await (await token.approve(RH_VAULT_ADDRESS, amount)).wait();
const tx = await vault.deposit(RH_NVDA, amount, suiRecipient);
const receipt = await tx.wait();
// parse DepositLocked → depositId / rh_tx_hash for keepers-stocks mint
```

## Keeper watcher

`keepers-stocks` polls `DepositLocked` when both are set:

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_VAULT_ADDRESS=0x…
export RH_WATCH_POLL_MS=15000   # optional
npx tsx src/cli.ts watch-rh
```

v1 logs matching events (does not auto-mint). Wire mint enqueue in a follow-up.

## Event topic

```
DepositLocked(address,address,uint256,bytes32,uint256)
```

Keccak topic0 is computed by the watcher from the canonical signature above.
