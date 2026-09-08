// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockLockVault} from "../src/StockLockVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract StockLockVaultTest is Test {
    StockLockVault internal vault;
    MockERC20 internal nvda;
    MockERC20 internal amc;
    MockERC20 internal junk;

    address internal admin = address(0xA11CE);
    address internal releaser = address(0xB0B);
    address internal user = address(0x55E4);
    address internal user2 = address(0x55E5);

    bytes32 internal suiRecipient =
        bytes32(uint256(0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b));

    event DepositLocked(
        address indexed token,
        address indexed depositor,
        uint256 amount,
        bytes32 suiRecipient,
        uint256 indexed depositId
    );
    event Released(uint256 indexed depositId, address indexed to, address token, uint256 amount);

    function setUp() public {
        vault = new StockLockVault(admin, releaser);
        nvda = new MockERC20("NVIDIA RH", "NVDA", 18);
        amc = new MockERC20("AMC RH", "AMC", 18);
        junk = new MockERC20("Junk", "JUNK", 18);

        vm.startPrank(admin);
        vault.setTokenAllowed(address(nvda), true);
        vault.setTokenAllowed(address(amc), true);
        vm.stopPrank();

        nvda.mint(user, 1_000 ether);
        amc.mint(user, 500 ether);
        junk.mint(user, 100 ether);
    }

    function test_deposit_locks_and_emits() public {
        uint256 amount = 10 ether;
        vm.startPrank(user);
        nvda.approve(address(vault), amount);

        vm.expectEmit(true, true, true, true);
        emit DepositLocked(address(nvda), user, amount, suiRecipient, 1);
        uint256 id = vault.deposit(address(nvda), amount, suiRecipient);
        vm.stopPrank();

        assertEq(id, 1);
        assertEq(nvda.balanceOf(address(vault)), amount);
        assertEq(vault.pendingBalance(user, address(nvda)), amount);

        (address depositor, address token, uint256 amt, bytes32 sui, bool released) = vault.getLock(1);
        assertEq(depositor, user);
        assertEq(token, address(nvda));
        assertEq(amt, amount);
        assertEq(sui, suiRecipient);
        assertFalse(released);
    }

    function test_deposit_rejects_non_allowlisted() public {
        vm.startPrank(user);
        junk.approve(address(vault), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(StockLockVault.TokenNotAllowed.selector, address(junk)));
        vault.deposit(address(junk), 1 ether, suiRecipient);
        vm.stopPrank();
    }

    function test_deposit_rejects_zero_amount_and_zero_sui() public {
        vm.startPrank(user);
        nvda.approve(address(vault), 1 ether);
        vm.expectRevert(StockLockVault.ZeroAmount.selector);
        vault.deposit(address(nvda), 0, suiRecipient);
        vm.expectRevert(StockLockVault.ZeroSuiRecipient.selector);
        vault.deposit(address(nvda), 1 ether, bytes32(0));
        vm.stopPrank();
    }

    function test_release_by_releaser() public {
        uint256 amount = 25 ether;
        vm.startPrank(user);
        nvda.approve(address(vault), amount);
        uint256 id = vault.deposit(address(nvda), amount, suiRecipient);
        vm.stopPrank();

        vm.startPrank(releaser);
        vm.expectEmit(true, true, false, true);
        emit Released(id, user2, address(nvda), amount);
        vault.release(id, user2);
        vm.stopPrank();

        assertEq(nvda.balanceOf(user2), amount);
        assertEq(vault.pendingBalance(user, address(nvda)), 0);
        (,,,, bool released) = vault.getLock(id);
        assertTrue(released);
    }

    function test_release_only_releaser() public {
        vm.startPrank(user);
        nvda.approve(address(vault), 1 ether);
        uint256 id = vault.deposit(address(nvda), 1 ether, suiRecipient);
        vm.stopPrank();

        vm.prank(user);
        vm.expectRevert();
        vault.release(id, user);
    }

    function test_release_cannot_double() public {
        vm.startPrank(user);
        nvda.approve(address(vault), 1 ether);
        uint256 id = vault.deposit(address(nvda), 1 ether, suiRecipient);
        vm.stopPrank();

        vm.startPrank(releaser);
        vault.release(id, user);
        vm.expectRevert(abi.encodeWithSelector(StockLockVault.AlreadyReleased.selector, id));
        vault.release(id, user);
        vm.stopPrank();
    }

    function test_multi_token_pending() public {
        vm.startPrank(user);
        nvda.approve(address(vault), 3 ether);
        amc.approve(address(vault), 2 ether);
        vault.deposit(address(nvda), 3 ether, suiRecipient);
        vault.deposit(address(amc), 2 ether, suiRecipient);
        vm.stopPrank();

        assertEq(vault.pendingBalance(user, address(nvda)), 3 ether);
        assertEq(vault.pendingBalance(user, address(amc)), 2 ether);
        assertEq(vault.nextDepositId(), 3);
    }

    function test_admin_can_grant_releaser() public {
        address newReleaser = address(0x1111);
        bytes32 releaserRole = vault.RELEASER_ROLE();
        vm.prank(admin);
        vault.grantRole(releaserRole, newReleaser);

        vm.startPrank(user);
        nvda.approve(address(vault), 1 ether);
        uint256 id = vault.deposit(address(nvda), 1 ether, suiRecipient);
        vm.stopPrank();

        vm.prank(newReleaser);
        vault.release(id, user);
        assertEq(nvda.balanceOf(user), 1_000 ether); // minted 1000, locked 1, released 1
    }
}
