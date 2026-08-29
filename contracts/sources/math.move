/// Constant-product helpers and Uniswap-v3 / Bluefin sqrt-price math.
/// Intermediates are u128 or u256; u64 results must fit u64.
module arena::math;

use arena::errors;

const U64_MAX: u128 = 18446744073709551615;
const U128_MAX: u256 = 0xffffffffffffffffffffffffffffffff;
/// 2^64, Bluefin / Cetus sqrt-price scalar (Q64).
const Q64: u256 = 18446744073709551616;

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

/// Integer square root of `x`, flooring. Babylonian method.
public fun sqrt_u256(x: u256): u256 {
    if (x == 0 || x == 1) {
        return x
    };
    let mut z = x;
    let mut y = (x + 1) / 2;
    while (y < z) {
        z = y;
        y = (x / y + y) / 2;
    };
    z
}

/// Uniswap-v3 / Bluefin `sqrtPriceX64 = sqrt(price_b_per_a) * 2^64`.
/// `amount_a` is Coin A reserves, `amount_b` is Coin B. Both must be > 0.
public fun sqrt_price_x64(amount_a: u64, amount_b: u64): u128 {
    assert!(amount_a > 0 && amount_b > 0, errors::zero_denominator());
    let ratio = ((amount_b as u256) << 128) / (amount_a as u256);
    let s = sqrt_u256(ratio);
    assert!(s <= U128_MAX, errors::overflow());
    s as u128
}

/// Snap I32 tick bits (two's-complement, MSB sign) inward to a multiple of `spacing`.
/// Used to turn GlobalConfig min/max ticks into a legal full-range for the pool's tick_spacing.
public fun align_tick_bits(bits: u32, spacing: u32): u32 {
    assert!(spacing > 0, errors::zero_denominator());
    let negative = bits >> 31 == 1;
    let mag = if (negative) {
        (bits ^ 0xffffffff) + 1
    } else {
        bits
    };
    let aligned = mag / spacing * spacing;
    if (negative) {
        (aligned ^ 0xffffffff) + 1
    } else {
        aligned
    }
}

public fun q64(): u128 { Q64 as u128 }
