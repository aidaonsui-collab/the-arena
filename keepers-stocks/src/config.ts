/** RH → Sui stock wrap attestor config (see contracts-stocks/PUBLISHED.md). */
import { join } from "node:path";
import { fileURLToPath } from "node:url";


export const STOCKS_PACKAGE =
  process.env.ARENA_STOCKS_PACKAGE ??
  "0x9a4ba3338384d36033065f9cf0c58078033a718a92f091f12a551f6984c290c5";

/** Publisher / MinterCap holder — do NOT transfer caps off this address. */
export const MINTER_HOLDER =
  "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";

/** Robinhood Chain mainnet StockLockVault (chainId 4663). */
export const DEFAULT_RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const DEFAULT_RH_VAULT_ADDRESS =
  "0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058";

/** Sui Move u64 max — RH amounts above this cannot be minted as-is. */
export const U64_MAX = (1n << 64n) - 1n;
/** RH stock tokens are 18dp; Sui wrappers are 9dp. Divide RH base units by this. */
export const RH_TO_SUI_SCALE = 10n ** 9n;

export type Ticker = "NVDA" | "AMC" | "GME" | "TSLA";

export type StockConfig = {
  ticker: Ticker;
  module: string;
  coinType: string;
  vaultId: string;
  minterCapId: string;
  /** Robinhood Chain ERC-20 (empty until known). */
  rhToken: string;
  decimals: number;
};

const PKG = STOCKS_PACKAGE;

export const STOCKS: Record<Ticker, StockConfig> = {
  NVDA: {
    ticker: "NVDA",
    module: "nvda",
    coinType: `${PKG}::nvda::NVDA`,
    vaultId: "0xf6a8f80cf7d75f7e9e83712d10722b9f5302eaaf585ee6c149497379b8647bbc",
    minterCapId: "0x5fd6af65b81cd8582eb9864f5ab0378270bd621cfc92de994b1a86d9fcb3fc02",
    rhToken: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    decimals: 9,
  },
  AMC: {
    ticker: "AMC",
    module: "amc",
    coinType: `${PKG}::amc::AMC`,
    vaultId: "0x091bb1a2da97f685c19c607d71fe2bd1b9e5198768bac3d8898562802b739f61",
    minterCapId: "0x54a3b56fd06994726716e1df74834c6736e6dd907d22ef601f0e773fb3de6417",
    rhToken: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B",
    decimals: 9,
  },
  GME: {
    ticker: "GME",
    module: "gme",
    coinType: `${PKG}::gme::GME`,
    vaultId: "0x6f832d8b04c1e59863cd37a9191554f9fc3654e85e5ae06520d495f761afa680",
    minterCapId: "0x77c8cf4185f0a3cc098f1ab9bd96674d454ef822d8ba69ac739c77662d9da90d",
    rhToken: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
    decimals: 9,
  },
  TSLA: {
    ticker: "TSLA",
    module: "tsla",
    coinType: `${PKG}::tsla::TSLA`,
    vaultId: "0xc91e4691e2df8cd6cfee17356687b2387fe26fa81793d6fd8cd4c52afd489b65",
    minterCapId: "0x7f6f580c1232d1474b9c09e755bdf2f0b468b7e7b6d69ffd4d77bc4a7c0d955e",
    rhToken: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    decimals: 9,
  },
};

export function env() {
  const rpc = process.env.SUI_RPC ?? "https://mainnet.suiet.app";
  const graphql = process.env.SUI_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql";
  const dryRunDefault = process.env.STOCKS_MINT_DRY_RUN === "1";
  const dataDir = process.env.STOCKS_DATA_DIR ?? join(rootPath(), "data");
  const rhRpc = process.env.RH_RPC ?? DEFAULT_RH_RPC;
  const rhVaultAddress = (process.env.RH_VAULT_ADDRESS ?? DEFAULT_RH_VAULT_ADDRESS).trim();
  return { rpc, graphql, dryRunDefault, dataDir, packageId: STOCKS_PACKAGE, rhRpc, rhVaultAddress };
}

function rootPath() {
  return fileURLToPath(new URL("..", import.meta.url));
}


export function tickerFromRhToken(token: string): Ticker | undefined {
  const want = token.trim().toLowerCase();
  return Object.values(STOCKS).find((s) => s.rhToken && s.rhToken.toLowerCase() === want)?.ticker;
}

export function stockOf(ticker: string): StockConfig {
  const t = ticker.trim().toUpperCase() as Ticker;
  const s = STOCKS[t];
  if (!s) throw new Error(`unknown ticker ${ticker}; want NVDA|AMC|GME|TSLA`);
  return s;
}

export function mintedEventType(packageId = STOCKS_PACKAGE) {
  return `${packageId}::bridge::MintedEvent`;
}

export function redeemEventType(packageId = STOCKS_PACKAGE) {
  return `${packageId}::bridge::RedeemBurned`;
}
