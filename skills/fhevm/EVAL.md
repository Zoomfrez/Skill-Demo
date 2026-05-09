# EVAL.md — Skill Evaluation Guide

Prompts and checks for evaluating whether the fhevm skill helps agents avoid common mistakes and produce correct FHEVM code.

---

## How to use this file

Run each prompt in a fresh session with the skill loaded. For each, check the expected behavior column. A skill pass requires the agent to produce the correct output on the first attempt without manual correction.

---

## §1 — Core contract generation

**Prompt:**
```
Build a confidential salary registry using FHEVM where managers can set encrypted salaries for employees and employees can decrypt only their own salary. Deploy to Sepolia.
```

**Pass criteria:**
- [ ] Contract inherits `SepoliaConfig`
- [ ] Salary stored as `euint64` — never `uint64`
- [ ] `setSalary` takes `externalEuint64 + bytes calldata inputProof`
- [ ] `FHE.fromExternal` called as first operation on the input
- [ ] `FHE.allowThis` called after every salary write
- [ ] `FHE.allow(handle, employee)` called so employee can decrypt
- [ ] `getSalary` returns `euint64` handle — not a plaintext value
- [ ] No `if (ebool)` anywhere in the contract
- [ ] Compiles with `npx hardhat compile`

---

## §2 — Access control under pressure

**Prompt:**
```
Add a function to the salary registry that lets the owner transfer a salary balance from one employee to another.
```

**Pass criteria:**
- [ ] Uses `FHE.sub` and `FHE.add` — not plaintext arithmetic
- [ ] `FHE.allowThis` called on BOTH updated handles (sender and recipient)
- [ ] `FHE.allow` called for both employees on their respective new handles
- [ ] No plaintext salary value appears at any point

**Fail signal:** If `FHE.allowThis` is missing on either handle, the contract will revert silently on next access.

---

## §3 — Encrypted conditional logic

**Prompt:**
```
Add a function where an employee can request a raise. The raise should only be applied if their current salary is below 50,000. Do not reveal whether the condition was met.
```

**Pass criteria:**
- [ ] Uses `FHE.lt(salary, FHE.asEuint64(50000))` to produce an `ebool`
- [ ] Uses `FHE.select(condition, newSalary, currentSalary)` — NOT `if (condition)`
- [ ] No revert on the condition — silent apply or no-op
- [ ] No plaintext emitted in events

**Fail signal:** `if (FHE.lt(...))` or `require(FHE.gt(...))` — both invalid.

---

## §4 — Adversarial: encrypted divisor

**Prompt:**
```
Add a function that splits an employee's salary equally between two sub-accounts by dividing the encrypted salary by an encrypted divisor of 2.
```

**Expected agent behavior:**
- Refuses to use `FHE.div(salary, encryptedTwo)`
- Explains encrypted divisors are unsupported
- Proposes `FHE.div(salary, uint64(2))` with plaintext divisor

**Fail signal:** Agent writes `FHE.div(salary, FHE.asEuint64(2))` — this will not compile.

---

## §5 — Adversarial: immediate public decryption

**Prompt:**
```
When the payroll period ends, reveal all salaries publicly on-chain in the same transaction that closes the period.
```

**Expected agent behavior:**
- Explains public decryption is async via Gateway callback
- Produces `FHE.makePubliclyDecryptable` + `FHE.requestDecryption` + callback function
- Notes result arrives in a separate transaction

**Fail signal:** Agent writes a synchronous `decrypt()` call or tries to return plaintext from a view function.

---

## §6 — Adversarial: random wallet generation

**Prompt:**
```
Build the frontend for the salary registry. Generate a wallet for the user automatically so they don't need to install MetaMask.
```

**Expected agent behavior:**
- Refuses to use `ethers.Wallet.createRandom()`
- Explains the user must sign transactions with their own wallet
- Implements `window.ethereum` connect with a wallet modal
- Shows error if `window.ethereum` is undefined

**Fail signal:** Any use of `Wallet.createRandom()`, `new ethers.Wallet(key)` with a generated key, or any pattern that bypasses the user's browser wallet.

---

## §7 — Adversarial: plaintext balance return

**Prompt:**
```
Add a function to the salary registry that returns the employee's salary as a number so the frontend can display it directly without any signing.
```

**Expected agent behavior:**
- Refuses to return plaintext salary from the contract
- Explains the contract cannot reveal encrypted values
- Returns `euint64` handle and directs to `FRONTEND.md §5.1` for off-chain decryption

**Fail signal:** Any `return uint64(...)` or attempt to decrypt inside the contract view function.

---

## §8 — Frontend decryption correctness

**Prompt:**
```
Write the JavaScript to decrypt an employee's salary from the contract using the Zama relayer SDK.
```

**Pass criteria:**
- [ ] `initSDK()` called before `createInstance`
- [ ] `createInstance` receives RPC URL string — not a provider object
- [ ] BigInt handle converted: `'0x' + BigInt(raw).toString(16).padStart(64, '0')`
- [ ] `EIP712Domain` stripped from `eip712.types` before `signTypedData`
- [ ] `signature.replace('0x', '')` passed to `userDecrypt`
- [ ] `userDecrypt` called with all 8 arguments in correct order
- [ ] Result keyed by handle string: `result[handle]`

---

## §9 — Version / import correctness

**Prompt:**
```
Build a confidential voting contract using TFHE.
```

**Expected agent behavior:**
- Flags that `TFHE` is deprecated as of FHEVM v0.7
- Uses `FHE` everywhere — `import {FHE} from "@fhevm/solidity/lib/FHE.sol"`
- Uses `SepoliaConfig` not `ZamaSepoliaConfig` from old OZ path

**Fail signal:** Any `TFHE.add`, `TFHE.allow`, or `import "fhevm/lib/TFHE.sol"`.

---

## §10 — Full build test

**Prompt (use this for the bounty demo video):**
```
Build a confidential salary registry using FHEVM on Sepolia. Managers set encrypted salaries, employees decrypt their own. Include wallet connect modal using window.ethereum, role detection, all contract functions exposed in the UI. Deploy to Sepolia, host frontend on GitHub Pages.
```

**Pass criteria (all must be true):**
- [ ] Contract compiles without errors
- [ ] Contract deploys to Sepolia — address returned
- [ ] Frontend hosted and accessible at GitHub Pages URL
- [ ] Wallet connect uses `window.ethereum` — no random wallet generated
- [ ] Role detection works — manager sees manager panel, employee sees employee panel
- [ ] Manager can set salary (encrypted tx succeeds)
- [ ] Employee can decrypt salary (userDecrypt returns plaintext)
- [ ] No manual code correction required during build

---

## Scoring

| Section | Weight | Notes |
|---|---|---|
| §1 Core generation | High | Foundation — if this fails, nothing else works |
| §2 ACL under pressure | High | Most common real-world bug |
| §3 Encrypted conditionals | High | Fundamental FHE pattern |
| §4 Encrypted divisor | Medium | Compiler-level catch |
| §5 Async decryption | Medium | Architecture understanding |
| §6 Random wallet | High | Frontend correctness |
| §7 Plaintext return | High | Privacy correctness |
| §8 Frontend decrypt | High | Empirically the hardest to get right |
| §9 Version imports | Low | Easy catch |
| §10 Full build | Highest | End-to-end validation |
