module arena::events;

use std::ascii::String as AsciiString;
use std::option::Option;
use std::string::String;
use std::type_name::TypeName;
use sui::object::ID;

public struct LaunchEvent has copy, drop {
    pool_id: ID,
    token: TypeName,
    quote: TypeName,
    creator: address,
    pit_mode: u8,
    reflection: bool,
    virtual_quote: u64,
    virtual_token: u64,
    name: String,
    symbol: AsciiString,
}

public struct TradeEvent has copy, drop {
    pool_id: ID,
    trader: address,
    is_buy: bool,
    quote_amount: u64,
    token_amount: u64,
    pit_fee: u64,
    reflection_fee: u64,
    creator_fee: u64,
    platform_fee: u64,
    raised: u64,
    token_reserve: u64,
    quote_real: u64,
}

public struct PitNudgeEvent has copy, drop {
    pool_id: ID,
    metric: u64,
    round: u64,
}

public struct BellEvent has copy, drop {
    winner_id: Option<ID>,
    round: u64,
    pot: u64,
}

public struct PitSettleEvent has copy, drop {
    winner_id: ID,
    amount: u64,
    mode: u8,
}

public struct ClaimEvent has copy, drop {
    pool_id: ID,
    who: address,
    amount: u64,
    /// 0 = reflection, 1 = pit holders payout, 2 = creator
    kind: u8,
}

public struct GraduationEvent has copy, drop {
    pool_id: ID,
    raised: u64,
    token_reserve: u64,
    quote_real: u64,
}

public struct LockEvent has copy, drop {
    lock_id: ID,
    pool_id: ID,
    beneficiary: address,
    unlock_ms: u64,
    token_amount: u64,
    quote_amount: u64,
}

/// Emitted when graduation seeds a Bluefin Spot pool and time-locks the Position NFT.
public struct BluefinLockEvent has copy, drop {
    lock_id: ID,
    pool_id: ID,
    beneficiary: address,
    unlock_ms: u64,
    token_amount: u64,
    quote_amount: u64,
    bluefin_pool_id: ID,
    position_id: ID,
}

/// Direct Bluefin seed (no Arena curve). Frontend Create + bout wires off this event.
public struct InstadexLaunchEvent has copy, drop {
    lock_id: ID,
    bluefin_pool_id: ID,
    position_id: ID,
    token: TypeName,
    quote: TypeName,
    creator: address,
    token_amount: u64,
    quote_amount: u64,
    unlock_ms: u64,
    name: String,
    symbol: AsciiString,
}

public struct LpClaimEvent has copy, drop {
    lock_id: ID,
    pool_id: ID,
    who: address,
    token_amount: u64,
    quote_amount: u64,
}

public fun emit_launch(
    pool_id: ID,
    token: TypeName,
    quote: TypeName,
    creator: address,
    pit_mode: u8,
    reflection: bool,
    virtual_quote: u64,
    virtual_token: u64,
    name: String,
    symbol: AsciiString,
) {
    sui::event::emit(LaunchEvent {
        pool_id,
        token,
        quote,
        creator,
        pit_mode,
        reflection,
        virtual_quote,
        virtual_token,
        name,
        symbol,
    })
}

public fun emit_trade(
    pool_id: ID,
    trader: address,
    is_buy: bool,
    quote_amount: u64,
    token_amount: u64,
    pit_fee: u64,
    reflection_fee: u64,
    creator_fee: u64,
    platform_fee: u64,
    raised: u64,
    token_reserve: u64,
    quote_real: u64,
) {
    sui::event::emit(TradeEvent {
        pool_id,
        trader,
        is_buy,
        quote_amount,
        token_amount,
        pit_fee,
        reflection_fee,
        creator_fee,
        platform_fee,
        raised,
        token_reserve,
        quote_real,
    })
}

public fun emit_pit_nudge(pool_id: ID, metric: u64, round: u64) {
    sui::event::emit(PitNudgeEvent { pool_id, metric, round })
}

public fun emit_bell(winner_id: Option<ID>, round: u64, pot: u64) {
    sui::event::emit(BellEvent { winner_id, round, pot })
}

public fun emit_pit_settle(winner_id: ID, amount: u64, mode: u8) {
    sui::event::emit(PitSettleEvent { winner_id, amount, mode })
}

public fun emit_claim(pool_id: ID, who: address, amount: u64, kind: u8) {
    sui::event::emit(ClaimEvent { pool_id, who, amount, kind })
}

public fun emit_graduation(pool_id: ID, raised: u64, token_reserve: u64, quote_real: u64) {
    sui::event::emit(GraduationEvent { pool_id, raised, token_reserve, quote_real })
}

public fun emit_lock(
    lock_id: ID,
    pool_id: ID,
    beneficiary: address,
    unlock_ms: u64,
    token_amount: u64,
    quote_amount: u64,
) {
    sui::event::emit(LockEvent {
        lock_id,
        pool_id,
        beneficiary,
        unlock_ms,
        token_amount,
        quote_amount,
    })
}

public fun emit_bluefin_lock(
    lock_id: ID,
    pool_id: ID,
    beneficiary: address,
    unlock_ms: u64,
    token_amount: u64,
    quote_amount: u64,
    bluefin_pool_id: ID,
    position_id: ID,
) {
    sui::event::emit(BluefinLockEvent {
        lock_id,
        pool_id,
        beneficiary,
        unlock_ms,
        token_amount,
        quote_amount,
        bluefin_pool_id,
        position_id,
    })
}

public fun emit_instadex_launch(
    lock_id: ID,
    bluefin_pool_id: ID,
    position_id: ID,
    token: TypeName,
    quote: TypeName,
    creator: address,
    token_amount: u64,
    quote_amount: u64,
    unlock_ms: u64,
    name: String,
    symbol: AsciiString,
) {
    sui::event::emit(InstadexLaunchEvent {
        lock_id,
        bluefin_pool_id,
        position_id,
        token,
        quote,
        creator,
        token_amount,
        quote_amount,
        unlock_ms,
        name,
        symbol,
    })
}

public fun emit_lp_claim(
    lock_id: ID,
    pool_id: ID,
    who: address,
    token_amount: u64,
    quote_amount: u64,
) {
    sui::event::emit(LpClaimEvent {
        lock_id,
        pool_id,
        who,
        token_amount,
        quote_amount,
    })
}
