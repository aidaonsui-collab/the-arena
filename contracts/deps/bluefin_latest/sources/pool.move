#[allow(unused_field, unused_variable, unused_type_parameter, unused_mut_parameter)]
module bluefin_latest::pool;

use bluefin_spot::config::GlobalConfig;
use bluefin_spot::pool::Pool;
use bluefin_spot::position::Position;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::tx_context::TxContext;

public fun create_pool_and_get_object<CoinTypeA, CoinTypeB, CoinTypeFee>(
    clock: &Clock,
    protocol_config: &mut GlobalConfig,
    pool_name: vector<u8>,
    icon_url: vector<u8>,
    coin_a_symbol: vector<u8>,
    coin_a_decimals: u8,
    coin_a_url: vector<u8>,
    coin_b_symbol: vector<u8>,
    coin_b_decimals: u8,
    coin_b_url: vector<u8>,
    tick_spacing: u32,
    fee_rate: u64,
    current_sqrt_price: u128,
    creation_fee: Balance<CoinTypeFee>,
    ctx: &mut TxContext,
): Pool<CoinTypeA, CoinTypeB> {
    abort 0
}

public fun share_pool_object<CoinTypeA, CoinTypeB>(pool: Pool<CoinTypeA, CoinTypeB>) {
    abort 0
}

public fun open_position<CoinTypeA, CoinTypeB>(
    protocol_config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    lower_tick_bits: u32,
    upper_tick_bits: u32,
    ctx: &mut TxContext,
): Position {
    abort 0
}

public fun add_liquidity_with_fixed_amount<CoinTypeA, CoinTypeB>(
    clock: &Clock,
    protocol_config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    position: &mut Position,
    balance_a: Balance<CoinTypeA>,
    balance_b: Balance<CoinTypeB>,
    amount: u64,
    is_fixed_a: bool,
): (u64, u64, Balance<CoinTypeA>, Balance<CoinTypeB>) {
    abort 0
}
