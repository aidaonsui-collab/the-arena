#[allow(unused_field, unused_variable, unused_type_parameter, unused_mut_parameter)]
module bluefin_latest::config;

use bluefin_spot::config::GlobalConfig;

public fun get_pool_creation_fee_amount<CoinTypeFee>(protocol_config: &GlobalConfig): (bool, u64) {
    abort 0
}
