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
  if (!(seed > 0n)) throw new Error("Seed shares must be > 0");
  if (cap < seed) throw new Error("Deposit cap is below the seed");
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
    arguments: [tx.object(opts.treasuryId), recipe, pureU64(tx, seed), pureU64(tx, cap)],
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
