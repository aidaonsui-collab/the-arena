/// Constant-product helpers and Uniswap-v3 / Bluefin sqrt-price math.
/// Intermediates are u128 or u256; u64 results must fit u64.
module arena::math;

use arena::errors;
use integer_mate::full_math_u128;
use integer_mate::i32::{Self, I32};

const U64_MAX: u128 = 18446744073709551615;
const U128_MAX: u256 = 0xffffffffffffffffffffffffffffffff;
/// 2^64, Bluefin / Cetus sqrt-price scalar (Q64).
const Q64: u256 = 18446744073709551616;
/// Cetus / Bluefin tick bound (same as GlobalConfig min/max magnitude).
const TICK_ABS_MAX: u32 = 443636;
/// `get_sqrt_price_at_tick(-443636)` on Cetus/Bluefin.
const MIN_SQRT_PRICE_X64: u128 = 4295048016;

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

public fun min_sqrt_price_x64(): u128 { MIN_SQRT_PRICE_X64 }

/// `sqrt(1.0001^tick) * 2^64` (Bluefin / Cetus Q64). `bits` is two's-complement i32.
/// Tables match Cetus `tick_math` so Instant init sqrt is the same number Bluefin
/// uses for that tick — required for 100% coin A / 0 coin B at tickLower.
public fun sqrt_price_x64_at_tick_bits(bits: u32): u128 {
    let negative = bits >> 31 == 1;
    let abs = if (negative) {
        (bits ^ 0xffffffff) + 1
    } else {
        bits
    };
    assert!(abs <= TICK_ABS_MAX, errors::overflow());
    if (negative) {
        sqrt_price_x64_at_negative_abs(abs)
    } else {
        sqrt_price_x64_at_positive_abs(abs)
    }
}

fun sqrt_price_x64_at_negative_abs(abs: u32): u128 {
    let mut ratio = if (abs & 0x1 != 0) {
        18445821805675392311u128
    } else {
        18446744073709551616u128
    };
    if (abs & 0x2 != 0) ratio = full_math_u128::mul_shr(ratio, 18444899583751176498u128, 64u8);
    if (abs & 0x4 != 0) ratio = full_math_u128::mul_shr(ratio, 18443055278223354162u128, 64u8);
    if (abs & 0x8 != 0) ratio = full_math_u128::mul_shr(ratio, 18439367220385604838u128, 64u8);
    if (abs & 0x10 != 0) ratio = full_math_u128::mul_shr(ratio, 18431993317065449817u128, 64u8);
    if (abs & 0x20 != 0) ratio = full_math_u128::mul_shr(ratio, 18417254355718160513u128, 64u8);
    if (abs & 0x40 != 0) ratio = full_math_u128::mul_shr(ratio, 18387811781193591352u128, 64u8);
    if (abs & 0x80 != 0) ratio = full_math_u128::mul_shr(ratio, 18329067761203520168u128, 64u8);
    if (abs & 0x100 != 0) ratio = full_math_u128::mul_shr(ratio, 18212142134806087854u128, 64u8);
    if (abs & 0x200 != 0) ratio = full_math_u128::mul_shr(ratio, 17980523815641551639u128, 64u8);
    if (abs & 0x400 != 0) ratio = full_math_u128::mul_shr(ratio, 17526086738831147013u128, 64u8);
    if (abs & 0x800 != 0) ratio = full_math_u128::mul_shr(ratio, 16651378430235024244u128, 64u8);
    if (abs & 0x1000 != 0) ratio = full_math_u128::mul_shr(ratio, 15030750278693429944u128, 64u8);
    if (abs & 0x2000 != 0) ratio = full_math_u128::mul_shr(ratio, 12247334978882834399u128, 64u8);
    if (abs & 0x4000 != 0) ratio = full_math_u128::mul_shr(ratio, 8131365268884726200u128, 64u8);
    if (abs & 0x8000 != 0) ratio = full_math_u128::mul_shr(ratio, 3584323654723342297u128, 64u8);
    if (abs & 0x10000 != 0) ratio = full_math_u128::mul_shr(ratio, 696457651847595233u128, 64u8);
    if (abs & 0x20000 != 0) ratio = full_math_u128::mul_shr(ratio, 26294789957452057u128, 64u8);
    if (abs & 0x40000 != 0) ratio = full_math_u128::mul_shr(ratio, 37481735321082u128, 64u8);
    ratio
}

fun sqrt_price_x64_at_positive_abs(abs: u32): u128 {
    let mut ratio = if (abs & 0x1 != 0) {
        79232123823359799118286999567u128
    } else {
        79228162514264337593543950336u128
    };
    if (abs & 0x2 != 0) ratio = full_math_u128::mul_shr(ratio, 79236085330515764027303304731u128, 96u8);
    if (abs & 0x4 != 0) ratio = full_math_u128::mul_shr(ratio, 79244008939048815603706035061u128, 96u8);
    if (abs & 0x8 != 0) ratio = full_math_u128::mul_shr(ratio, 79259858533276714757314932305u128, 96u8);
    if (abs & 0x10 != 0) ratio = full_math_u128::mul_shr(ratio, 79291567232598584799939703904u128, 96u8);
    if (abs & 0x20 != 0) ratio = full_math_u128::mul_shr(ratio, 79355022692464371645785046466u128, 96u8);
    if (abs & 0x40 != 0) ratio = full_math_u128::mul_shr(ratio, 79482085999252804386437311141u128, 96u8);
    if (abs & 0x80 != 0) ratio = full_math_u128::mul_shr(ratio, 79736823300114093921829183326u128, 96u8);
    if (abs & 0x100 != 0) ratio = full_math_u128::mul_shr(ratio, 80248749790819932309965073892u128, 96u8);
    if (abs & 0x200 != 0) ratio = full_math_u128::mul_shr(ratio, 81282483887344747381513967011u128, 96u8);
    if (abs & 0x400 != 0) ratio = full_math_u128::mul_shr(ratio, 83390072131320151908154831281u128, 96u8);
    if (abs & 0x800 != 0) ratio = full_math_u128::mul_shr(ratio, 87770609709833776024991924138u128, 96u8);
    if (abs & 0x1000 != 0) ratio = full_math_u128::mul_shr(ratio, 97234110755111693312479820773u128, 96u8);
    if (abs & 0x2000 != 0) ratio = full_math_u128::mul_shr(ratio, 119332217159966728226237229890u128, 96u8);
    if (abs & 0x4000 != 0) ratio = full_math_u128::mul_shr(ratio, 179736315981702064433883588727u128, 96u8);
    if (abs & 0x8000 != 0) ratio = full_math_u128::mul_shr(ratio, 407748233172238350107850275304u128, 96u8);
    if (abs & 0x10000 != 0) ratio = full_math_u128::mul_shr(ratio, 2098478828474011932436660412517u128, 96u8);
    if (abs & 0x20000 != 0) ratio = full_math_u128::mul_shr(ratio, 55581415166113811149459800483533u128, 96u8);
    if (abs & 0x40000 != 0) ratio = full_math_u128::mul_shr(ratio, 38992368544603139932233054999993551u128, 96u8);
    ratio >> 32
}

/// Greatest tick whose sqrt price is <= `sqrt_p`. Returns two's-complement bits.
public fun tick_bits_at_sqrt_price_x64(sqrt_p: u128): u32 {
    let mut lo = i32::neg_from(TICK_ABS_MAX);
    let mut hi = i32::from(TICK_ABS_MAX);
    let one = i32::from(1);
    while (i32::lt(lo, hi)) {
        let diff = i32::wrapping_sub(hi, lo);
        let half = i32::shr(i32::wrapping_add(diff, one), 1);
        let mid = i32::wrapping_add(lo, half);
        if (sqrt_price_x64_at_tick_bits(i32::as_u32(mid)) <= sqrt_p) {
            lo = mid;
        } else {
            hi = i32::wrapping_sub(mid, one);
        };
    };
    i32::as_u32(lo)
}

/// Floor a signed tick to a multiple of `spacing` (toward −∞).
public fun floor_tick_bits(bits: u32, spacing: u32): u32 {
    assert!(spacing > 0, errors::zero_denominator());
    let negative = bits >> 31 == 1;
    if (!negative) {
        bits / spacing * spacing
    } else {
        let mag = (bits ^ 0xffffffff) + 1;
        let rem = mag % spacing;
        let aligned_mag = if (rem == 0) { mag } else { mag + (spacing - rem) };
        (aligned_mag ^ 0xffffffff) + 1
    }
}

public fun i32_from_bits(bits: u32): I32 { i32::from_u32(bits) }
