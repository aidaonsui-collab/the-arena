// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title StockLockVaultV2
/// @notice Robinhood Chain lock vault for the Arena RH→Sui stock wrap.
/// @dev v1 (`StockLockVault`) paid redemptions with `release(depositId, to)` —
///      all-or-nothing per deposit. That quantised redemption to whole historical
///      deposits, so a burn on Sui that did not equal a FIFO prefix-sum of whole
///      unreleased locks could not be paid in full. Because `bridge::burn`
///      destroys the wrapper unconditionally, the shortfall was simply lost by
///      the redeemer.
///
///      v2 treats the vault as a pool: `release(token, amount, to, suiBurnRef)`
///      pays any amount up to the recorded backing for that token. Deposits are
///      still recorded individually, but only as an audit trail — they are no
///      longer the unit of payout.
///
///      Because payouts are no longer identified by a depositId, replay
///      protection moves on-chain: each release is keyed by `suiBurnRef`, the
///      identity of the Sui `RedeemBurned` event being settled. v1 relied on the
///      keeper's local JSON store for this, which could (and did) diverge from
///      chain state whenever a send was not confirmed.
contract StockLockVaultV2 is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");
    /// @notice May pause deposits/releases but holds no spending power.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    struct Lock {
        address depositor;
        address token;
        /// @dev Amount actually received (post-transfer balance delta), not the
        ///      amount requested — a fee-on-transfer or rebasing token would
        ///      otherwise record more backing than the vault holds.
        uint256 amount;
        bytes32 suiRecipient;
    }

    /// @notice Allowlisted RH stock ERC-20s (NVDA/AMC/GME/TSLA, …).
    mapping(address => bool) public allowedTokens;

    /// @notice depositId => lock record (audit trail; depositId starts at 1).
    mapping(uint256 => Lock) public locks;

    /// @notice Next deposit id to assign (monotonic; 0 is unused/invalid).
    uint256 public nextDepositId = 1;

    /// @notice Pooled backing per token: what redemptions may draw against.
    mapping(address => uint256) public totalLocked;

    /// @notice Aggregated deposited (never-decreasing) total per depositor per token.
    /// @dev Informational. Redemption is pooled, so this is not a per-user claim.
    mapping(address => mapping(address => uint256)) public depositedBy;

    /// @notice Sui RedeemBurned events already settled, keyed by `suiBurnRef`.
    mapping(bytes32 => bool) public settledBurns;

    event TokenAllowlisted(address indexed token, bool allowed);

    /// @notice Emitted when ERC-20 stock tokens are locked for Sui wrap mint.
    /// @param token Allowlisted RH stock token
    /// @param depositor EOA/contract that locked
    /// @param amount Base units actually received (18 decimals for RH stock tokens)
    /// @param suiRecipient 32-byte Sui address that should receive the wrap
    /// @param depositId Unique lock id (nonce) for the attestor
    event DepositLocked(
        address indexed token,
        address indexed depositor,
        uint256 amount,
        bytes32 suiRecipient,
        uint256 indexed depositId
    );

    /// @notice Emitted when a Sui burn is settled out of the pool.
    /// @param suiBurnRef Identity of the settled Sui `RedeemBurned` event
    event Released(
        address indexed token,
        address indexed to,
        uint256 amount,
        bytes32 indexed suiBurnRef
    );

    /// @notice Emitted when admin reconciles recorded backing to the real balance.
    event BackingSynced(address indexed token, uint256 from, uint256 to);

    error TokenNotAllowed(address token);
    error ZeroAmount();
    error ZeroAddress();
    error ZeroSuiRecipient();
    error ZeroBurnRef();
    error BurnAlreadySettled(bytes32 suiBurnRef);
    error InsufficientBacking(address token, uint256 requested, uint256 available);
    error NotPaused();

    constructor(address admin, address releaser, address guardian) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (releaser != address(0)) _grantRole(RELEASER_ROLE, releaser);
        if (guardian != address(0)) _grantRole(GUARDIAN_ROLE, guardian);
    }

    // --- admin -------------------------------------------------------------

    /// @notice Admin: set whether a stock ERC-20 may be deposited.
    function setTokenAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit TokenAllowlisted(token, allowed);
    }

    /// @notice Admin: batch allowlist helper for deploy scripts.
    function setTokensAllowed(address[] calldata tokens, bool allowed)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == address(0)) revert ZeroAddress();
            allowedTokens[token] = allowed;
            emit TokenAllowlisted(token, allowed);
        }
    }

    /// @notice Guardian/admin: halt deposits and releases.
    function pause() external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        _pause();
    }

    /// @notice Admin only: resume. Deliberately not guardian-callable.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Admin: reconcile recorded backing for `token` to the real balance.
    /// @dev Migration primitive — collateral moved in from the v1 vault (or sent
    ///      directly) arrives without a `deposit()`, so `totalLocked` would not
    ///      count it and redemptions could not draw on it. Restricted to the
    ///      paused state so it is a deliberate operational step and can never
    ///      race a live release.
    function syncBacking(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!paused()) revert NotPaused();
        if (token == address(0)) revert ZeroAddress();
        uint256 from = totalLocked[token];
        uint256 to = IERC20(token).balanceOf(address(this));
        totalLocked[token] = to;
        emit BackingSynced(token, from, to);
    }

    // --- user --------------------------------------------------------------

    /// @notice Lock `amount` of `token` for wrap mint to `suiRecipient`.
    /// @dev Caller must `approve` this vault first. Pulls via transferFrom and
    ///      records the observed balance delta, so a fee-on-transfer token
    ///      cannot record more backing than actually arrived.
    function deposit(address token, uint256 amount, bytes32 suiRecipient)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 depositId)
    {
        if (!allowedTokens[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        if (suiRecipient == bytes32(0)) revert ZeroSuiRecipient();

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroAmount();

        depositId = nextDepositId++;
        locks[depositId] = Lock({
            depositor: msg.sender,
            token: token,
            amount: received,
            suiRecipient: suiRecipient
        });
        totalLocked[token] += received;
        depositedBy[msg.sender][token] += received;

        emit DepositLocked(token, msg.sender, received, suiRecipient, depositId);
    }

    // --- releaser ----------------------------------------------------------

    /// @notice Settle a Sui `RedeemBurned` by paying `amount` of `token` to `to`.
    /// @param suiBurnRef Identity of the Sui burn being settled — the keeper
    ///        derives it from the event's `(txDigest, eventSeq)`. Enforced unique
    ///        on-chain, so a retried or duplicated send cannot pay twice.
    function release(address token, uint256 amount, address to, bytes32 suiBurnRef)
        external
        nonReentrant
        whenNotPaused
        onlyRole(RELEASER_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (suiBurnRef == bytes32(0)) revert ZeroBurnRef();
        if (settledBurns[suiBurnRef]) revert BurnAlreadySettled(suiBurnRef);

        uint256 backing = totalLocked[token];
        if (amount > backing) revert InsufficientBacking(token, amount, backing);

        settledBurns[suiBurnRef] = true;
        totalLocked[token] = backing - amount;

        IERC20(token).safeTransfer(to, amount);

        emit Released(token, to, amount, suiBurnRef);
    }

    // --- views -------------------------------------------------------------

    /// @notice View helper for a single lock (audit trail).
    function getLock(uint256 depositId)
        external
        view
        returns (address depositor, address token, uint256 amount, bytes32 suiRecipient)
    {
        Lock storage lock_ = locks[depositId];
        return (lock_.depositor, lock_.token, lock_.amount, lock_.suiRecipient);
    }

    /// @notice Pooled backing available to redeem for `token`.
    function backingOf(address token) external view returns (uint256) {
        return totalLocked[token];
    }

    /// @notice Whether this Sui burn has already been settled.
    function isSettled(bytes32 suiBurnRef) external view returns (bool) {
        return settledBurns[suiBurnRef];
    }
}
