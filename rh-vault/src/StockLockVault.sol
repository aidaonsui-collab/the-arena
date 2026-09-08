// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title StockLockVault
/// @notice Robinhood Chain lock vault for Arena RH→Sui stock wrap.
/// @dev User deposits allowlisted ERC-20 stock tokens; emits DepositLocked for
///      the Sui attestor. After RedeemBurned on Sui, a RELEASER unlocks back to `to`.
contract StockLockVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");

    struct Lock {
        address depositor;
        address token;
        uint256 amount;
        bytes32 suiRecipient;
        bool released;
    }

    /// @notice Allowlisted RH stock ERC-20s (NVDA/AMC/GME/TSLA, …).
    mapping(address => bool) public allowedTokens;

    /// @notice depositId => lock record (depositId starts at 1).
    mapping(uint256 => Lock) public locks;

    /// @notice Next deposit id to assign (monotonic; 0 is unused/invalid).
    uint256 public nextDepositId = 1;

    /// @notice Aggregated pending (unreleased) balance per depositor per token.
    mapping(address => mapping(address => uint256)) public pendingBalances;

    event TokenAllowlisted(address indexed token, bool allowed);

    /// @notice Emitted when ERC-20 stock tokens are locked for Sui wrap mint.
    /// @param token Allowlisted RH stock token
    /// @param depositor EOA/contract that locked
    /// @param amount Base units (18 decimals for RH stock tokens)
    /// @param suiRecipient 32-byte Sui address that should receive the wrap
    /// @param depositId Unique lock id (nonce) for attestor / release
    event DepositLocked(
        address indexed token,
        address indexed depositor,
        uint256 amount,
        bytes32 suiRecipient,
        uint256 indexed depositId
    );

    /// @notice Emitted when a lock is released after Sui burn attestation.
    event Released(
        uint256 indexed depositId,
        address indexed to,
        address token,
        uint256 amount
    );

    error TokenNotAllowed(address token);
    error ZeroAmount();
    error ZeroAddress();
    error ZeroSuiRecipient();
    error UnknownDeposit(uint256 depositId);
    error AlreadyReleased(uint256 depositId);

    constructor(address admin, address releaser) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (releaser != address(0)) {
            _grantRole(RELEASER_ROLE, releaser);
        }
    }

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

    /// @notice Lock `amount` of `token` for wrap mint to `suiRecipient`.
    /// @dev Caller must `approve` this vault first. Pulls via transferFrom.
    function deposit(address token, uint256 amount, bytes32 suiRecipient)
        external
        nonReentrant
        returns (uint256 depositId)
    {
        if (!allowedTokens[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        if (suiRecipient == bytes32(0)) revert ZeroSuiRecipient();

        depositId = nextDepositId++;
        locks[depositId] = Lock({
            depositor: msg.sender,
            token: token,
            amount: amount,
            suiRecipient: suiRecipient,
            released: false
        });
        pendingBalances[msg.sender][token] += amount;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit DepositLocked(token, msg.sender, amount, suiRecipient, depositId);
    }

    /// @notice Release a lock to `to` after Sui RedeemBurned (RELEASER / admin ops).
    function release(uint256 depositId, address to)
        external
        nonReentrant
        onlyRole(RELEASER_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        Lock storage lock_ = locks[depositId];
        if (lock_.depositor == address(0)) revert UnknownDeposit(depositId);
        if (lock_.released) revert AlreadyReleased(depositId);

        lock_.released = true;
        pendingBalances[lock_.depositor][lock_.token] -= lock_.amount;

        IERC20(lock_.token).safeTransfer(to, lock_.amount);

        emit Released(depositId, to, lock_.token, lock_.amount);
    }

    /// @notice View helper for a single lock.
    function getLock(uint256 depositId)
        external
        view
        returns (
            address depositor,
            address token,
            uint256 amount,
            bytes32 suiRecipient,
            bool released
        )
    {
        Lock storage lock_ = locks[depositId];
        return (lock_.depositor, lock_.token, lock_.amount, lock_.suiRecipient, lock_.released);
    }

    /// @notice Pending (locked, unreleased) balance for `user` of `token`.
    function pendingBalance(address user, address token) external view returns (uint256) {
        return pendingBalances[user][token];
    }
}
