/// Shared pot per quote type. Pit<SUI> is created at publish; call create_pit<XAUM> after.
/// Ranking metric is supplied by the pool (market-cap estimate); this module only
/// compares, snapshots, and releases the pot.
module arena::pit;

use arena::errors;
use std::option::{Self, Option};
use arena::events;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::object::ID;
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::TxContext;

public struct Pit<phantom Q> has key {
    id: UID,
    pot: Balance<Q>,
    round: u64,
    /// 0 until the first nudge starts the clock.
    round_end_ms: u64,
    leader_id: Option<ID>,
    leader_metric: u64,
    winner_id: Option<ID>,
    /// True when there is no pending winner payout (including genesis).
    settled: bool,
}

/// Anyone can open a pit for a quote type (used for XAUM after publish).
public fun create_pit<Q>(ctx: &mut TxContext) {
    create_and_share<Q>(ctx)
}

public(package) fun create_and_share<Q>(ctx: &mut TxContext) {
    transfer::share_object(Pit<Q> {
        id: object::new(ctx),
        pot: balance::zero<Q>(),
        round: 1,
        round_end_ms: 0,
        leader_id: option::none(),
        leader_metric: 0,
        winner_id: option::none(),
        settled: true,
    })
}

public fun take_fee<Q>(pit: &mut Pit<Q>, fee: Balance<Q>) {
    pit.pot.join(fee);
}

/// Update the leader if `metric` is strictly higher and the pool is still live.
/// First nudge of a round sets `round_end_ms = now + round_ms`.
public fun nudge<Q>(
    pit: &mut Pit<Q>,
    pool_id: ID,
    metric: u64,
    graduated: bool,
    round_ms: u64,
    clock: &Clock,
) {
    if (graduated) {
        return
    };
    let now = clock.timestamp_ms();
    if (pit.round_end_ms == 0) {
        pit.round_end_ms = now + round_ms;
    };
    if (now >= pit.round_end_ms) {
        return
    };
    if (metric > pit.leader_metric) {
        pit.leader_id = option::some(pool_id);
        pit.leader_metric = metric;
        events::emit_pit_nudge(pool_id, metric, pit.round);
    }
}

/// Permissionless snapshot of the current leader after `round_end_ms`.
/// Starts the next round immediately; pot stays until `settle_*`.
public fun ring<Q>(pit: &mut Pit<Q>, round_ms: u64, clock: &Clock) {
    let now = clock.timestamp_ms();
    assert!(pit.round_end_ms > 0, errors::round_not_started());
    assert!(now >= pit.round_end_ms, errors::too_early());
    assert!(pit.settled, errors::unsettled_winner());

    let winner = pit.leader_id;
    pit.winner_id = winner;
    pit.settled = winner.is_none();
    events::emit_bell(winner, pit.round, pit.pot.value());

    pit.round = pit.round + 1;
    pit.round_end_ms = now + round_ms;
    pit.leader_id = option::none();
    pit.leader_metric = 0;
}

public fun settle_to_holders<Q>(pit: &mut Pit<Q>, pool_id: ID): Balance<Q> {
    take_pot(pit, pool_id, 0)
}

public fun settle_burn_quote<Q>(pit: &mut Pit<Q>, pool_id: ID): Balance<Q> {
    take_pot(pit, pool_id, 1)
}

fun take_pot<Q>(pit: &mut Pit<Q>, pool_id: ID, mode: u8): Balance<Q> {
    assert!(pit.winner_id.is_some(), errors::not_winner());
    assert!(*pit.winner_id.borrow() == pool_id, errors::not_winner());
    assert!(!pit.settled, errors::already_settled());
    pit.settled = true;
    let amount = pit.pot.value();
    events::emit_pit_settle(pool_id, amount, mode);
    pit.pot.split(amount)
}

public fun pot_value<Q>(pit: &Pit<Q>): u64 { pit.pot.value() }
public fun round<Q>(pit: &Pit<Q>): u64 { pit.round }
public fun round_end_ms<Q>(pit: &Pit<Q>): u64 { pit.round_end_ms }
public fun leader_metric<Q>(pit: &Pit<Q>): u64 { pit.leader_metric }
public fun settled<Q>(pit: &Pit<Q>): bool { pit.settled }

public fun leader_id<Q>(pit: &Pit<Q>): Option<ID> { pit.leader_id }
public fun winner_id<Q>(pit: &Pit<Q>): Option<ID> { pit.winner_id }

public fun id<Q>(pit: &Pit<Q>): ID { object::id(pit) }
