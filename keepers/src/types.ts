export type TradeEvent = {
  pool_id: string;
  trader: string;
  is_buy: boolean;
  quote_amount: string;
  token_amount: string;
  pit_fee: string;
  reflection_fee: string;
  raised: string;
  token_reserve: string;
  quote_real: string;
};

export type ClaimEvent = {
  pool_id: string;
  who: string;
  amount: string;
  kind: number; // 0 reflection, 1 pit
};

export type HolderSnapshot = {
  poolId: string;
  address: string;
  /** Net tokens bought through the curve (on-chain registry). */
  registered: string;
  /** Quote accrued from reflection_fee, not yet claimed. */
  unpaidReflection: string;
  claimedReflection: string;
  updatedMs: number;
};

export type ReflectionIndex = {
  pools: Record<
    string,
    {
      quote: "SUI" | "XAUM";
      reflection: boolean;
      holders: Record<string, HolderSnapshot>;
      totalReflectionFees: string;
      totalClaimed: string;
    }
  >;
  cursor: string | null;
};
