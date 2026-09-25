/// PTB for arena::basket::create + deposit + finish_seed.
/// The share coin must come from the zero-supply basket template. Deposit
/// returns any surplus. With no sender, that surplus must be a zero coin.
/// With a sender, the surplus goes back to that address so a swap can
/// overshoot the exact seed amount.

function pureU64(tx, v) {
  const n = typeof v === "bigint" ? v : BigInt(String(v));
  if (n < 0n) throw new Error("Amount must be >= 0");
  const arg = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
  if (tx.pure && typeof tx.pure.u64 === "function") return tx.pure.u64(arg);
  if (typeof tx.pure === "function") return tx.pure("u64", arg);
  throw new Error("Transaction.pure.u64 missing");
}

function one(result) {
  return Array.isArray(result) ? result[0] : result;
}

function pureAddress(tx, addr) {
  if (tx.pure && typeof tx.pure.address === "function") return tx.pure.address(addr);
  if (typeof tx.pure === "function") return tx.pure("address", addr);
  throw new Error("Transaction.pure.address missing");
}

export function ceilBps(base, bps) {
  const amount = BigInt(base);
  const fee = BigInt(bps || 0);
  if (amount <= 0n || fee <= 0n) return 0n;
  return (amount * fee + 9999n) / 10000n;
}

/// Backing plus the creator fee and the 0.35% protocol mint fee.
export function mintDeposit(base, ownerBps) {
  const amount = BigInt(base);
  return amount + ceilBps(amount, ownerBps) + ceilBps(amount, 35);
}

/// Redeem payout after the creator fee and the 0.20% protocol fee.
export function redeemNet(gross, ownerBps) {
  const amount = BigInt(gross);
  const fee = (amount * BigInt(ownerBps || 0)) / 10000n + (amount * 20n) / 10000n;
  return fee >= amount ? 0n : amount - fee;
}

export function appendBasketSeed(tx, opts) {
  const pkg = String(opts.packageId || "");
  const basketType = String(opts.basketType || "");
  const legs = opts.legs || [];
  if (!pkg) throw new Error("Basket package is not set");
  if (!basketType) throw new Error("Basket coin type is not set");
  if (!opts.treasuryId) throw new Error("TreasuryCap is not set");
  if (legs.length < 2 || legs.length > 8) throw new Error("Basket needs 2 to 8 assets");
  const seed = BigInt(opts.seedShares);
  const cap = BigInt(opts.depositCap);
  const mintFee = BigInt(opts.mintFeeBps || 0);
  const redeemFee = BigInt(opts.redeemFeeBps || 0);
  const recipient = String(opts.protocolRecipient || "");
  if (!(seed > 0n)) throw new Error("Seed shares must be > 0");
  if (cap < seed) throw new Error("Deposit cap is below the seed");
  if (mintFee > 100n || redeemFee > 100n) throw new Error("Basket fee is above 1%");
  if (!recipient) throw new Error("Protocol fee recipient is not set");
  const seen = new Set();
  for (const leg of legs) {
    const t = String(leg.type || "");
    if (!t || seen.has(t)) throw new Error("Basket assets must be distinct coin types");
    seen.add(t);
    if (!(BigInt(leg.units) > 0n)) throw new Error("Each asset needs units per share");
    if (!leg.coin) throw new Error("Each asset needs a seed coin");
  }

  const built = legs.map((leg) => {
    const tn = tx.moveCall({
      target: "0x1::type_name::with_defining_ids",
      typeArguments: [leg.type],
    });
    return tx.moveCall({
      target: pkg + "::basket::new_leg",
      arguments: [tn, pureU64(tx, leg.units)],
    });
  });
  const recipe = tx.makeMoveVec({
    type: pkg + "::basket::BasketLeg",
    elements: built,
  });
  const created = tx.moveCall({
    target: pkg + "::basket::create",
    typeArguments: [basketType],
    arguments: [
      tx.object(opts.treasuryId),
      recipe,
      pureU64(tx, seed),
      pureU64(tx, cap),
      pureU64(tx, mintFee),
      pureU64(tx, redeemFee),
      pureAddress(tx, recipient),
    ],
  });
  const vault = created[0];
  const receipt = created[1];
  for (const leg of legs) {
    const leftover = tx.moveCall({
      target: pkg + "::basket::deposit",
      typeArguments: [basketType, leg.type],
      arguments: [vault, receipt, leg.coin],
    });
    if (opts.sender) {
      tx.transferObjects([one(leftover)], opts.sender);
    } else {
      tx.moveCall({
        target: "0x2::coin::destroy_zero",
        typeArguments: [leg.type],
        arguments: [one(leftover)],
      });
    }
  }
  if (opts.virtualQuote && opts.configId) {
    tx.moveCall({
      target: pkg + "::basket::finish_seed_with_quote",
      typeArguments: [basketType],
      arguments: [tx.object(opts.configId), vault, receipt, pureU64(tx, opts.virtualQuote)],
    });
  } else {
    tx.moveCall({
      target: pkg + "::basket::finish_seed",
      typeArguments: [basketType],
      arguments: [vault, receipt],
    });
  }
}

export function appendBasketMint(tx, opts) {
  const pkg = String(opts.packageId || "");
  const basketType = String(opts.basketType || "");
  const legs = opts.legs || [];
  const shares = BigInt(opts.shares);
  if (!pkg) throw new Error("Basket package is not set");
  if (!basketType) throw new Error("Basket coin type is not set");
  if (!opts.vaultId) throw new Error("Basket vault is not set");
  if (!(shares > 0n)) throw new Error("Share amount must be > 0");
  if (legs.length < 2 || legs.length > 8) throw new Error("Basket needs 2 to 8 assets");
  const receipt = tx.moveCall({
    target: pkg + "::basket::start_mint",
    typeArguments: [basketType],
    arguments: [tx.object(opts.vaultId), pureU64(tx, shares)],
  });
  for (const leg of legs) {
    if (!leg.coin) throw new Error("Each asset needs a payment coin");
    const leftover = tx.moveCall({
      target: pkg + "::basket::deposit",
      typeArguments: [basketType, leg.type],
      arguments: [tx.object(opts.vaultId), one(receipt), leg.coin],
    });
    if (opts.sender) tx.transferObjects([one(leftover)], opts.sender);
    else {
      tx.moveCall({
        target: "0x2::coin::destroy_zero",
        typeArguments: [leg.type],
        arguments: [one(leftover)],
      });
    }
  }
  return tx.moveCall({
    target: pkg + "::basket::finish_mint",
    typeArguments: [basketType],
    arguments: [tx.object(opts.vaultId), one(receipt)],
  });
}

/// Burn `sharesCoin` and send one coin per recipe leg back to `sender`.
/// The vault keeps the creator and protocol fees from each asset.
export function appendBasketRedeem(tx, opts) {
  const pkg = String(opts.packageId || "");
  const basketType = String(opts.basketType || "");
  const legs = opts.legs || [];
  if (!pkg) throw new Error("Basket package is not set");
  if (!basketType) throw new Error("Basket coin type is not set");
  if (!opts.vaultId) throw new Error("Basket vault is not set");
  if (!opts.sharesCoin) throw new Error("Share coin is not set");
  if (!opts.sender) throw new Error("Redeem needs a wallet address");
  if (legs.length < 2 || legs.length > 8) throw new Error("Basket needs 2 to 8 assets");
  const receipt = tx.moveCall({
    target: pkg + "::basket::start_redeem",
    typeArguments: [basketType],
    arguments: [tx.object(opts.vaultId), opts.sharesCoin],
  });
  for (const leg of legs) {
    if (!leg.type) throw new Error("Each asset needs a coin type");
    const out = tx.moveCall({
      target: pkg + "::basket::withdraw",
      typeArguments: [basketType, leg.type],
      arguments: [tx.object(opts.vaultId), one(receipt)],
    });
    tx.transferObjects([one(out)], opts.sender);
  }
  tx.moveCall({
    target: pkg + "::basket::finish_redeem",
    typeArguments: [basketType],
    arguments: [tx.object(opts.vaultId), one(receipt)],
  });
}

/// Candle prices are raw quote/token. A 9-decimal quote cancels.
/// A 0-decimal share needs 10^(9-decimals) on price and 10^decimals on volume.
export function chartUnitsForQuoteDecimals(decimals) {
  const d = Number(decimals);
  const dec = Number.isFinite(d) && d >= 0 ? d : 9;
  return { price: 10 ** (9 - dec), volume: 10 ** dec };
}

/// Whole shares affordable when each share costs `suiPerShare` base units.
export function sharesFromSuiBudget(suiBudget, suiPerShare) {
  const budget = BigInt(suiBudget);
  const one = BigInt(suiPerShare);
  if (budget <= 0n || one <= 0n) return 0n;
  return budget / one;
}

/// Floor of balance * shares / supply. Dust stays in the vault.
export function redeemPayout(balance, shares, supply) {
  const b = BigInt(balance);
  const s = BigInt(shares);
  const t = BigInt(supply);
  if (t <= 0n || s <= 0n || b <= 0n) return 0n;
  return (b * s) / t;
}

export function vaultShareFields(content) {
  const fields = content && (content.fields || content.json || content);
  const total = fields && fields.total_shares != null ? fields.total_shares : "0";
  const seed = fields && fields.seed_shares != null ? fields.seed_shares : "0";
  const redeemFee = fields && fields.redeem_fee_bps != null ? fields.redeem_fee_bps : "0";
  const mintFee = fields && fields.mint_fee_bps != null ? fields.mint_fee_bps : "0";
  return { total: String(total), seed: String(seed), redeemFeeBps: String(redeemFee), mintFeeBps: String(mintFee) };
}

/// Coin type inside `Field<TypeName, Balance<T>>`.
export function balanceTypeFromFieldType(objectType) {
  const s = String(objectType || "");
  const key = "::balance::Balance<";
  const i = s.lastIndexOf(key);
  if (i < 0) return "";
  const rest = s.slice(i + key.length);
  let depth = 0;
  for (let k = 0; k < rest.length; k++) {
    const ch = rest[k];
    if (ch === "<") depth += 1;
    else if (ch === ">") {
      if (depth === 0) return rest.slice(0, k);
      depth -= 1;
    }
  }
  return "";
}

export function balanceAmountFromField(content) {
  const fields = content && (content.fields || content.json || content);
  if (!fields) return "0";
  const value = fields.value != null ? fields.value : fields;
  if (value == null) return "0";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  if (value.fields && value.fields.value != null) return String(value.fields.value);
  if (value.value != null && typeof value.value !== "object") return String(value.value);
  return "0";
}

function assetTypeName(asset) {
  if (!asset) return "";
  if (typeof asset === "string") return asset;
  if (asset.fields) return assetTypeName(asset.fields);
  if (asset.address && asset.module) return String(asset.address) + "::" + asset.module + "::" + (asset.name || "");
  if (typeof asset.name === "string") return asset.name;
  return "";
}

/// Recipe stored on a shared BasketVault. Accepts the object content, its
/// fields, or the recipe vector itself.
export function legsFromVaultContent(content) {
  if (!content) return [];
  if (Array.isArray(content)) return legsFromVaultContent({ recipe: content });
  const fields = content.fields || content.json || content;
  const recipe = fields && (fields.recipe || (fields.fields && fields.fields.recipe));
  if (!Array.isArray(recipe)) return [];
  const out = [];
  for (const leg of recipe) {
    const row = leg && (leg.fields || leg);
    if (!row) continue;
    const type = assetTypeName(row.asset);
    const units = row.units_per_share != null ? row.units_per_share : row.units;
    if (!type || units == null || String(units) === "0") continue;
    out.push({ type: String(type), units: String(units) });
  }
  return out;
}
