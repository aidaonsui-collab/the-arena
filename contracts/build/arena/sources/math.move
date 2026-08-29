/// Constant-product helpers. All intermediates are u128; results must fit u64.
module arena::math;

use arena::errors;

const U64_MAX: u128 = 18446744073709551615;

/// `a * b / c` with u128 intermediates. Aborts on zero denominator or u64 overflow.
public fun mul_div(a: u64, b: u64, c: u64): u64 {
    assert!(c > 0, errors::zero_denominator());
    let r = (a as u128) * (b as u128) / (c as u128);
    assert!(r <= U64_MAX, errors::overflow());
    r as u64
}

/// Uniswap-v2 `amount_out = amount_in * reserve_out / (reserve_in + amount_in)`.
public fun get_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64): u64 {
    assert!(amount_in > 0, errors::zero_in());
    assert!(reserve_in > 0 && reserve_out > 0, errors::zero_denominator());
    let ain = amount_in as u128;
    let rin = reserve_in as u128;
    let rout = reserve_out as u128;
    let r = (ain * rout) / (rin + ain);
    assert!(r <= U64_MAX, errors::overflow());
    r as u64
}

/// Inverse of `get_amount_out`, rounded up so the subsequent out is at least `amount_out`.
public fun get_amount_in(amount_out: u64, reserve_in: u64, reserve_out: u64): u64 {
    assert!(amount_out > 0, errors::zero_in());
    assert!(reserve_in > 0, errors::zero_denominator());
    assert!(reserve_out > amount_out, errors::insufficient_liquidity());
    let aout = amount_out as u128;
    let rin = reserve_in as u128;
    let rout = reserve_out as u128;
    let den = rout - aout;
    assert!(den > 0, errors::zero_denominator());
    let num = rin * aout;
    let r = (num + den - 1) / den;
    assert!(r <= U64_MAX, errors::overflow());
    r as u64
}
