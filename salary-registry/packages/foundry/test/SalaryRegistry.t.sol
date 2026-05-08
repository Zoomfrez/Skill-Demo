// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {SalaryRegistry} from "../src/SalaryRegistry.sol";
import {euint64, externalEuint64} from "encrypted-types/EncryptedTypes.sol";

contract SalaryRegistryTest is FhevmTest {
    SalaryRegistry registry;
    address registryAddress;

    uint256 internal constant ADMIN_PK = 0xAD1111;
    uint256 internal constant MANAGER_PK = 0xAA1111;
    uint256 internal constant EMPLOYEE_PK = 0xEE1111;
    uint256 internal constant STRANGER_PK = 0xFF1111;

    address admin;
    address manager;
    address employee;
    address stranger;

    function setUp() public override {
        super.setUp();
        admin = vm.addr(ADMIN_PK);
        manager = vm.addr(MANAGER_PK);
        employee = vm.addr(EMPLOYEE_PK);
        stranger = vm.addr(STRANGER_PK);

        vm.prank(admin);
        registry = new SalaryRegistry(admin);
        registryAddress = address(registry);
    }

    // ── register() ───────────────────────────────────────────────────────────

    function test_register_setsEmployeeRole() public {
        vm.prank(stranger);
        registry.register();
        assertEq(uint8(registry.roles(stranger)), uint8(SalaryRegistry.Role.Employee));
    }

    function test_register_revertsIfAlreadyRegistered() public {
        vm.prank(stranger);
        registry.register();
        vm.prank(stranger);
        vm.expectRevert("SalaryRegistry: already registered");
        registry.register();
    }

    function test_register_revertsIfAlreadyManager() public {
        vm.prank(admin);
        registry.setRole(manager, SalaryRegistry.Role.Manager);
        vm.prank(manager);
        vm.expectRevert("SalaryRegistry: already registered");
        registry.register();
    }

    // ── setRole() ────────────────────────────────────────────────────────────

    function test_setRole_adminCanPromoteToManager() public {
        vm.prank(admin);
        registry.setRole(manager, SalaryRegistry.Role.Manager);
        assertEq(uint8(registry.roles(manager)), uint8(SalaryRegistry.Role.Manager));
    }

    function test_setRole_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert("SalaryRegistry: insufficient role");
        registry.setRole(employee, SalaryRegistry.Role.Manager);
    }

    function test_setRole_adminCanRevoke() public {
        vm.prank(admin);
        registry.setRole(manager, SalaryRegistry.Role.Manager);
        vm.prank(admin);
        registry.setRole(manager, SalaryRegistry.Role.None);
        assertEq(uint8(registry.roles(manager)), uint8(SalaryRegistry.Role.None));
    }

    // ── setSalary() ──────────────────────────────────────────────────────────

    function _setupManagerAndEmployee() internal {
        vm.prank(admin);
        registry.setRole(manager, SalaryRegistry.Role.Manager);
        vm.prank(employee);
        registry.register();
    }

    function test_setSalary_managerCanSetEncryptedSalary() public {
        _setupManagerAndEmployee();

        uint64 clearSalary = 85_000;
        (externalEuint64 encSalary, bytes memory proof) = encryptUint64(clearSalary, manager, registryAddress);

        vm.prank(manager);
        registry.setSalary(employee, encSalary, proof);

        assertTrue(registry.hasSalary(employee));
    }

    function test_setSalary_employeeCanDecryptOwnSalary() public {
        _setupManagerAndEmployee();

        uint64 clearSalary = 90_000;
        (externalEuint64 encSalary, bytes memory proof) = encryptUint64(clearSalary, manager, registryAddress);

        vm.prank(manager);
        registry.setSalary(employee, encSalary, proof);

        euint64 handle = registry.getEncryptedSalary(employee);
        bytes memory sig = signUserDecrypt(EMPLOYEE_PK, registryAddress);
        uint256 decrypted = userDecrypt(euint64.unwrap(handle), employee, registryAddress, sig);

        assertEq(decrypted, clearSalary);
    }

    function test_setSalary_managerRetainsReadAccess() public {
        _setupManagerAndEmployee();

        uint64 clearSalary = 75_000;
        (externalEuint64 encSalary, bytes memory proof) = encryptUint64(clearSalary, manager, registryAddress);

        vm.prank(manager);
        registry.setSalary(employee, encSalary, proof);

        euint64 handle = registry.getEncryptedSalary(employee);
        bytes memory sig = signUserDecrypt(MANAGER_PK, registryAddress);
        uint256 decrypted = userDecrypt(euint64.unwrap(handle), manager, registryAddress, sig);

        assertEq(decrypted, clearSalary);
    }

    function test_setSalary_revertsForNonManager() public {
        _setupManagerAndEmployee();

        uint64 clearSalary = 50_000;
        (externalEuint64 encSalary, bytes memory proof) = encryptUint64(clearSalary, stranger, registryAddress);

        vm.prank(stranger);
        vm.expectRevert("SalaryRegistry: insufficient role");
        registry.setSalary(employee, encSalary, proof);
    }

    function test_setSalary_revertsForNonEmployee() public {
        vm.prank(admin);
        registry.setRole(manager, SalaryRegistry.Role.Manager);

        uint64 clearSalary = 50_000;
        (externalEuint64 encSalary, bytes memory proof) = encryptUint64(clearSalary, manager, registryAddress);

        vm.prank(manager);
        vm.expectRevert("SalaryRegistry: target is not an employee");
        registry.setSalary(stranger, encSalary, proof);
    }

    function test_setSalary_aclPermissionsAreCorrect() public {
        _setupManagerAndEmployee();

        uint64 clearSalary = 60_000;
        (externalEuint64 encSalary, bytes memory proof) = encryptUint64(clearSalary, manager, registryAddress);

        vm.prank(manager);
        registry.setSalary(employee, encSalary, proof);

        bytes32 handle = euint64.unwrap(registry.getEncryptedSalary(employee));

        // Contract, employee, and manager should have ACL access
        assertTrue(_acl.persistAllowed(handle, registryAddress), "contract should have ACL");
        assertTrue(_acl.persistAllowed(handle, employee), "employee should have ACL");
        assertTrue(_acl.persistAllowed(handle, manager), "manager should have ACL");

        // Stranger must NOT have ACL access
        assertFalse(_acl.persistAllowed(handle, stranger), "stranger must not have ACL");
    }

    // ── grantManagerAccess() ─────────────────────────────────────────────────

    function test_grantManagerAccess_secondManagerCanDecrypt() public {
        _setupManagerAndEmployee();

        address manager2 = makeAddr("manager2");
        vm.prank(admin);
        registry.setRole(manager2, SalaryRegistry.Role.Manager);

        uint64 clearSalary = 95_000;
        (externalEuint64 encSalary, bytes memory proof) = encryptUint64(clearSalary, manager, registryAddress);
        vm.prank(manager);
        registry.setSalary(employee, encSalary, proof);

        vm.prank(admin);
        registry.grantManagerAccess(manager2, employee);

        euint64 handle = registry.getEncryptedSalary(employee);
        uint256 manager2Pk = uint256(keccak256(abi.encodePacked("manager2")));
        bytes memory sig = signUserDecrypt(manager2Pk, registryAddress);
        uint256 decrypted = userDecrypt(euint64.unwrap(handle), manager2, registryAddress, sig);

        assertEq(decrypted, clearSalary);
    }

    function test_grantManagerAccess_revertsIfSalaryNotSet() public {
        vm.prank(admin);
        registry.setRole(manager, SalaryRegistry.Role.Manager);

        vm.prank(employee);
        registry.register();

        vm.prank(admin);
        vm.expectRevert("SalaryRegistry: salary not set");
        registry.grantManagerAccess(manager, employee);
    }
}
