# Mainnet

Published from `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.

- Package: `0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`
- Config: `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`
- Pit SUI: `0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`
- Pit XAUM: `0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783`
- AdminCap: `0x79e041a4444971bfbf8000925ac3386d8351a3e997eb7d838d84eb6c3e507acf` (held by the platform wallet)
- UpgradeCap: `0x8db3965ac77247107c811cb79bccd9bf1daf5647136a0b2f8891351a56d73608` (held by the platform wallet)
- Publish tx: `4zVLuMuPGG62WrkNCeodwpYs1athobrYymqi3fPULQWt`

## Bluefin Spot (graduation seed)

Linkage ready: types on `0x3492…`, CALLs on published-at `0xd075…` (`contracts/deps/bluefin_latest`). Upgrade of this Arena package is the remaining step.

- Bluefin original package / named address: `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267`
- Bluefin published-at (current): `0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c`
- GlobalConfig: `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352`
  - type `…::config::GlobalConfig`, version 9
  - `min_tick.bits` = `4294523660` (−443636)
  - `max_tick.bits` = `443636`
- Clock: `0x6`
- SUI CoinMetadata: `0xf256d3fb6a50eaa748d94335b34f2982fbc3b63ceec78cafaa29ebc9ebaf2bbc`
- XAUM: `0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM`

Graduate PTB objects: Pool, Config, Clock, Bluefin GlobalConfig, CoinMetadata `<T>` and `<Q>`, plus `Coin<SUI>` creation fee when Q is XAUM.
