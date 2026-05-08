// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Confidential Salary Registry
/// @notice Managers set encrypted salaries; employees decrypt only their own.
contract SalaryRegistry is ZamaEthereumConfig {
    enum Role {
        None,
        Employee,
        Manager,
        Admin
    }

    mapping(address => Role) public roles;
    mapping(address => euint64) private _salaries;

    event RoleGranted(address indexed account, Role role);
    event SalarySet(address indexed employee, bytes32 handle);
    event Registered(address indexed account);

    modifier onlyRole(Role r) {
        require(uint8(roles[msg.sender]) >= uint8(r), "SalaryRegistry: insufficient role");
        _;
    }

    constructor(address admin) {
        roles[admin] = Role.Admin;
        emit RoleGranted(admin, Role.Admin);
    }

    /// @notice Anyone can self-register as an Employee.
    /// @dev Harmless — employees can only read their own salary once a manager sets it.
    ///      Cannot be used to escalate above Employee.
    function register() external {
        require(roles[msg.sender] == Role.None, "SalaryRegistry: already registered");
        roles[msg.sender] = Role.Employee;
        emit Registered(msg.sender);
        emit RoleGranted(msg.sender, Role.Employee);
    }

    function setRole(address account, Role role) external onlyRole(Role.Admin) {
        roles[account] = role;
        emit RoleGranted(account, role);
    }

    /// @notice Manager sets an encrypted salary for an employee.
    /// @param employee The employee's address.
    /// @param encSalary The ciphertext handle (externalEuint64).
    /// @param inputProof ZK proof binding the ciphertext to this contract + caller.
    function setSalary(address employee, externalEuint64 encSalary, bytes calldata inputProof)
        external
        onlyRole(Role.Manager)
    {
        require(roles[employee] >= Role.Employee, "SalaryRegistry: target is not an employee");

        _salaries[employee] = FHE.fromExternal(encSalary, inputProof);
        FHE.allowThis(_salaries[employee]);
        FHE.allow(_salaries[employee], employee); // employee can decrypt their own
        FHE.allow(_salaries[employee], msg.sender); // manager who set it retains read

        emit SalarySet(employee, FHE.toBytes32(_salaries[employee]));
    }

    /// @notice Grant an additional manager read access to an employee's salary.
    function grantManagerAccess(address manager, address employee) external onlyRole(Role.Admin) {
        require(FHE.isInitialized(_salaries[employee]), "SalaryRegistry: salary not set");
        require(roles[manager] >= Role.Manager, "SalaryRegistry: not a manager");
        FHE.allow(_salaries[employee], manager);
    }

    /// @notice Returns the encrypted salary handle for an employee.
    /// @dev ACL enforced by the relayer — only allowed addresses can decrypt.
    function getEncryptedSalary(address employee) external view returns (euint64) {
        return _salaries[employee];
    }

    function hasSalary(address employee) external view returns (bool) {
        return FHE.isInitialized(_salaries[employee]);
    }
}
