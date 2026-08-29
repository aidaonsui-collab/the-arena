# Mainnet

Published from `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.

- Type origin / original package: `0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`
- Latest published-at (v5): `0x68e178d50276b3bcbce11a136df48909aceff1f2a8ee8a45483e9f128e989972`
- v4 published-at: `0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3`
- v3 published-at: `0x067136624c5bec5221247e9b0a0a1afbd77a79aadbabdac18a95a10bc186cc74`
- v2 published-at (BluefinLockEvent / BluefinPositionLock type origin): `0x8e28ff4116a8c9025b5d615b0b0a7bc45f4f543120f30a9d226e5b94c7277b79`
- Config: `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`
- Pit SUI: `0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`
- Pit XAUM: `0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783`
- AdminCap: `0x79e041a4444971bfbf8000925ac3386d8351a3e997eb7d838d84eb6c3e507acf` (held by the platform wallet)
- UpgradeCap: `0x8db3965ac77247107c811cb79bccd9bf1daf5647136a0b2f8891351a56d73608` (held by the platform wallet, version 5, policy Compatible)
- Publish tx: `4zVLuMuPGG62WrkNCeodwpYs1athobrYymqi3fPULQWt`
- Upgrade v2 tx: `9XJ5cvahK2Un4BBDGBTk3FPREiDodwxVhUACb75YwYX1` (2026-08-29 15:42 CT)
- Upgrade v3 tx: `AtVquqVh1G1FCvQTZyYQ3ZizNYfceDJA36d66gWsWjPW` (fee_rate 100000 → 10000)
- Upgrade v4 tx: `7TSwzJG6nXTQE47vssGFBao4QzkfKWJXZUgGfTmSos6H` (2026-08-29 16:31 CT; Instadex + permanent lock + collect_bluefin_fees)
- Upgrade v5 tx: `ETJ8WZpGFo6JDRVv7UtNiLuXbJBJ4zwCF9gYwL3ciQme` (2026-08-29 17:53 CT; collect_lp_fees 60/10/30 LP quote split)

Call new functions on the latest published-at (`0x68e1…`). Object types stay `0x5cfd…::pool::Pool` etc. `BluefinLockEvent` and `BluefinPositionLock` originated in v2 (`0x8e28…`). `InstadexLaunchEvent` and `InstadexMintLock` originated in v4 (`0xcf78…`). `CollectLpFeesEvent` originated in v5 (`0x68e1…`).

## Bluefin Spot (graduation seed)

- Bluefin original package / named address: `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267`
- Bluefin published-at (current): `0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c`
- GlobalConfig: `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352`
  - type `0x3492…::config::GlobalConfig`, version 9
  - `min_tick.bits` = `4294523660` (−443636)
  - `max_tick.bits` = `443636`
- Clock: `0x6`
- SUI CoinMetadata (what `seed_and_lock_bluefin` wants): `0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3`
  - type `0x2::coin::CoinMetadata<0x2::sui::SUI>`, frozen/immutable
- SUI Currency registry object (NOT CoinMetadata): `0xf256d3fb6a50eaa748d94335b34f2982fbc3b63ceec78cafaa29ebc9ebaf2bbc`
- XAUM: `0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM`
- Pool creation fee (`get_pool_creation_fee_amount<SUI>`): supported = true, amount = 0 MIST
- Arena Bluefin fee_rate: `10_000` (1% in 1e6). `100_000` aborts Bluefin `EInvalidFeeRate` (1027).
- Tick spacing: 60

Graduate PTB objects: Pool, Config, Clock, Bluefin GlobalConfig, CoinMetadata `<T>` and CoinMetadata `<SUI>` `0x9258…`, plus `Coin<SUI>` creation fee when Q is XAUM.

## BFLN smoke (2026-08-29)

- Coin: `0x8c56326db33511006d6dfa74246dc97df12ce0168bfc231003a79cc2599dff82::bfln::BFLN`
- Arena pool: `0xfeab072f1ab7c27bc71c52747495d493fe56b0b417f91fd9a1579b26308c4c69`
- Launch: `Fk9GQ6T2ficawFV6sB7KL8sz5oic7UNtd1GUPpAyTy5q`
- Buy / GraduationEvent: `Ew5UpeQHDc7pL4QWigio1GnytLWqTaL4o8uPecFuvDRb`
- Restore graduation_sui 2000 SUI: `CyUiHVK2xPaef8JuTFRQ2J7jsb9xUj5k6Z5nXepdAHKL`
- Seed: `3YDDfsDkrM8wHvsSRrXLVu7soNwopkhEdvSUSnd9qKo2`
- Bluefin pool: `0x84d4c64059c3c0545073d7a3aec3235ab12b462e8685199031108d3dfb690215` (`0x3492…::pool::Pool<BFLN,SUI>`, shared)
- BluefinPositionLock: `0xaf610d12829d83780c31c0a5064003a0a8e1159037bf664bc2411faf24a293c0` (shared, Position NFT inside)
- Position: `0x274d7158d79d5cc9d9c0b1f5d3b946c0421d76a15a2cc2e655002898faf59304`
- unlock_ms: `1803588372330` (2027-02-25 15:46 CT)

## IDEX Instadex smoke (2026-08-29 16:34 CT)

- Coin: `0xa06b0c015502497b2e2c8401ffe6cc8decac72b95e7d3f5e78352329ed95a852::idex::IDEX` (name INSTA, symbol IDEX)
- Coin publish: `E76A32TSCZbM2n12GuAyHcoxFGBCZ7ZV55a3iJUGVs4q`
- InstadexLaunchEvent: `HkderDNkd3pHD4HPkCLJXEcp76whx2P4rFYSrPfh3AeU`
- unlock_ms: `0` (permanent)
- token_amount: `1000000000` (1 IDEX, 9 decimals)
- quote_amount: `100000000` (0.1 SUI)
- Bluefin pool: `0xeef555117da1f681894e4d6c107be5a894eb1712884ff81199a5b51fe4d88464` (`0x3492…::pool::Pool<IDEX,SUI>`, shared)
- BluefinPositionLock: `0x529aacc564799b7d2623b21d5fe0e2b9337a8d5db797d84eb2266746bb67e2de` (shared, Position NFT inside, type origin v2 `0x8e28…`)
- Position: `0x0d1ee920b41ccbcffe6575eafcdcc5c4899b83065fb1e68e274332252d659f1d`
- InstadexMintLock: `0x38c1667f65f085677a577a48338dd86f6cb8ec1ea4aa0351bbcfb3cb39336e54` (shared, type origin v4 `0xcf78…`; TreasuryCap consumed)
- `claim_bluefin_position` dry-run aborts `still_locked` (20). Did not execute on-chain. Did not remove liquidity.
- `graduation_sui` left at `2000000000000` (2000 SUI).

## IDEX collect_lp_fees smoke (2026-08-29 17:55 CT)

- Buy: `GnvtnPJxFaTr9S3j1rvbS7p1SzdSjgmj3e1UB3Fxx2Lv` (0.01 SUI → 89797741 IDEX; swap fee 100000 MIST)
- Collect: `3zTAALwcwWeYQf73GEVrNt12HiQ8Lf1LwC4QPLVQCTpo` (`0x68e1…::lock::collect_lp_fees<IDEX,SUI>`)
- Bluefin `UserFeeCollected`: coin_a 0, coin_b 79999 (LP quote share; protocol kept ~20%)
- `CollectLpFeesEvent`: token 0, creator 48001, platform 7999, pit 23999 (60/10/30 + 2 dust to creator)
- Creator coin `0xa730d6aaac5de8146e08c8b85dab88f666a4a4a05cc457dbbe55a856eb90267a` = 48001 MIST SUI
- Pit SUI pot 1108499 → 1132498 (+23999)
- Config.platform bag received 7999 MIST SUI
- `collect_bluefin_fees` on v5 dry-run aborts `use_split_collect` (23)
- Position NFT still in lock `0x529a…`, liquidity 316227766, `unlock_ms` 0. `graduation_sui` left at 2000 SUI.
