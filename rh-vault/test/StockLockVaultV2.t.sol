// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {StockLockVaultV2} from "../src/StockLockVaultV2.sol";
import {StockLockVault} from "../src/StockLockVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// ERC-20 that skims a 1% fee on every transfer, to prove the vault records
/// what it actually received rather than what was requested.
contract FeeERC20 is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            super._update(from, to, value - fee);
            return;
        }
        super._update(from, to, value);
    }
}

contract StockLockVaultV2Test is Test {
    StockLockVaultV2 internal vault;
    MockERC20 internal nvda;
    MockERC20 internal amc;

    address internal admin = address(0xA11CE);
    address internal releaser = address(0xB0B);
    address internal guardian = address(0x6A12);
    address internal alice = address(0xA11);
    address internal bob = address(0xB0B2);
    address internal aliceRh = address(0xA11C0);

    bytes32 internal suiAlice =
        bytes32(uint256(0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b));
    bytes32 internal burnRef1 = keccak256("sui-burn-1");
    bytes32 internal burnRef2 = keccak256("sui-burn-2");

    event Released(
        address indexed token, address indexed to, uint256 amount, bytes32 indexed suiBurnRef
    );
    event BackingSynced(address indexed token, uint256 from, uint256 to);

    function setUp() public {
        vault = new StockLockVaultV2(admin, releaser, guardian);
        nvda = new MockERC20("NVIDIA RH", "NVDA", 18);
        amc = new MockERC20("AMC RH", "AMC", 18);

        vm.startPrank(admin);
        vault.setTokenAllowed(address(nvda), true);
        vault.setTokenAllowed(address(amc), true);
        vm.stopPrank();

        nvda.mint(alice, 1_000e18);
        nvda.mint(bob, 1_000e18);
        amc.mint(alice, 1_000e18);
    }

    function _deposit(address who, MockERC20 token, uint256 amount) internal returns (uint256) {
        vm.startPrank(who);
        token.approve(address(vault), amount);
        uint256 id = vault.deposit(address(token), amount, suiAlice);
        vm.stopPrank();
        return id;
    }

    // --- C-1 regression ----------------------------------------------------

    /// The bug this contract exists to fix.
    ///
    /// v1 paid redemptions with `release(depositId, to)` — whole deposits only.
    /// With a 0.467630231 NVDA lock sitting at the head of the FIFO queue (the
    /// real mainnet state at audit time), a user who deposited 10 NVDA and burned
    /// all 10 wrappers got matched against the 0.4676 lock, then stopped: her own
    /// 10 NVDA lock was larger than the 9.532… remainder, so taking it would have
    /// over-released. She was paid 0.4676 and the remaining 9.532 was never
    /// retried — her wrappers were already burned.
    ///
    /// v2 pays the burn amount directly out of the pool.
    function test_c1_regression_arbitraryBurnIsPaidInFull() public {
        // Head-of-queue dust lock, exactly as on mainnet.
        uint256 stuck = 467630231347460427;
        nvda.mint(bob, stuck);
        _deposit(bob, nvda, stuck);

        // Alice deposits a round 10 and redeems all of it.
        _deposit(alice, nvda, 10e18);

        assertEq(vault.backingOf(address(nvda)), stuck + 10e18, "pooled backing");

        uint256 before = nvda.balanceOf(aliceRh);
        vm.prank(releaser);
        vault.release(address(nvda), 10e18, aliceRh, burnRef1);

        // The whole redemption lands — no quantisation, no shortfall.
        assertEq(nvda.balanceOf(aliceRh) - before, 10e18, "alice paid in full");
        assertEq(vault.backingOf(address(nvda)), stuck, "only the dust lock remains");
    }

    /// Same scenario against v1, pinning the old failure mode: v1 cannot pay
    /// 10e18 at all — every exit is a whole deposit, so the caller is forced to
    /// choose between underpaying (the dust lock) or over-releasing.
    function test_c1_v1_cannotPayArbitraryAmount() public {
        StockLockVault v1 = new StockLockVault(admin, releaser);
        vm.prank(admin);
        v1.setTokenAllowed(address(nvda), true);

        uint256 stuck = 467630231347460427;
        nvda.mint(bob, stuck);
        vm.startPrank(bob);
        nvda.approve(address(v1), stuck);
        uint256 dustId = v1.deposit(address(nvda), stuck, suiAlice);
        vm.stopPrank();

        vm.startPrank(alice);
        nvda.approve(address(v1), 10e18);
        uint256 aliceId = v1.deposit(address(nvda), 10e18, suiAlice);
        vm.stopPrank();

        // The only way to pay Alice anything is to release a whole deposit.
        vm.prank(releaser);
        v1.release(dustId, aliceRh);
        assertEq(nvda.balanceOf(aliceRh), stuck, "v1 underpays by design");
        assertLt(nvda.balanceOf(aliceRh), 10e18, "v1 cannot cover the burn");

        // Releasing her own lock too would pay 10.4676 for a 10 burn.
        vm.prank(releaser);
        v1.release(aliceId, aliceRh);
        assertGt(nvda.balanceOf(aliceRh), 10e18, "v1's only alternative over-releases");
    }

    // --- replay protection -------------------------------------------------

    function test_release_rejectsReplayedBurnRef() public {
        _deposit(alice, nvda, 10e18);

        vm.prank(releaser);
        vault.release(address(nvda), 4e18, aliceRh, burnRef1);

        vm.prank(releaser);
        vm.expectRevert(
            abi.encodeWithSelector(StockLockVaultV2.BurnAlreadySettled.selector, burnRef1)
        );
        vault.release(address(nvda), 4e18, aliceRh, burnRef1);

        // A different burn still settles.
        vm.prank(releaser);
        vault.release(address(nvda), 4e18, aliceRh, burnRef2);
        assertEq(nvda.balanceOf(aliceRh), 8e18);
        assertTrue(vault.isSettled(burnRef1));
    }

    function test_release_rejectsZeroBurnRef() public {
        _deposit(alice, nvda, 10e18);
        vm.prank(releaser);
        vm.expectRevert(StockLockVaultV2.ZeroBurnRef.selector);
        vault.release(address(nvda), 1e18, aliceRh, bytes32(0));
    }

    // --- backing bound -----------------------------------------------------

    function test_release_cannotExceedBacking() public {
        _deposit(alice, nvda, 10e18);
        vm.prank(releaser);
        vm.expectRevert(
            abi.encodeWithSelector(
                StockLockVaultV2.InsufficientBacking.selector, address(nvda), 11e18, 10e18
            )
        );
        vault.release(address(nvda), 11e18, aliceRh, burnRef1);
    }

    /// Backing is per-token: an NVDA redemption cannot draw on AMC collateral.
    function test_release_backingIsPerToken() public {
        _deposit(alice, amc, 50e18);
        vm.prank(releaser);
        vm.expectRevert(
            abi.encodeWithSelector(
                StockLockVaultV2.InsufficientBacking.selector, address(nvda), 1e18, 0
            )
        );
        vault.release(address(nvda), 1e18, aliceRh, burnRef1);
    }

    function test_release_onlyReleaser() public {
        _deposit(alice, nvda, 10e18);
        // Read the role before pranking — an external call inside the
        // expectRevert argument would consume the prank.
        bytes32 role = vault.RELEASER_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role
            )
        );
        vault.release(address(nvda), 1e18, aliceRh, burnRef1);
    }

    // --- pause -------------------------------------------------------------

    function test_pause_blocksDepositAndRelease() public {
        _deposit(alice, nvda, 10e18);

        vm.prank(guardian);
        vault.pause();

        vm.startPrank(alice);
        nvda.approve(address(vault), 1e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(address(nvda), 1e18, suiAlice);
        vm.stopPrank();

        vm.prank(releaser);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.release(address(nvda), 1e18, aliceRh, burnRef1);

        vm.prank(admin);
        vault.unpause();

        vm.prank(releaser);
        vault.release(address(nvda), 1e18, aliceRh, burnRef1);
        assertEq(nvda.balanceOf(aliceRh), 1e18);
    }

    function test_guardian_canPauseButNotUnpause() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                guardian,
                bytes32(0) // DEFAULT_ADMIN_ROLE
            )
        );
        vault.unpause();
    }

    function test_randomCallerCannotPause() public {
        bytes32 role = vault.GUARDIAN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role
            )
        );
        vault.pause();
    }

    // --- migration ---------------------------------------------------------

    /// Collateral moved in from the v1 vault arrives without a deposit(), so
    /// syncBacking is what makes it redeemable.
    function test_syncBacking_reconcilesMigratedCollateral() public {
        // Simulate v1 releasing its locks into this vault.
        nvda.mint(address(vault), 42e18);
        assertEq(vault.backingOf(address(nvda)), 0, "not counted before sync");

        vm.prank(admin);
        vault.pause();

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit BackingSynced(address(nvda), 0, 42e18);
        vault.syncBacking(address(nvda));

        assertEq(vault.backingOf(address(nvda)), 42e18, "migrated backing counted");

        vm.prank(admin);
        vault.unpause();

        vm.prank(releaser);
        vault.release(address(nvda), 42e18, aliceRh, burnRef1);
        assertEq(nvda.balanceOf(aliceRh), 42e18, "migrated collateral is redeemable");
    }

    function test_syncBacking_requiresPaused() public {
        nvda.mint(address(vault), 1e18);
        vm.prank(admin);
        vm.expectRevert(StockLockVaultV2.NotPaused.selector);
        vault.syncBacking(address(nvda));
    }

    function test_syncBacking_onlyAdmin() public {
        vm.prank(admin);
        vault.pause();
        vm.prank(releaser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, releaser, bytes32(0)
            )
        );
        vault.syncBacking(address(nvda));
    }

    // --- deposit accounting ------------------------------------------------

    function test_deposit_recordsReceivedNotRequested_feeOnTransfer() public {
        FeeERC20 fee = new FeeERC20();
        fee.mint(alice, 100e18);
        vm.prank(admin);
        vault.setTokenAllowed(address(fee), true);

        vm.startPrank(alice);
        fee.approve(address(vault), 100e18);
        uint256 id = vault.deposit(address(fee), 100e18, suiAlice);
        vm.stopPrank();

        uint256 received = 99e18; // 1% skimmed in transit
        assertEq(fee.balanceOf(address(vault)), received, "vault really holds 99");
        assertEq(vault.backingOf(address(fee)), received, "backing matches holdings");
        (,, uint256 amount,) = vault.getLock(id);
        assertEq(amount, received, "lock records what arrived");

        // Backing never promises more than the vault can actually pay.
        vm.prank(releaser);
        vault.release(address(fee), received, aliceRh, burnRef1);
        assertEq(vault.backingOf(address(fee)), 0);
    }

    function test_deposit_rejectsUnknownTokenAndZeros() public {
        MockERC20 junk = new MockERC20("Junk", "JUNK", 18);
        junk.mint(alice, 1e18);

        vm.startPrank(alice);
        junk.approve(address(vault), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(StockLockVaultV2.TokenNotAllowed.selector, address(junk))
        );
        vault.deposit(address(junk), 1e18, suiAlice);

        nvda.approve(address(vault), 1e18);
        vm.expectRevert(StockLockVaultV2.ZeroAmount.selector);
        vault.deposit(address(nvda), 0, suiAlice);

        vm.expectRevert(StockLockVaultV2.ZeroSuiRecipient.selector);
        vault.deposit(address(nvda), 1e18, bytes32(0));
        vm.stopPrank();
    }

    function test_deposit_tracksIdsAndAggregate() public {
        uint256 a = _deposit(alice, nvda, 3e18);
        uint256 b = _deposit(alice, nvda, 7e18);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(vault.nextDepositId(), 3);
        assertEq(vault.depositedBy(alice, address(nvda)), 10e18);
        assertEq(vault.backingOf(address(nvda)), 10e18);
    }

    // --- partial redemptions, the everyday case ----------------------------

    /// Several unrelated burns of arbitrary sizes all settle against one pool.
    function test_manyArbitraryBurnsSettleFromPool() public {
        _deposit(alice, nvda, 10e18);
        _deposit(bob, nvda, 5e18);

        uint256[3] memory amounts = [uint256(0.37e18), 12.5e18, 2.13e18];
        for (uint256 i = 0; i < amounts.length; i++) {
            vm.prank(releaser);
            vault.release(address(nvda), amounts[i], aliceRh, keccak256(abi.encode("burn", i)));
        }

        assertEq(nvda.balanceOf(aliceRh), 15e18, "all three paid exactly");
        assertEq(vault.backingOf(address(nvda)), 0, "pool drawn down to zero");
    }
}
