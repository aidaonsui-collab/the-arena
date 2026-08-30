/// Abort codes for The Arena. Callers should abort via these helpers so codes
/// stay stable across modules.
module arena::errors;

const E_PAUSED: u64 = 1;
const E_INVALID_FEE: u64 = 2;
const E_ZERO_AMOUNT: u64 = 3;
const E_SLIPPAGE: u64 = 4;
const E_GRADUATED: u64 = 5;
const E_NOT_GRADUATED: u64 = 6;
const E_TOO_EARLY: u64 = 7;
const E_ALREADY_SETTLED: u64 = 8;
const E_NOT_WINNER: u64 = 9;
const E_INVALID_PIT_MODE: u64 = 10;
const E_ZERO_DENOMINATOR: u64 = 11;
const E_ZERO_IN: u64 = 12;
const E_OVERFLOW: u64 = 13;
const E_NOTHING_TO_CLAIM: u64 = 14;
const E_ROUND_NOT_STARTED: u64 = 15;
const E_UNSETTLED_WINNER: u64 = 16;
const E_INSUFFICIENT_LIQUIDITY: u64 = 17;
const E_NOT_ADMIN: u64 = 18;
const E_NOT_CREATOR: u64 = 19;
const E_STILL_LOCKED: u64 = 20;
const E_ALREADY_LOCKED: u64 = 21;
const E_NOT_BENEFICIARY: u64 = 22;
const E_USE_SPLIT_COLLECT: u64 = 23;
const E_USE_INSTADEX_COLLECT: u64 = 24;
/// A public entrypoint that was reachable by anyone has been retired. The
/// signature stays for `Compatible` upgrade linkage; the body aborts here and
/// the real logic moved to a `public(package)` twin. See the module doc for the
/// replacement call.
const E_RETIRED: u64 = 25;
/// The `Pit<Q>` passed in is not the canonical pit registered in `Config`.
const E_WRONG_PIT: u64 = 26;
/// Seller has no registry weight for the amount being sold.
const E_UNREGISTERED_SELLER: u64 = 27;
/// Nothing to distribute to: the pool has zero registered supply.
const E_NO_HOLDERS: u64 = 28;
/// The pool's curve reserves are already vaulted, so it cannot absorb a burn.
const E_RESERVES_LOCKED: u64 = 29;
/// A config value outside the range the protocol can operate on.
const E_BAD_PARAM: u64 = 30;

public fun paused(): u64 { E_PAUSED }
public fun invalid_fee(): u64 { E_INVALID_FEE }
public fun zero_amount(): u64 { E_ZERO_AMOUNT }
public fun slippage(): u64 { E_SLIPPAGE }
public fun graduated(): u64 { E_GRADUATED }
public fun not_graduated(): u64 { E_NOT_GRADUATED }
public fun too_early(): u64 { E_TOO_EARLY }
public fun already_settled(): u64 { E_ALREADY_SETTLED }
public fun not_winner(): u64 { E_NOT_WINNER }
public fun invalid_pit_mode(): u64 { E_INVALID_PIT_MODE }
public fun zero_denominator(): u64 { E_ZERO_DENOMINATOR }
public fun zero_in(): u64 { E_ZERO_IN }
public fun overflow(): u64 { E_OVERFLOW }
public fun nothing_to_claim(): u64 { E_NOTHING_TO_CLAIM }
public fun round_not_started(): u64 { E_ROUND_NOT_STARTED }
public fun unsettled_winner(): u64 { E_UNSETTLED_WINNER }
public fun insufficient_liquidity(): u64 { E_INSUFFICIENT_LIQUIDITY }
public fun not_admin(): u64 { E_NOT_ADMIN }
public fun not_creator(): u64 { E_NOT_CREATOR }
public fun still_locked(): u64 { E_STILL_LOCKED }
public fun already_locked(): u64 { E_ALREADY_LOCKED }
public fun not_beneficiary(): u64 { E_NOT_BENEFICIARY }
public fun use_split_collect(): u64 { E_USE_SPLIT_COLLECT }
public fun use_instadex_collect(): u64 { E_USE_INSTADEX_COLLECT }
public fun retired(): u64 { E_RETIRED }
public fun wrong_pit(): u64 { E_WRONG_PIT }
public fun unregistered_seller(): u64 { E_UNREGISTERED_SELLER }
public fun no_holders(): u64 { E_NO_HOLDERS }
public fun reserves_locked(): u64 { E_RESERVES_LOCKED }
public fun bad_param(): u64 { E_BAD_PARAM }
