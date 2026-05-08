# CORE_RULES.md

Evergreen rules for FHEVM Solidity development. Format: **MUST / SHOULD / NEVER / COMMON FAILURE MODE**.

Read this file end-to-end before writing or auditing a contract. The ACL section alone prevents most bugs.

---

## §0 — Scope discipline (MUST)

- **MUST** define the encrypted state set before writing code: variables, types, who reads, who writes.
- **MUST** keep the encrypted surface minimal. 1–3 `euint64` variables and one decryption flow is sufficient for a complete module.
- **NEVER** encrypt a value that is already public elsewhere on-chain. FHE is only justified when validators, indexers, and other users must not see plaintext.
- **NEVER** add encryption to satisfy a "privacy" requirement that view-function access control already solves.

**FHE is appropriate when:**
- The value must stay hidden from all on-chain parties.
- Computation must run on the value without revealing it.
- Reveal is conditional (auction close, vote deadline, threshold).

---

## §1 — Encrypted types

| Type | Bits | Arithmetic | Notes |
|---|---|---|---|
| `ebool` | 2 | — | and/or/xor/eq/ne/not/select/rand |
| `euint8` | 8 | full | |
| `euint16` | 16 | full | |
| `euint32` | 32 | full | |
| `euint64` | 64 | full | **Default for token amounts.** |
| `euint128` | 128 | full | |
| `euint256` | 256 | **none** | Bitwise + eq/ne only. See §1.2. |
| `eaddress` | 160 | — | eq/ne/select |

### §1.1 — Sizing rules

- **MUST** use the smallest type that fits. `euint8` for ages, tiers, role IDs. `euint64` for token amounts.
- **NEVER** use `euint256` for counters, balances, or anything mathematical.
- **COMMON FAILURE MODE:** declaring `euint256 balance` because it "matches" `uint256`. `FHE.add` on `euint256` is a compile error or silent no-op depending on SDK version. Use `euint64` or `euint128`.

### §1.2 — Initialization check

**MUST** check before reading mappings or any state that may not have been written:

```solidity
require(FHE.isInitialized(balances[user]), "Balance not initialized");
```

Operating on a zero handle reverts with `"FHE: handle not initialized"` or an empty revert.

### §1.3 — Type casting

```solidity
euint32 up = FHE.asEuint32(someEuint8);    // safe upcast
euint8  dn = FHE.asEuint8(someEuint32);    // wraps silently — no revert
euint64 px = FHE.asEuint64(100);           // plaintext → encrypted
```

**Arithmetic is unchecked.** Overflow wraps silently. Confidentiality requires this — there cannot be a revert because that would leak which inputs caused overflow. **MUST** handle overflow explicitly via `FHE.select` (see §3.2).

---

## §2 — Encrypted inputs (`fromExternal`)

User-submitted ciphertexts arrive as `externalEuintXX` paired with a ZK proof of knowledge.

```solidity
function deposit(
    externalEuint64 encAmount,
    bytes calldata inputProof
) external {
    euint64 amount = FHE.fromExternal(encAmount, inputProof); // validates ZKPoK
    // ...now safe to use `amount`
}
```

### Rules

- **MUST** call `FHE.fromExternal` before any operation. `externalEuintXX` is not `euintXX`.
- **MUST** group multiple encrypted inputs that belong to the same logical operation into one function call — they share a single `inputProof`.
- **SHOULD** prefer plaintext scalars over encrypted scalars when the value is known (`FHE.add(x, 42)` is far cheaper than `FHE.add(x, FHE.asEuint64(42))`).
- **COMMON FAILURE MODE:** `"FHE: invalid proof"` — the frontend encrypted with the wrong `contractAddress` or `userAddress`. Proof binding is exact.

### Handle ordering

Handle order in `encrypted.handles[]` matches the order `add*` was called on the input builder, **not** the order of Solidity function parameters. Always confirm both orders match.

---

## §3 — Operations

### §3.1 — Cost-aware op selection

| Op | Approx. gas (euint64, Sepolia, FHEVM v0.9) |
|---|---|
| `FHE.fromExternal` | 200k–400k |
| `FHE.add/sub` (enc-enc) | 80k–150k |
| `FHE.add/sub` (enc-scalar) | 50k–100k |
| `FHE.mul` (enc-enc) | 400k–700k |
| `FHE.mul` (enc-scalar) | 200k–400k |
| `FHE.div`/`rem` (scalar RHS only) | 700k–1.2M |
| `FHE.eq/lt/gt` etc. | 100k–200k |
| `FHE.select` | 100k–200k |
| `FHE.allowThis`/`allow` | 30k–60k |
| `FHE.makePubliclyDecryptable` | 40k–70k |

**Architectural implications:**
- `setSalary`-style functions (one `fromExternal` + select + two allows) cost ~600k–900k gas.
- **NEVER** use `FHE.div` in a hot path. Pre-compute or restructure.
- Each extra encrypted operand = another `fromExternal`. Batch.

### §3.2 — `FHE.select` is the only branching primitive

```solidity
// NEVER
if (FHE.gt(a, b)) { ... }     // ebool is a handle, not a bool

// MUST
euint64 r = FHE.select(FHE.gt(a, b), a, b);
```

Both branches of a select are evaluated and stored — there is no short-circuit. `FHE.select` is also how you implement overflow guards, conditional updates, and any gating logic on encrypted state.

**Overflow guard pattern:**
```solidity
euint64 newBal = FHE.add(balances[u], amt);
ebool   bad    = FHE.lt(newBal, balances[u]);
balances[u]    = FHE.select(bad, balances[u], newBal); // revert by no-op
```

### §3.3 — `div` / `rem` constraints

- **MUST** use a plaintext scalar RHS. Encrypted divisor reverts.
- `FHE.shr(x, n)` reduces `n` modulo bit width. `FHE.shr(euint64 x, 70)` ≡ `FHE.shr(x, 6)`.

---

## §4 — ACL (the most error-prone surface)

A ciphertext handle is unusable — even by its creator — until ACL permission is granted. **ACL is separate from role checks.** Role checks (`onlyRole`) gate function calls. ACL gates handle access.

### §4.1 — Required pattern after every state update

```solidity
balances[u] = FHE.add(balances[u], amount);
FHE.allowThis(balances[u]);     // contract reuses next tx
FHE.allow(balances[u], u);      // user can decrypt their own
```

- **MUST** call `FHE.allowThis` after every assignment to a stored handle. Without it, the contract cannot operate on that handle in any future transaction.
- **MUST** call `FHE.allow(handle, addr)` for every address that needs to user-decrypt.
- **COMMON FAILURE MODE:** silent breakage on the next transaction — first tx works, follow-up reverts with `"FHE: not allowed"`.

### §4.2 — `allow` vs `allowThis` vs `allowTransient`

| Function | Lifetime | Use when |
|---|---|---|
| `allowThis(h)` | permanent for `address(this)` | Storing the handle in contract state. |
| `allow(h, addr)` | permanent for `addr` | `addr` (user or contract) reads across multiple txs. |
| `allowTransient(h, addr)` | current tx only | Passing handle to another contract within one tx. Cheaper. |
| `makePubliclyDecryptable(h)` | permanent, global | One-time per public-reveal flow. |

### §4.3 — Cross-contract permissions

Handle has no built-in permission. Caller must grant before the call.

```solidity
// Contract A — caller
function delegate(euint64 salary) external {
    FHE.allowTransient(salary, address(processor)); // grant before call
    processor.process(salary);
}
```

```solidity
// Contract B — callee
contract Processor is ZamaEthereumConfig {
    function process(euint64 salary) external {
        euint64 tax = FHE.div(salary, 3);
        stored[msg.sender] = tax;
        FHE.allowThis(stored[msg.sender]);          // new handle = new ACL
        FHE.allow(stored[msg.sender], msg.sender);
    }
}
```

- **MUST** call `allowTransient` immediately before the external call when passing a handle one-shot.
- **MUST** call `allowThis` separately on any *new* handle created in B; transient permission on inputs does not propagate to outputs.
- **SHOULD** use permanent `allow(h, address(B))` if B needs the handle across multiple transactions (e.g., an oracle reference rate).
- **COMMON FAILURE MODE:** granting permission to a non-FHE contract. Any contract receiving handles must inherit `ZamaEthereumConfig` (or `ZamaFoundryConfig` in tests).

### §4.4 — Role-based access

```solidity
enum Role { None, Employee, Manager, Admin }
mapping(address => Role) public roles;

modifier onlyRole(Role r) { require(roles[msg.sender] >= r, "role"); _; }

function setSalary(address e, externalEuint64 enc, bytes calldata p)
    external onlyRole(Role.Manager)
{
    salaries[e] = FHE.fromExternal(enc, p);
    FHE.allowThis(salaries[e]);
    FHE.allow(salaries[e], e);            // employee reads own
    FHE.allow(salaries[e], msg.sender);   // setter retains read
}
```

**Pattern:** plaintext role mapping for who can call; ACL for who can read the resulting ciphertext. Both are required.

### §4.5 — Events with encrypted data

```solidity
event SalaryUpdated(address indexed e, bytes32 handle);
emit SalaryUpdated(e, FHE.toBytes32(salaries[e])); // handle only, never plaintext
```

- **NEVER** emit plaintext or anything derived from encrypted state — even "safe" metadata like a tier.
- **SHOULD** emit the handle as `bytes32` for indexer-friendly lookup. The handle is useless without ACL permission.
- Alternative: skip events, use polling. Simpler, loses audit trail.

---

## §5 — Decryption architecture

Decryption is **always async, off-chain**. There is no `FHE.decrypt()` returning plaintext in the same tx.

### §5.1 — Three patterns

| Pattern | Use when |
|---|---|
| User decryption | One specific user reads their own data (balance, salary). |
| Public decryption | Reveal to everyone after a condition (auction close, vote tally). |
| No decryption | Encrypted forever (commitments, hidden state in pure FHE flows). |

### §5.2 — Public decryption flow (3 steps)

```solidity
// 1. On-chain: mark
function reveal() external { FHE.makePubliclyDecryptable(result); }
```

```typescript
// 2. Off-chain: decrypt via relayer
const r = await instance.publicDecrypt([handle1, handle2]);
const proof = r.decryptionProof;
```

```solidity
// 3. On-chain: verify + finalize
function finalize(uint64 v1, uint64 v2, bytes memory proof) external {
    bytes32 ph = keccak256(proof);
    require(!_used[ph], "replay");          // MUST: replay guard
    _used[ph] = true;

    bytes32[] memory hs = new bytes32[](2);
    hs[0] = FHE.toBytes32(handle1);          // MUST: same order as publicDecrypt
    hs[1] = FHE.toBytes32(handle2);
    FHE.checkSignatures(hs, abi.encode(v1, v2), proof);

    _finalize(v1, v2);
}
```

### §5.3 — Decryption rules

- **MUST** match handle order between `publicDecrypt([...])` and `checkSignatures(handles, ...)`. Mismatch reverts with no message.
- **MUST** add replay protection — `checkSignatures` only verifies cryptographic validity, not single-use. Use `keccak256(proof) → bool` mapping or a state-machine guard (e.g., `PENDING → REVEALED` transition).
- **MUST** match abi-encoded plaintext order to the handle order.
- **NEVER** rely on inline decryption — `FHE.decrypt` does not exist.
- **SHOULD** decrypt only when plaintext is genuinely needed (final reveal, finalization). Use `FHE.select` for intermediate logic.

### §5.4 — User decryption (private to one address)

Requires the contract to have called `FHE.allow(handle, user)` first.

> **See `FRONTEND.md` §5.1 for the complete correct off-chain flow** — including the full `createEIP712` and `userDecrypt` signatures, ethers v6 `EIP712Domain` strip, and BigInt handle conversion. The snippet below is illustrative only.

```typescript
// Simplified — use FRONTEND.md §5.1 for production
const { publicKey, privateKey } = instance.generateKeypair();
const startTimestamp = Math.floor(Date.now() / 1000);
const eip712 = instance.createEIP712(publicKey, [contractAddress], startTimestamp, 1);
const { EIP712Domain: _, ...types } = eip712.types; // ethers v6: strip EIP712Domain
const sig = await signer.signTypedData(eip712.domain, types, eip712.message);
// Convert BigInt handle from contract to hex string
const handle = '0x' + BigInt(rawHandle).toString(16).padStart(64, '0');
const result = await instance.userDecrypt(
  [{ handle, contractAddress }],
  privateKey, publicKey, sig,
  [contractAddress], userAddress, startTimestamp, 1
);
const plaintext = result[handle]; // BigInt
```

---

## §6 — Constructor and initialization

- **NEVER** call `FHE.*` operations in a constructor. The coprocessor is unavailable during construction on live networks.
- **MUST** initialize encrypted state in a post-deploy `initialize()` function that takes `externalEuintXX` inputs.
- **COMMON FAILURE MODE:** silent failure on Sepolia, works on mock — because the mock skips coprocessor checks during construction.

```solidity
function initialize(externalEuint64 encSupply, bytes calldata p) external {
    require(!_initialized, "init");
    _initialized = true;
    encryptedSupply = FHE.fromExternal(encSupply, p);
    FHE.allowThis(encryptedSupply);
}
```

---

## §7 — Upgradeability

- **SHOULD** prefer immutable contracts. Most projects do not need proxies.
- **MUST**, if using UUPS/Transparent proxy, call `_disableInitializers()` in the implementation constructor. Otherwise direct calls to `initialize()` on the impl bind ACL to the impl address, not the proxy.

```solidity
contract Impl is ZamaEthereumConfig, UUPSUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }
    function initialize(...) public initializer { ... }
}
```

- **NEVER** use `selfdestruct` in upgrade migrations. Even with EIP-6780, ACL permissions bound to the destroyed address are orphaned.

---

## §8 — Required base contract

```solidity
import "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract MyContract is ZamaEthereumConfig { ... }
```

`ZamaEthereumConfig` wires the ACL contract, FHEVMExecutor, KMSVerifier, InputVerifier, and decryption oracle. **NEVER** configure these manually. For Foundry tests, inherit `ZamaFoundryConfig` instead.

---

## §9 — Invariants checklist

A correct contract satisfies all of these. Run as an audit pass:

- [ ] Inherits `ZamaEthereumConfig`.
- [ ] No `FHE.*` in any constructor.
- [ ] Every `externalEuintXX` parameter is consumed by `FHE.fromExternal` before use.
- [ ] Every assignment to a stored encrypted variable is followed by `FHE.allowThis`.
- [ ] Every user-readable encrypted variable has `FHE.allow(handle, user)`.
- [ ] No `if (encryptedBool)` — all conditional logic via `FHE.select`.
- [ ] No `FHE.div`/`FHE.rem` with encrypted RHS.
- [ ] Overflow guarded explicitly via `FHE.select` on every `add`/`mint`.
- [ ] No arithmetic on `euint256`.
- [ ] Cross-contract handle passing uses `allowTransient` immediately before the call.
- [ ] Public decryption: handle order matches between `publicDecrypt` and `checkSignatures`.
- [ ] `checkSignatures`-consuming functions have replay protection (mapping or state-machine).
- [ ] Upgradeable impls call `_disableInitializers()` in the constructor.
- [ ] No plaintext or derived values in events.

If any item fails, fix before considering the contract complete.
