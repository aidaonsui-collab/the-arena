/// Shared pot per quote type. Pit<SUI> is created at publish; call
/// `config::create_pit<XAUM>` (AdminCap) after.
/// Ranking metric is supplied by the pool (market-cap estimate); this module only
/// compares, snapshots, and releases the pot.
///
/// # Authorization
///
/// Everything that moves the pot or decides who wins it is `public(package)`.
/// Nothing here may take a pool id, a metric, or a round length from an
/// untrusted caller: an `ID` proves nothing about who is calling, and a metric
/// supplied as an argument is not a measurement.
///
/// The former public entrypoints (`create_pit`, `nudge`, `ring`, `take_fee`,
/// `settle_to_holders`, `settle_burn_quote`) let anyone name themselves the
/// winner and collect the pot. They now abort with `errors::retired()`. Their
/// signatures stay so the package keeps linking under the `Compatible` upgrade
/// policy, which forbids removing a public function or narrowing its
/// visibility — the same pattern `lock::collect_lp_fees` already uses.
///
/// Replacements: `config::create_pit`, `config::ring_pit`, and the
/// `*_internal` twins below, reached through `pool::buy` / `sell` / `settle_pit`.
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

/// Retired. A second `Pit<SUI>` shared by anyone is a pot whose bell that
/// person controls, and nothing bound a pool to a canonical pit.
/// Use `config::create_pit<Q>` (AdminCap).
#[allow(unused_type_parameter)]
public fun create_pit<Q>(_ctx: &mut TxContext) {
    abort errors::retired()
}

/// Shares a new pit and returns its id so the caller can register it as
/// canonical in the same transaction.
public(package) fun create_and_share<Q>(ctx: &mut TxContext): ID {
    let pit = Pit<Q> {
        id: object::new(ctx),
        pot: balance::zero<Q>(),
        round: 1,
        round_end_ms: 0,
        leader_id: option::none(),
        leader_metric: 0,
        winner_id: option::none(),
        settled: true,
    };
    let id = object::id(&pit);
    transfer::share_object(pit);
    id
}

/// Retired: an open fee sink widens the surface for no gain.
/// In-package callers use `take_fee_internal`.
public fun take_fee<Q>(_pit: &mut Pit<Q>, _fee: Balance<Q>) {
    abort errors::retired()
}

public(package) fun take_fee_internal<Q>(pit: &mut Pit<Q>, fee: Balance<Q>) {
    pit.pot.join(fee);
}

/// Retired. `pool_id`, `metric` and `graduated` were all caller-supplied, so
/// anyone could claim the lead with `u64::MAX` for the price of one call.
/// The real path is `pool::buy` / `pool::sell`, which measure the curve.
public fun nudge<Q>(
    _pit: &mut Pit<Q>,
    _pool_id: ID,
    _metric: u64,
    _graduated: bool,
    _round_ms: u64,
    _clock: &Clock,
) {
    abort errors::retired()
}

/// Update the leader if `metric` is strictly higher and the pool is still live.
/// First nudge of a round sets `round_end_ms = now + round_ms`.
///
/// `metric` must come from `pool::market_cap_metric` on a real pool and
/// `round_ms` from `Config`; both are trusted because only this package calls in.
public(package) fun nudge_internal<Q>(
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
        pit.round_end_ms = deadline(now, round_ms);
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

/// Retired. `round_ms` was a caller argument, so one call could push
/// `round_end_ms` years out and freeze the bell forever while fees kept
/// accruing into a pot that could never be settled.
/// Use `config::ring_pit<Q>`, which reads the round length from `Config`.
public fun ring<Q>(_pit: &mut Pit<Q>, _round_ms: u64, _clock: &Clock) {
    abort errors::retired()
}

/// Permissionless snapshot of the current leader after `round_end_ms`.
/// Starts the next round immediately; pot stays until `settle_*`.
/// `round_ms` is `Config.round_ms`, bounded at the setter.
public(package) fun ring_internal<Q>(pit: &mut Pit<Q>, round_ms: u64, clock: &Clock) {
    let now = clock.timestamp_ms();
    assert!(pit.round_end_ms > 0, errors::round_not_started());
    assert!(now >= pit.round_end_ms, errors::too_early());
    assert!(pit.settled, errors::unsettled_winner());

    let winner = pit.leader_id;
    pit.winner_id = winner;
    pit.settled = winner.is_none();
    events::emit_bell(winner, pit.round, pit.pot.value());

    pit.round = pit.round + 1;
    pit.round_end_ms = deadline(now, round_ms);
    pit.leader_id = option::none();
    pit.leader_metric = 0;
}

/// Saturating `now + round_ms`. A deadline that overflows u64 would abort the
/// trade that happened to open the round; clamping keeps the bell reachable.
fun deadline(now: u64, round_ms: u64): u64 {
    let max = 18446744073709551615u64;
    if (round_ms > max - now) { max } else { now + round_ms }
}

/// Retired. These returned the pot to *the caller* and checked only that a
/// `pool_id` passed as an argument equalled the winner — which proves nothing
/// about who is calling. Anyone could read the winner off `BellEvent`, call
/// this, and pipe the balance through `0x2::coin::from_balance` to themselves.
/// Use `pool::settle_pit`, which passes `object::id(pool)`.
public fun settle_to_holders<Q>(_pit: &mut Pit<Q>, _pool_id: ID): Balance<Q> {
    abort errors::retired()
}

public fun settle_burn_quote<Q>(_pit: &mut Pit<Q>, _pool_id: ID): Balance<Q> {
    abort errors::retired()
}

public(package) fun settle_to_holders_internal<Q>(pit: &mut Pit<Q>, pool_id: ID): Balance<Q> {
    take_pot(pit, pool_id, 0)
}

public(package) fun settle_burn_quote_internal<Q>(pit: &mut Pit<Q>, pool_id: ID): Balance<Q> {
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
