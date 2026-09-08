/** RH → Sui stock wrap attestor config (see contracts-stocks/PUBLISHED.md). */
import { join } from "node:path";
import { fileURLToPath } from "node:url";


export const STOCKS_PACKAGE =
  process.env.ARENA_STOCKS_PACKAGE ??
  "0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db";

/** Publisher / MinterCap holder — do NOT transfer caps off this address. */
export const MINTER_HOLDER =
  "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";

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
    vaultId: "0xc221abc5c9f94ae90cb02db643ffa532db5944afac3d1d5006a74987dc52727d",
    minterCapId: "0x13e05950b45c5dff193b22e9d1da79fc1fe206faf38d46352dfbd63e2e2630f8",
    rhToken: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    decimals: 18,
  },
  AMC: {
    ticker: "AMC",
    module: "amc",
    coinType: `${PKG}::amc::AMC`,
    vaultId: "0xb2b480f907479831aedb115fa1f10e0acc81f00a5f44bab0507358e431ae22cf",
    minterCapId: "0x4b264731e6ad60edf571d4c841f8a5c8113d6508d587f4e153869d52a535410e",
    rhToken: "",
    decimals: 18,
  },
  GME: {
    ticker: "GME",
    module: "gme",
    coinType: `${PKG}::gme::GME`,
    vaultId: "0xc743951e4330499438635579a2049b28af65068fb9d5c4af3e5618229ac6cfa2",
    minterCapId: "0xbcbb7c683fe1148a6432c83152516bc86268f8e89d56caab130b663a88dbd342",
    rhToken: "",
    decimals: 18,
  },
  TSLA: {
    ticker: "TSLA",
    module: "tsla",
    coinType: `${PKG}::tsla::TSLA`,
    vaultId: "0xef39c0154e56c5c4159aa0dd12332d48f8f8c843142787a7d4dbd59b0587a4c5",
    minterCapId: "0x5661c3f1b77d8ac2facb9bbbf48b1010a6c77ab3f5b55945e9b53295a866ac13",
    rhToken: "",
    decimals: 18,
  },
};

export function env() {
  const rpc = process.env.SUI_RPC ?? "https://mainnet.suiet.app";
  const graphql = process.env.SUI_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql";
  const dryRunDefault = process.env.STOCKS_MINT_DRY_RUN === "1";
  const dataDir = process.env.STOCKS_DATA_DIR ?? join(rootPath(), "data");
  return { rpc, graphql, dryRunDefault, dataDir, packageId: STOCKS_PACKAGE };
}

function rootPath() {
  return fileURLToPath(new URL("..", import.meta.url));
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
