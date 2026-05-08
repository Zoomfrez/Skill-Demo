---
name: fhevm
description: Build confidential smart contracts and dApps using Zama's FHEVM (Fully Homomorphic Encryption Virtual Machine). Use this skill when writing, testing, or deploying Solidity contracts that operate on encrypted data, or when building frontend applications that encrypt inputs and decrypt outputs. Covers encrypted types, FHE operations, access control, input proofs, decryption flows, relayer SDK integration, Hardhat testing, and common failure modes. Trigger on any task involving: FHEVM, confidential smart contracts, encrypted ERC20, ERC-7984, ConfidentialERC20, FHE.add/FHE.allow, euint types, ZamaEthereumConfig, Hardhat template setup, or private onchain computation.
---

# FHEVM Skill — Index

FHEVM lets Solidity contracts compute on encrypted data without ever decrypting it onchain. Encrypted values are ciphertext **handles** — references to ciphertexts stored by the coprocessor. Operations like `FHE.add(a, b)` return a new handle. Decryption is always async, off-chain, via the Zama KMS relayer.

## Files in this skill

| File | Read when |
|---|---|
| `CORE_RULES.md` | Writing or auditing any Solidity contract. Contains MUST/SHOULD/NEVER rules — read first. |
| `FRONTEND.md` | Building any UI that encrypts inputs or decrypts results. |
| `DEPLOYMENT.md` | Shipping to Sepolia or mainnet. Pre-deploy and post-deploy checklists. |
| `ANTI_PATTERNS.md` | Debugging a revert or unexpected behavior. Problem → Why → Fix. |
| `EXAMPLES.md` | Need a clean, production-grade reference contract or frontend snippet. |
| `CHANGELOG.md` | Pinning versions or hitting a "version mismatch" error. |
| `SETUP.md` | Starting a new project from zero. Full environment setup from the Zama Hardhat template. |
| `ERC7984.md` | Building confidential tokens. ERC-7984 standard, OpenZeppelin ConfidentialERC20, wrapping ERC-20. |

## Quick start

1. **No project yet** → `CORE_RULES.md` §0 (Scope) + `EXAMPLES.md` (pick a shape).
2. **Have a contract, want to audit** → `ANTI_PATTERNS.md` (run the checklist) + `CORE_RULES.md` §ACL.
1.5. **Starting from zero** → `SETUP.md` (template setup) then `CORE_RULES.md` §0.
3. **Hit an error** → `ANTI_PATTERNS.md` (revert table) + `CHANGELOG.md` (version mismatch).
4. **Deploying** → `DEPLOYMENT.md` (pre-ship checklist).
5. **Building frontend** → `FRONTEND.md` (SDK setup → encrypt → decrypt flows).

## Hard rules (always-on)

- **NEVER** put FHE operations in a constructor.
- **NEVER** branch on an `ebool` with `if`. Use `FHE.select`.
- **NEVER** use `euint256` for arithmetic — bitwise/eq only.
- **MUST** call `FHE.allowThis` after every state-modifying FHE op on stored handles.
- **MUST** call `FHE.fromExternal` before operating on an `externalEuintXX` input.
- **MUST** add replay protection on any function that consumes a `decryptionProof`.

If any of these is unclear, stop and read `CORE_RULES.md` before writing code.

## Context check (before generating any code)

```
1. Does a contract already exist?
   YES → request the file. Do not regenerate. Audit per ANTI_PATTERNS.md.
   NO  → confirm scope:
         - target network (Sepolia / mainnet)
         - core encrypted state (variables + types)
         - roles (who can read/write)
         - decryption flow (user-only / public reveal / none)
```

Do not start coding until scope is confirmed in writing. Scope creep mid-build is the primary reason FHEVM projects fail to ship.
