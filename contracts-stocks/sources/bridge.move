/// Robinhood Chain → Sui 1:1 stock-token wrap bridge (Arena).
///
/// Flow (v1): off-chain keeper locks RH stock tokens in a vault, then calls
/// `mint` with a `MinterCap` to mint the matching Sui wrapper 1:1. Users burn
/// wrappers on Sui via `burn`; an off-chain process watches `RedeemBurned` and
/// releases the RH vault. Not Robinhood primary AP mint.
module stocks::bridge {
    use std::type_name::{Self, TypeName};
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;

    /// MinterCap does not authorize this vault.
    const EUnauthorized: u64 = 1;
    /// Mint amount must be > 0.
    const EZeroAmount: u64 = 2;

    /// Shared vault holding the sole `TreasuryCap<T>` for a wrapped stock coin.
    public struct BridgeVault<phantom T> has key {
        id: UID,
        treasury: TreasuryCap<T>,
        /// Human ticker for events / indexers (e.g. b"NVDA").
        ticker: vector<u8>,
    }

    /// Capability required to mint. Bound to one vault by `vault_id`.
    /// Has `store` so Arena / keepers can custody it in a hot wallet or KMS bag.
    public struct MinterCap has key, store {
        id: UID,
        vault_id: ID,
    }

    /// Emitted when wrappers are minted after an RH lock attestation.
    public struct MintedEvent has copy, drop {
        coin_type: TypeName,
        ticker: vector<u8>,
        amount: u64,
        recipient: address,
        /// Opaque RH / Arc lock reference (tx hash, attestation id, etc.).
        rh_ref: vector<u8>,
    }

    /// Emitted when wrappers are burned; off-chain releases the RH vault.
    public struct RedeemBurned has copy, drop {
        coin_type: TypeName,
        ticker: vector<u8>,
        amount: u64,
        burner: address,
    }

    /// Create a vault from a freshly created `TreasuryCap` and a ticker label.
    /// Caller (coin `init`) should `share_vault` + transfer the returned `MinterCap`.
    public fun create_vault<T>(
        treasury: TreasuryCap<T>,
        ticker: vector<u8>,
        ctx: &mut TxContext,
    ): (BridgeVault<T>, MinterCap) {
        let vault = BridgeVault {
            id: object::new(ctx),
            treasury,
            ticker,
        };
        let vault_id = object::id(&vault);
        let minter = MinterCap {
            id: object::new(ctx),
            vault_id,
        };
        (vault, minter)
    }

    /// Share the vault (only this module can share `BridgeVault`).
    public fun share_vault<T>(vault: BridgeVault<T>) {
        transfer::share_object(vault);
    }

    /// Mint `amount` of `T` to `recipient`. Requires the vault's `MinterCap`.
    /// `rh_ref` should identify the off-chain RH lock / attestation.
    public fun mint<T>(
        vault: &mut BridgeVault<T>,
        minter: &MinterCap,
        amount: u64,
        recipient: address,
        rh_ref: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(minter.vault_id == object::id(vault), EUnauthorized);
        assert!(amount > 0, EZeroAmount);
        let c = coin::mint(&mut vault.treasury, amount, ctx);
        transfer::public_transfer(c, recipient);
        event::emit(MintedEvent {
            coin_type: type_name::with_defining_ids<T>(),
            ticker: vault.ticker,
            amount,
            recipient,
            rh_ref,
        });
    }

    /// Burn a wrapper coin. Anyone holding `Coin<T>` may redeem; emits `RedeemBurned`
    /// for the off-chain RH release watcher.
    public fun burn<T>(
        vault: &mut BridgeVault<T>,
        c: Coin<T>,
        ctx: &TxContext,
    ) {
        let amount = coin::value(&c);
        assert!(amount > 0, EZeroAmount);
        coin::burn(&mut vault.treasury, c);
        event::emit(RedeemBurned {
            coin_type: type_name::with_defining_ids<T>(),
            ticker: vault.ticker,
            amount,
            burner: ctx.sender(),
        });
    }

    // --- views ---

    public fun total_supply<T>(vault: &BridgeVault<T>): u64 {
        coin::total_supply(&vault.treasury)
    }

    public fun ticker<T>(vault: &BridgeVault<T>): vector<u8> {
        vault.ticker
    }

    public fun vault_id_of_minter(minter: &MinterCap): ID {
        minter.vault_id
    }

    public fun vault_id<T>(vault: &BridgeVault<T>): ID {
        object::id(vault)
    }

    // --- test helpers ---

    #[test_only]
    public fun create_vault_for_testing<T>(
        treasury: TreasuryCap<T>,
        ticker: vector<u8>,
        ctx: &mut TxContext,
    ): (BridgeVault<T>, MinterCap) {
        create_vault(treasury, ticker, ctx)
    }

    #[test_only]
    public fun destroy_minter_for_testing(minter: MinterCap) {
        let MinterCap { id, vault_id: _ } = minter;
        object::delete(id);
    }

    #[test_only]
    public fun destroy_vault_for_testing<T>(vault: BridgeVault<T>, ctx: &TxContext) {
        let BridgeVault { id, treasury, ticker: _ } = vault;
        assert!(coin::total_supply(&treasury) == 0, 0);
        transfer::public_transfer(treasury, ctx.sender());
        object::delete(id);
    }
}
