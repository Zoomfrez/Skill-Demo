// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {SalaryRegistry} from "../src/SalaryRegistry.sol";

contract DeploySalaryRegistry is Script {
    function run() external {
        address deployer = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        vm.startBroadcast();

        SalaryRegistry registry = new SalaryRegistry(deployer);
        console.log("SalaryRegistry deployed at:", address(registry));
        console.log("Admin:", deployer);

        vm.stopBroadcast();
    }
}
