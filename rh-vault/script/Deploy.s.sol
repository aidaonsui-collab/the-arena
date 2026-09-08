// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StockLockVault} from "../src/StockLockVault.sol";

/// @notice Deploy StockLockVault on Robinhood Chain (4663) or testnet (46630).
///
/// Env:
///   PRIVATE_KEY       - deployer (becomes DEFAULT_ADMIN unless ADMIN set)
///   ADMIN             - optional admin address (defaults to deployer)
///   RELEASER          - optional RELEASER_ROLE address (defaults to deployer)
///   RH_NVDA / RH_AMC / RH_GME / RH_TSLA - optional overrides for allowlist
///
/// Known mainnet (4663) stock tokens (override via env if docs change):
///   NVDA 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
///   AMC  0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B
///   GME  0x1b0E319c6A659F002271B69dB8A7df2F911c153E
///   TSLA 0x322F0929c4625eD5bAd873c95208D54E1c003b2d
contract Deploy is Script {
    // Official / widely cited Robinhood Chain mainnet stock tokens
    address constant DEFAULT_NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant DEFAULT_AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;
    address constant DEFAULT_GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address constant DEFAULT_TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envOr("ADMIN", deployer);
        address releaser = vm.envOr("RELEASER", deployer);

        address nvda = vm.envOr("RH_NVDA", DEFAULT_NVDA);
        address amc = vm.envOr("RH_AMC", DEFAULT_AMC);
        address gme = vm.envOr("RH_GME", DEFAULT_GME);
        address tsla = vm.envOr("RH_TSLA", DEFAULT_TSLA);

        vm.startBroadcast(pk);

        StockLockVault vault = new StockLockVault(admin, releaser);

        address[] memory tokens = new address[](4);
        tokens[0] = nvda;
        tokens[1] = amc;
        tokens[2] = gme;
        tokens[3] = tsla;

        // Only admin can allowlist - if admin == deployer we can call now;
        // otherwise grant and call as admin via a second tx / prank is N/A on-chain.
        if (admin == deployer) {
            vault.setTokensAllowed(tokens, true);
        }

        vm.stopBroadcast();

        console2.log("StockLockVault", address(vault));
        console2.log("admin", admin);
        console2.log("releaser", releaser);
        console2.log("NVDA", nvda);
        console2.log("AMC", amc);
        console2.log("GME", gme);
        console2.log("TSLA", tsla);
        if (admin != deployer) {
            console2.log("NOTE: admin != deployer - call setTokensAllowed as admin after deploy");
        }
    }
}
