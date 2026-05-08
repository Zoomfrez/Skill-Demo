# ANTI_PATTERNS.md

Red flags. Each entry: **Problem → Why it breaks → Correct fix**.

Skim before code review or audit. If a contract triggers any of these, fix before considering it complete.

---

## QUICK INDEX

| # | Anti-pattern | Severity |
|---|---|---|
| 1 | Missing `allowThis` after state update | **breaks next tx** |
| 2 | Branching on `ebool` with `if` | **wrong semantics** |
| 3 | Encrypted RHS for `div`/`rem` | **runtime revert** |
| 4 | Arithmetic on `euint256` | **silent / compile error** |
| 5 | FHE ops in constructor | **silent fail on Sepolia** |
| 6 | Decrypt assumed synchronous | **doesn't compile** |
| 7 | Mismatched handle order in `checkSignatures` | **silent revert** |
| 8 | Missing `fromExternal` on input | **type error** |
| 9 | No replay protection on finalize | **multi-execute attack** |
| 10 | No overflow guard | **silent corruption** |
| 11 | Wrapping scalar in `asEuint64` unnecessarily | **wasteful gas** |
| 12 | Oversized encrypted type | **wasteful gas** |
| 13 | Cross-contract handle without `allowTransient` | **revert in callee** |
| 14 | Granting ACL to non-FHE contract | **breaks in callee** |
| 15 | Emitting derived plaintext | **privacy leak** |
| 16 | Frontend "fake success" before mining | **state divergence** |
| 17 | API key in client bundle | **credential leak** |
| 18 | Hardcoded ACL/KMS addresses | **breaks across networks** |
| 19 | Not invalidating cache on `accountsChanged` | **wrong-user data** |
| 20 | Retrying on deterministic relayer errors | **infinite loop** |
| 21 | Upgradeable impl without `_disableInitializers` | **ACL bound to wrong addr** |
| 22 | Boolean mapping for double-claim when handle check suffices | **unnecessary state** |
| 23 | N-party sum validation done without state-machine replay guard | **re-enterable finalization** |

---

## §1 — Missing `FHE.allowThis` after state update

**Problem.** Contract stores a new ciphertext but doesn't grant itself ACL permission to use it later.

```solidity
balances[user] = FHE.add(balances[user], amount); // no allow → next tx reverts
```

**Why it breaks.** A handle is unusable until ACL grants permission. The first transaction succeeds because the contract had permission on the *old* `balances[user]`. The new handle (returned by `FHE.add`) has no ACL entry. The next transaction that tries to read or compute on it reverts.

**Fix.**
```solidity
balances[user] = FHE.add(balances[user], amount);
FHE.allowThis(balances[user]);
FHE.allow(balances[user], user);
```

---

## §2 — Branching on `ebool` with `if`

**Problem.** Treating `ebool` like Solidity's `bool`.

```solidity
if (FHE.gt(a, b)) { ... }   // ebool is a handle, not a bool
```

**Why it breaks.** `ebool` is a ciphertext handle — a `bytes32` reference to encrypted state. It's truthy in Solidity's eyes (non-zero), so `if` always takes the true branch. Logic is silently wrong, not reverting.

**Fix.**
```solidity
euint64 result = FHE.select(FHE.gt(a, b), a, b);
```

`FHE.select` is the only branching primitive on encrypted state.

---

## §3 — Encrypted RHS for `div`/`rem`

**Problem.** Using a ciphertext as the divisor.

```solidity
euint64 r = FHE.div(amount, encryptedDivisor);
```

**Why it breaks.** FHE division/modulo is only implemented for plaintext scalar divisors. Encrypted divisor reverts at runtime.

**Fix.**
```solidity
euint64 r = FHE.div(amount, 12);   // scalar literal
```

If the divisor truly must be encrypted, restructure the algorithm. Multiplication-based approximations or pre-computed lookup tables are typical workarounds.

---

## §4 — Arithmetic on `euint256`

**Problem.** Using `euint256` for math.

```solidity
euint256 x = FHE.asEuint256(value);
euint256 y = FHE.add(x, FHE.asEuint256(1));   // compile error or silent no-op
```

**Why it breaks.** `euint256` does not implement arithmetic. Depending on SDK version, this is a compile error or — worse — a silent no-op.

**Fix.** Use the smallest type that fits the value range.
```solidity
euint64 counter = FHE.asEuint64(value);
euint64 next = FHE.add(counter, 1);
```

Reserve `euint256` for hash-sized values needing bitwise ops or eq comparison only.

---

## §5 — FHE operations in the constructor

**Problem.** Initializing encrypted state in the constructor.

```solidity
constructor() {
    encryptedSupply = FHE.asEuint64(1000000);   // silent fail on Sepolia
}
```

**Why it breaks.** The coprocessor isn't available during contract construction on live networks. The mock environment lets this slip through.

**Fix.** Move initialization to a post-deploy function.
```solidity
bool private _initialized;
function initialize(externalEuint64 enc, bytes calldata p) external {
    require(!_initialized, "init");
    _initialized = true;
    encryptedSupply = FHE.fromExternal(enc, p);
    FHE.allowThis(encryptedSupply);
}
```

---

## §6 — Assuming decryption is synchronous

**Problem.**
```solidity
uint64 plain = FHE.decrypt(encryptedValue);   // function does not exist
```

**Why it breaks.** FHEVM has no synchronous on-chain `decrypt` — it would defeat the cryptographic guarantees.

**Fix.** Use the 3-step async flow:
1. On-chain: `FHE.makePubliclyDecryptable(handle)`.
2. Off-chain: `instance.publicDecrypt([handle])` returns `clearValues` + `decryptionProof`.
3. On-chain: `FHE.checkSignatures(handles, abiEncoded, proof)` then use the plaintext.

Architect contracts around finalization callbacks, not inline reads.

---

## §7 — Mismatched handle order in `checkSignatures`

**Problem.**
```solidity
// Off-chain called: publicDecrypt([efoo, ebar])
// On-chain:
handles[0] = FHE.toBytes32(encryptedBar);   // reversed
handles[1] = FHE.toBytes32(encryptedFoo);
```

**Why it breaks.** The decryption proof is bound to the exact tuple `(handles[], plaintextValues[])` in the order they were submitted to the relayer. Reordering invalidates the proof. Often reverts with no message.

**Fix.** Maintain a single source of truth for the order. Pass it as an array constant or a comment:
```solidity
// ORDER: (encryptedFoo, encryptedBar) — must match publicDecrypt call
handles[0] = FHE.toBytes32(encryptedFoo);
handles[1] = FHE.toBytes32(encryptedBar);
bytes memory enc = abi.encode(clearFoo, clearBar);   // same order
FHE.checkSignatures(handles, enc, proof);
```

---

## §8 — Not calling `fromExternal` on inputs

**Problem.**
```solidity
function broken(externalEuint64 raw, bytes calldata proof) external {
    balances[msg.sender] = FHE.add(balances[msg.sender], raw); // type error
}
```

**Why it breaks.** `externalEuint64` is a distinct type from `euint64`. Operations are not defined on it.

**Fix.**
```solidity
function correct(externalEuint64 raw, bytes calldata proof) external {
    euint64 amount = FHE.fromExternal(raw, proof);   // validates ZKPoK
    balances[msg.sender] = FHE.add(balances[msg.sender], amount);
    FHE.allowThis(balances[msg.sender]);
    FHE.allow(balances[msg.sender], msg.sender);
}
```

---

## §9 — No replay protection on finalize

**Problem.** A function consuming `(plaintext, decryptionProof)` has no guard against the same proof being submitted twice.

```solidity
function finalize(uint64 v, bytes memory proof) external {
    bytes32[] memory hs = new bytes32[](1);
    hs[0] = FHE.toBytes32(handle);
    FHE.checkSignatures(hs, abi.encode(v), proof);
    _payout(v);   // can be triggered repeatedly
}
```

**Why it breaks.** `checkSignatures` verifies cryptographic validity, not single-use. The proof is deterministic and observable on-chain. Anyone can replay it. If `_payout` has side effects, those side effects fire every replay.

**Fix.** Either a used-proof mapping or a state-machine guard.

```solidity
mapping(bytes32 => bool) private _usedProofs;

function finalize(uint64 v, bytes memory proof) external {
    bytes32 ph = keccak256(proof);
    require(!_usedProofs[ph], "replay");
    _usedProofs[ph] = true;
    // ...verification + payout
}
```

State-machine alternative:
```solidity
enum Phase { OPEN, REVEALED, FINALIZED }
Phase public phase;

function finalize(...) external {
    require(phase == Phase.REVEALED, "wrong phase");
    phase = Phase.FINALIZED;   // one-shot transition
    // ...
}
```

---

## §10 — No overflow guard

**Problem.**
```solidity
totalSupply = FHE.add(totalSupply, mintedAmount);   // wraps on overflow
```

**Why it breaks.** FHE arithmetic is unchecked — it cannot revert on overflow because that would leak which inputs caused the overflow. Wraps to a small value silently.

**Fix.** Detect overflow and discard the operation via `FHE.select`.
```solidity
euint64 newSupply = FHE.add(totalSupply, mintedAmount);
ebool overflow = FHE.lt(newSupply, totalSupply);
totalSupply = FHE.select(overflow, totalSupply, newSupply);

// AND apply the same gate to any side-effects
euint64 newBal = FHE.add(balances[msg.sender], mintedAmount);
balances[msg.sender] = FHE.select(overflow, balances[msg.sender], newBal);
FHE.allowThis(balances[msg.sender]);
FHE.allow(balances[msg.sender], msg.sender);
```

The whole atomic operation must use the same `overflow` flag — otherwise totals diverge from balances.

---

## §11 — Wrapping scalar unnecessarily

**Problem.**
```solidity
x = FHE.add(x, FHE.asEuint64(42));
```

**Why it breaks.** Doesn't break — just wastes 50–100k gas. Encrypted-encrypted ops are 2–3× more expensive than encrypted-scalar.

**Fix.**
```solidity
x = FHE.add(x, 42);
```

---

## §12 — Oversized encrypted type

**Problem.**
```solidity
euint256 age = FHE.asEuint256(25);
```

**Why it breaks.** Doesn't break — wastes gas on every operation. Larger types have proportionally higher FHE costs.

**Fix.** Use the smallest type that fits.
```solidity
euint8 age = FHE.asEuint8(25);
```

---

## §13 — Cross-contract handle without `allowTransient`

**Problem.**
```solidity
// Contract A
function delegate(euint64 salary) external {
    processor.process(salary);   // B can't actually use this handle
}
```

**Why it breaks.** B has no ACL permission on `salary`. Any FHE op B tries to perform on it reverts with `"FHE: not allowed"`.

**Fix.** Grant transient permission immediately before the call.
```solidity
function delegate(euint64 salary) external {
    FHE.allowTransient(salary, address(processor));
    processor.process(salary);
}
```

If B needs the handle across multiple txs (e.g., stores it), use permanent `allow(handle, address(B))` at handle creation time instead.

---

## §14 — Granting ACL to a non-FHE contract

**Problem.** Calling `FHE.allow(handle, address(externalContract))` where `externalContract` doesn't inherit `ZamaEthereumConfig`.

**Why it breaks.** ACL grants the address permission, but if the receiving contract isn't FHEVM-aware, it cannot meaningfully use the handle. Calls to FHE operations from that contract fail because the executor wiring is missing.

**Fix.** Ensure every contract that touches encrypted handles inherits `ZamaEthereumConfig` (or `ZamaFoundryConfig` in Foundry tests).

---

## §15 — Emitting derived plaintext

**Problem.**
```solidity
event SalaryUpdated(address indexed e, uint64 salary);   // plaintext leak
emit SalaryUpdated(e, decryptedSalary);
```

Or subtler:
```solidity
event TierChanged(address indexed e, uint8 tier);   // tier derived from salary band
```

**Why it breaks.** The whole point of FHE is that no party — including indexers, validators, and observers — sees plaintext. Anything in event logs is broadcast publicly. Even "metadata" derived from encrypted state leaks information.

**Fix.** Emit the handle, not the value.
```solidity
event SalaryUpdated(address indexed e, bytes32 handle);
emit SalaryUpdated(e, FHE.toBytes32(salaries[e]));
```

The handle is meaningless without ACL permission. An authorized frontend uses the handle from logs to call `userDecrypt`, avoiding a separate state read.

---

## §16 — Frontend "fake success" before mining

**Problem.**
```typescript
await contract.deposit(handle, proof);
toast("Deposit successful!");   // tx is in mempool, not mined
```

**Why it breaks.** Submitting a tx returns immediately when accepted by the mempool. The tx may revert on-chain (insufficient ACL, replay, validation). User closes the tab; revert is invisible; UI state diverges from chain.

**Fix.** Wait for confirmation; distinguish states.
```typescript
setStatus("submitting");
const tx = await contract.deposit(handle, proof);
setStatus("mining");
const receipt = await tx.wait();
if (receipt.status === 1) {
  setStatus("done");
} else {
  setStatus("error");
  setError("Transaction reverted on-chain");
}
```

---

## §17 — API key in client bundle

**Problem.** Mainnet relayer API key in `import.meta.env.VITE_ZAMA_KEY` or hardcoded in source.

**Why it breaks.** Anything `VITE_*` ships to the browser bundle. Anyone can extract it and burn through your relayer quota.

**Fix.** Server-side only. Either:
- Proxy `publicDecrypt` calls through your backend.
- Use a build-time injection that pulls from a secret store and rotates.
- Keep the API key in a server-only env var (`ZAMA_RELAYER_API_KEY` without `VITE_` prefix).

Verify after build:
```bash
grep -r "your_api_key_string" dist/   # should return nothing
```

---

## §18 — Hardcoded ACL / KMS addresses

**Problem.**
```typescript
const instance = await createInstance({
  aclContractAddress: "0x687820221192C5B662b25367F70076A37bc79b6c",   // hardcoded
  // ...
});
```

**Why it breaks.** Addresses differ between Sepolia and mainnet. They may also change between SDK versions. Hardcoding leads to silent misconfiguration when switching networks or upgrading the SDK.

**Fix.** Use the SDK-provided config object.
```typescript
import { createInstance, SepoliaConfig, MainnetConfig } from "@zama-fhe/relayer-sdk";
const config = chainId === 1 ? MainnetConfig : SepoliaConfig;
const instance = await createInstance(config);
```

---

## §19 — Not invalidating cache on `accountsChanged`

**Problem.** Frontend caches decrypted balance for user A. User switches to wallet B in MetaMask. Frontend keeps showing A's balance.

**Why it breaks.** Decrypted values are user-specific. Showing the previous user's data is a privacy violation, not just a UX bug.

**Fix.**
```typescript
window.ethereum.on("accountsChanged", () => {
  decryptionCache.clear();
  setSession(null);   // force re-sign EIP-712
  setInstance(null);  // force re-init
});
```

Same for `chainChanged`.

---

## §20 — Retrying on deterministic relayer errors

**Problem.** Generic retry-on-error wrapper retries `"FHE: invalid proof"` failures.

**Why it breaks.** Invalid proof is deterministic. The proof was generated for the wrong contract or wrong user. Retrying with the same input always fails. Wastes user time and burns API quota.

**Fix.** Distinguish transient vs deterministic errors. Retry only transient ones.
```typescript
function isTransient(err: any): boolean {
  return (
    err.code === "NETWORK_ERROR" ||
    err.message?.includes("timeout") ||
    (err.status >= 500 && err.status < 600)
  );
}
```

4xx, "invalid proof", "not allowed" → surface to user immediately.

---

## §21 — Upgradeable impl without `_disableInitializers`

**Problem.**
```solidity
contract Impl is ZamaEthereumConfig, UUPSUpgradeable {
    function initialize(...) public initializer {
        // FHE.allowThis calls...
    }
    // No constructor disabling initializers
}
```

**Why it breaks.** Anyone can call `initialize()` directly on the impl contract (not via proxy). When that happens, `address(this)` is the impl address, not the proxy. ACL permissions get bound to the impl. Future calls via the proxy fail with `"FHE: not allowed"` because the proxy address has no ACL permission.

**Fix.**
```solidity
contract Impl is ZamaEthereumConfig, UUPSUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(...) public initializer {
        // ...
    }
}
```

---

## §22 — Boolean mapping for double-claim when handle check suffices

**Problem.** Adding a separate `claimed` mapping to prevent double-claims when the encrypted handle already encodes that information.

```solidity
mapping(bytes32 => mapping(address => bool)) public claimed;

function claimShare(bytes32 assetId) external {
    require(!claimed[assetId][msg.sender], "already claimed");
    claimed[assetId][msg.sender] = true;
    // ...
}
```

**Why it's wasteful.** The encrypted claim handle is zero before the first claim and non-zero after. `FHE.isInitialized` reads this directly. The boolean mapping duplicates state, costs an extra SSTORE (~20k gas), and introduces a surface for the two sources of truth to diverge.

**Fix.**
```solidity
function claimShare(bytes32 assetId) external {
    require(!FHE.isInitialized(encClaimed[assetId][msg.sender]), "already claimed");
    // ...compute and store encClaimed[assetId][msg.sender]...
    FHE.allowThis(encClaimed[assetId][msg.sender]);
    FHE.allow(encClaimed[assetId][msg.sender], msg.sender);
}
```

`FHE.isInitialized` returns `false` on a zero handle and `true` once the handle is set. One mapping, no extra state.

---

## §23 — N-party sum validation without state-machine replay guard

**Problem.** Implementing a public-decrypt + finalize flow for N-party sum validation using only a proof-hash mapping for replay protection, without a state machine.

```solidity
mapping(bytes32 => bool) private _usedProofs;

function confirmValidation(bytes32 assetId, uint16 sum, bytes memory proof) external {
    bytes32 ph = keccak256(proof);
    require(!_usedProofs[ph], "replay");
    _usedProofs[ph] = true;
    require(sum == 10000, "invalid sum");
    // activate asset...
}
```

**Why it's fragile.** Proof-hash replay protection is correct for single-use, but it doesn't prevent `markSumDecryptable` from being called again on an already-ACTIVE asset, generating a new proof with a different hash, and re-entering `confirmValidation`. If the asset state is not gated, this is a valid re-entry path.

**Fix.** Use the asset state machine as the primary replay guard. The proof-hash mapping becomes optional defense-in-depth.

```solidity
function markSumDecryptable(bytes32 assetId) external {
    require(assetState[assetId] == AssetState.PENDING, "not pending");
    FHE.makePubliclyDecryptable(encSum[assetId]);
}

function confirmValidation(bytes32 assetId, uint16 sum, bytes memory proof) external {
    require(assetState[assetId] == AssetState.PENDING, "not pending"); // state gate
    FHE.checkSignatures(handles, abi.encode(sum), proof);
    require(sum == 10000, "invalid sum");
    assetState[assetId] = AssetState.ACTIVE; // one-way transition
}
```

Once ACTIVE, `markSumDecryptable` reverts on the state check. No second proof is ever generated. The state machine is the replay guard.

**N-party sum validation — correct full flow:**
```
1. registerAsset()         → state: PENDING, encrypted splits stored
2. markSumDecryptable()    → state: still PENDING, FHE.makePubliclyDecryptable called
3. publicDecrypt([handle]) → off-chain, KMS returns sum plaintext + proof (3–15s on Sepolia)
4. confirmValidation()     → FHE.checkSignatures, require sum==10000, state: ACTIVE
```

KMS response time on Sepolia: 3–15 seconds empirically. Show a live elapsed counter — users interpret silence as failure.

---

## REVERT TABLE — what does this error mean?

| Symptom | Likely cause | Section |
|---|---|---|
| `"FHE: not allowed"` / `isSenderAllowed=false` | ACL permission missing | §1, §13 |
| Empty / low-level revert, no message | Often missing ACL on coprocessor; check `ZamaEthereumConfig` is inherited | §1, §14 |
| `"FHE: handle not initialized"` | Operating on a zero handle | `CORE_RULES.md` §1.2 |
| `"FHE: invalid proof"` (`fromExternal`) | Frontend encrypted with wrong contract or user address | `FRONTEND.md` §4 |
| `checkSignatures` revert with no message | Handle order mismatch, or tampered plaintext in `abiEncoded` | §7 |
| `"FHE: not publicly decryptable"` | `makePubliclyDecryptable` not called, or called on wrong handle | §6 |
| Constructor FHE op silently fails on Sepolia | Coprocessor unavailable during construction | §5 |
| `TypeError: FHE.add is not a function` (Foundry) | Using `ZamaEthereumConfig` instead of `ZamaFoundryConfig` | `CORE_RULES.md` §8 |
| Compile error or silent no-op on `FHE.add(eu256, eu256)` | euint256 has no arithmetic | §4 |

---

## DO THIS NEXT — common fixes

| Triggering observation | Action |
|---|---|
| Function works once, then reverts on every retry | Add `FHE.allowThis` after every state assignment. |
| Tests pass on mock, contract reverts on Sepolia | Move `FHE.*` out of the constructor into `initialize()`. |
| Some users see wrong balances in the UI | Audit cache invalidation on `accountsChanged`. |
| `publicDecrypt` returns but `checkSignatures` reverts | Verify handle order matches between off-chain and on-chain. |
| Mainnet decrypt hangs >2 min | Show progress UI; check `ZAMA_RELAYER_API_KEY`. |
| `npm install` fails with peer-deps error | Add `--legacy-peer-deps`; pin Hardhat 2.x. See `CHANGELOG.md`. |
| Etherscan verify shows bytecode mismatch | Use Standard JSON Input from the original (non-`--force`) compile. |
| `createEncryptedInput is undefined` in vanilla JS | Call `initSDK()` before `createInstance`. See `FRONTEND.md` §2.5. |
| `userDecrypt` throws type error with ethers v6 | Strip `EIP712Domain` from `eip712.types` before `signTypedData`. See `FRONTEND.md` §5.1. |
| Claim function reverts on second call despite correct logic | Replace boolean `claimed` mapping with `FHE.isInitialized` check. See §22. |
| `confirmValidation` can be called again after ACTIVE | Gate both `markSumDecryptable` and `confirmValidation` on `PENDING` state. See §23. |
