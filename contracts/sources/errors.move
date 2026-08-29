/// Abort codes for The Arena. Callers should abort via these helpers so codes
/// stay stable across modules.
module arena::errors;

public const E_PAUSED: u64 = 1;
public const E_INVALID_FEE: u64 = 2;
public const E_ZERO_AMOUNT: u64 = 3;
public const E_SLIPPAGE: u64 = 4;
public const E_GRADUATED: u64 = 5;
public const E_NOT_GRADUATED: u64 = 6;
public const E_TOO_EARLY: u64 = 7;
public const E_ALREADY_SETTLED: u64 = 8;
public const E_NOT_WINNER: u64 = 9;
public const E_INVALID_PIT_MODE: u64 = 10;
public const E_ZERO_DENOMINATOR: u64 = 11;
public const E_ZERO_IN: u64 = 12;
public const E_OVERFLOW: u64 = 13;
public const E_NOTHING_TO_CLAIM: u64 = 14;
public const E_ROUND_NOT_STARTED: u64 = 15;
public const E_UNSETTLED_WINNER: u64 = 16;
public const E_INSUFFICIENT_LIQUIDITY: u64 = 17;
public const E_NOT_ADMIN: u64 = 18;

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
