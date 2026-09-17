// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StockLockVaultV2} from "../src/StockLockVaultV2.sol";

/// @notice Deploy StockLockVaultV2 on Robinhood Chain (4663) or testnet (46630).
///
/// Deploys **paused** when MIGRATE=1, so collateral can be moved in from the v1
/// vault and reconciled with `syncBacking` before any deposit or release is
/// possible. Unpause is a deliberate, separate admin tx.
///
/// Env:
///   PRIVATE_KEY   - deployer (becomes DEFAULT_ADMIN unless ADMIN set)
///   ADMIN         - optional admin address (defaults to deployer)
///   RELEASER      - optional RELEASER_ROLE address (defaults to deployer)
///   GUARDIAN      - optional GUARDIAN_ROLE address (pause-only; defaults to admin)
///   MIGRATE=1     - leave the vault paused after deploy (recommended)
///   RH_NVDA / RH_AMC / RH_GME / RH_TSLA - optional allowlist overrides
contract DeployV2 is Script {
    address constant DEFAULT_NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant DEFAULT_AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;
    address constant DEFAULT_GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address constant DEFAULT_TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envOr("ADMIN", deployer);
        address releaser = vm.envOr("RELEASER", deployer);
        address guardian = vm.envOr("GUARDIAN", admin);
        bool migrate = vm.envOr("MIGRATE", uint256(0)) == 1;

        address nvda = vm.envOr("RH_NVDA", DEFAULT_NVDA);
        address amc = vm.envOr("RH_AMC", DEFAULT_AMC);
        address gme = vm.envOr("RH_GME", DEFAULT_GME);
        address tsla = vm.envOr("RH_TSLA", DEFAULT_TSLA);

        vm.startBroadcast(pk);

        StockLockVaultV2 vault = new StockLockVaultV2(admin, releaser, guardian);

        address[] memory tokens = new address[](4);
        tokens[0] = nvda;
        tokens[1] = amc;
        tokens[2] = gme;
        tokens[3] = tsla;

        if (admin == deployer) {
            vault.setTokensAllowed(tokens, true);
            // Pause before anyone can deposit, so migrated collateral can be
            // synced into `totalLocked` without racing a live release.
            if (migrate) vault.pause();
        }

        vm.stopBroadcast();

        console2.log("StockLockVaultV2", address(vault));
        console2.log("admin", admin);
        console2.log("releaser", releaser);
        console2.log("guardian", guardian);
        console2.log("paused", vault.paused());
        console2.log("NVDA", nvda);
        console2.log("AMC", amc);
        console2.log("GME", gme);
        console2.log("TSLA", tsla);
        if (admin != deployer) {
            console2.log("NOTE: admin != deployer - setTokensAllowed (and pause) must be sent as admin");
        }
        if (migrate) {
            console2.log("NEXT: move v1 collateral here, then syncBacking(token) per token, then unpause");
        }
    }
}
