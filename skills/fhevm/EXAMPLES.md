# EXAMPLES.md

Minimal, production-grade reference snippets. Each is a starting point — adapt to scope. Every example follows the rules in `CORE_RULES.md`.

---

## INDEX

- §1 — Confidential ERC-20 (transfer + mint)
- §2 — Confidential payroll (role-based)
- §3 — Private voting (with public reveal)
- §4 — Sealed auction
- §5 — Confidential ERC-7984 payout engine
- §6 — Frontend: encrypted input submission
- §7 — Frontend: user decryption flow
- §8 — Frontend: full reveal-and-finalize flow

---

## §1 — Confidential ERC-20

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ConfidentialToken is ZamaEthereumConfig {
    mapping(address => euint64) private balances;

    function mint(externalEuint64 enc, bytes calldata p) external {
        euint64 amount = FHE.fromExternal(enc, p);

        euint64 newBal = FHE.add(balances[msg.sender], amount);
        ebool overflow = FHE.lt(newBal, balances[msg.sender]);
        balances[msg.sender] = FHE.select(overflow, balances[msg.sender], newBal);

        FHE.allowThis(balances[msg.sender]);
        FHE.allow(balances[msg.sender], msg.sender);
    }

    function transfer(address to, externalEuint64 enc, bytes calldata p) external {
        euint64 amount = FHE.fromExternal(enc, p);

        ebool sufficient = FHE.ge(balances[msg.sender], amount);
        euint64 newSender = FHE.select(
            sufficient,
            FHE.sub(balances[msg.sender], amount),
            balances[msg.sender]
        );
        euint64 newRecipient = FHE.select(
            sufficient,
            FHE.add(balances[to], amount),
            balances[to]
        );

        balances[msg.sender] = newSender;
        balances[to] = newRecipient;

        FHE.allowThis(balances[msg.sender]);
        FHE.allow(balances[msg.sender], msg.sender);
        FHE.allowThis(balances[to]);
        FHE.allow(balances[to], to);
    }

    function getEncryptedBalance(address u) external view returns (euint64) {
        return balances[u];
    }
}
```

Key points:
- Overflow handled via `FHE.select` (mint).
- Insufficient-balance handled via `FHE.select` (transfer no-ops silently rather than reverting — by design, since reverting would leak balance info).
- ACL granted on every assignment.

---

## §2 — Confidential payroll

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ConfidentialPayroll is ZamaEthereumConfig {
    enum Role { None, Employee, Manager, Admin }
    mapping(address => Role) public roles;
    mapping(address => euint64) private salaries;

    event SalarySet(address indexed employee, bytes32 handle);

    constructor(address admin) {
        roles[admin] = Role.Admin;
    }

    modifier onlyRole(Role r) {
        require(roles[msg.sender] >= r, "role");
        _;
    }

    function setRole(address u, Role r) external onlyRole(Role.Admin) {
        roles[u] = r;
    }

    function setSalary(
        address employee,
        externalEuint64 enc,
        bytes calldata proof
    ) external onlyRole(Role.Manager) {
        salaries[employee] = FHE.fromExternal(enc, proof);

        FHE.allowThis(salaries[employee]);
        FHE.allow(salaries[employee], employee);     // employee reads own
        FHE.allow(salaries[employee], msg.sender);   // manager who set it

        emit SalarySet(employee, FHE.toBytes32(salaries[employee]));
    }

    function grantManagerAccess(address mgr, address e) external onlyRole(Role.Admin) {
        require(FHE.isInitialized(salaries[e]), "not set");
        FHE.allow(salaries[e], mgr);
    }

    function getEncryptedSalary(address e) external view returns (euint64) {
        return salaries[e];
    }
}
```

Note: role check (who can call) is separate from ACL grant (who can read the resulting handle). Both required.

---

## §3 — Private voting with public reveal

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract PrivateVote is ZamaEthereumConfig {
    enum Phase { OPEN, REVEALED, FINALIZED }

    address public admin;
    uint256 public deadline;
    Phase public phase;

    mapping(address => bool) public hasVoted;
    euint64 private yesCount;
    euint64 private noCount;

    event VoteCast(address indexed voter);
    event ResultsRevealed(uint64 yes, uint64 no);

    constructor(uint256 votingDuration) {
        admin = msg.sender;
        deadline = block.timestamp + votingDuration;
        phase = Phase.OPEN;
        // NOTE: yesCount/noCount initialized lazily on first vote
    }

    function vote(externalEbool encVote, bytes calldata proof) external {
        require(phase == Phase.OPEN, "closed");
        require(block.timestamp < deadline, "expired");
        require(!hasVoted[msg.sender], "double vote");
        hasVoted[msg.sender] = true;

        ebool v = FHE.fromExternal(encVote, proof);

        // Initialize counters on first vote
        if (!FHE.isInitialized(yesCount)) {
            yesCount = FHE.asEuint64(0);
            noCount = FHE.asEuint64(0);
        }

        // yes += v ? 1 : 0   ;   no += v ? 0 : 1
        euint64 yesIncrement = FHE.select(v, FHE.asEuint64(1), FHE.asEuint64(0));
        euint64 noIncrement = FHE.select(v, FHE.asEuint64(0), FHE.asEuint64(1));

        yesCount = FHE.add(yesCount, yesIncrement);
        noCount = FHE.add(noCount, noIncrement);

        FHE.allowThis(yesCount);
        FHE.allowThis(noCount);

        emit VoteCast(msg.sender);
    }

    function startReveal() external {
        require(msg.sender == admin, "admin");
        require(block.timestamp >= deadline, "too early");
        require(phase == Phase.OPEN, "wrong phase");

        FHE.makePubliclyDecryptable(yesCount);
        FHE.makePubliclyDecryptable(noCount);
        phase = Phase.REVEALED;
    }

    function finalize(uint64 yes, uint64 no, bytes memory decryptionProof) external {
        require(phase == Phase.REVEALED, "wrong phase");
        phase = Phase.FINALIZED;   // state-machine replay guard

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(yesCount);
        handles[1] = FHE.toBytes32(noCount);

        FHE.checkSignatures(handles, abi.encode(yes, no), decryptionProof);

        emit ResultsRevealed(yes, no);
    }
}
```

State-machine guard (`OPEN → REVEALED → FINALIZED`) provides replay protection without a separate `usedProofs` mapping.

---

## §4 — Sealed auction

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SealedAuction is ZamaEthereumConfig {
    enum Phase { OPEN, REVEALED, SETTLED }

    address public seller;
    uint256 public deadline;
    Phase public phase;

    mapping(address => euint64) private bids;
    address[] private bidders;
    mapping(address => bool) private hasBid;

    euint64 private highestBid;
    eaddress private highestBidder;

    constructor(uint256 duration) {
        seller = msg.sender;
        deadline = block.timestamp + duration;
        phase = Phase.OPEN;
    }

    function bid(externalEuint64 encBid, bytes calldata proof) external {
        require(phase == Phase.OPEN, "closed");
        require(block.timestamp < deadline, "expired");
        require(!hasBid[msg.sender], "one bid");

        hasBid[msg.sender] = true;
        bidders.push(msg.sender);

        bids[msg.sender] = FHE.fromExternal(encBid, proof);
        FHE.allowThis(bids[msg.sender]);
        FHE.allow(bids[msg.sender], msg.sender);   // bidder can verify own bid

        // Update running max
        if (!FHE.isInitialized(highestBid)) {
            highestBid = bids[msg.sender];
            highestBidder = FHE.asEaddress(msg.sender);
        } else {
            ebool isHigher = FHE.gt(bids[msg.sender], highestBid);
            highestBid = FHE.select(isHigher, bids[msg.sender], highestBid);
            highestBidder = FHE.select(isHigher, FHE.asEaddress(msg.sender), highestBidder);
        }
        FHE.allowThis(highestBid);
        FHE.allowThis(highestBidder);
    }

    function startReveal() external {
        require(msg.sender == seller, "seller");
        require(block.timestamp >= deadline, "early");
        require(phase == Phase.OPEN, "phase");

        FHE.makePubliclyDecryptable(highestBid);
        FHE.makePubliclyDecryptable(highestBidder);
        phase = Phase.REVEALED;
    }

    function settle(uint64 winningBid, address winner, bytes memory proof) external {
        require(phase == Phase.REVEALED, "phase");
        phase = Phase.SETTLED;

        bytes32[] memory hs = new bytes32[](2);
        hs[0] = FHE.toBytes32(highestBid);
        hs[1] = FHE.toBytes32(highestBidder);

        FHE.checkSignatures(hs, abi.encode(winningBid, winner), proof);

        // ...transfer logic uses (winner, winningBid)
    }
}
```

Note the running-max pattern: every bid updates `highestBid` and `highestBidder` via `FHE.select`. No bidder can see whether their bid is leading until the reveal.

---

## §5 — Confidential ERC-7984 payout engine

A simplified payout engine consuming ERC-7984 confidential tokens. Distributes encrypted amounts from a treasury to multiple recipients in a single transaction, with role-based authorization.

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

interface IERC7984 {
    function confidentialTransfer(
        address to,
        euint64 amount
    ) external returns (euint64);
}

contract PayoutEngine is ZamaEthereumConfig {
    enum Role { None, Operator, Admin }
    mapping(address => Role) public roles;

    IERC7984 public immutable token;

    event PayoutExecuted(address indexed recipient, bytes32 amountHandle);

    constructor(address token_, address admin) {
        token = IERC7984(token_);
        roles[admin] = Role.Admin;
    }

    modifier onlyRole(Role r) { require(roles[msg.sender] >= r, "role"); _; }

    function setRole(address u, Role r) external onlyRole(Role.Admin) { roles[u] = r; }

    /// @notice Execute payouts in a single tx. Each (recipient, encAmount) is processed.
    function batchPayout(
        address[] calldata recipients,
        externalEuint64[] calldata encAmounts,
        bytes calldata proof          // single proof covers all encAmounts
    ) external onlyRole(Role.Operator) {
        require(recipients.length == encAmounts.length, "len");

        for (uint256 i = 0; i < recipients.length; i++) {
            euint64 amount = FHE.fromExternal(encAmounts[i], proof);

            // Transient grant so the token contract can use the handle one-shot
            FHE.allowTransient(amount, address(token));

            euint64 transferred = token.confidentialTransfer(recipients[i], amount);

            // Token contract grants ACL on the returned handle to engine + recipient
            // (engine emits handle for off-chain reconciliation)
            emit PayoutExecuted(recipients[i], FHE.toBytes32(transferred));
        }
    }
}
```

Key cross-contract patterns:
- `allowTransient(amount, address(token))` immediately before the call.
- The token contract is responsible for granting ACL on the returned handle; the engine just emits.
- All amounts in one `inputProof` — saves one `fromExternal` cost per recipient on the verification side.

---

## §6 — Frontend: encrypted input submission

```typescript
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk";
import { BrowserProvider, Contract, parseUnits, ZeroHash } from "ethers";
import { CONTRACT_ADDRESS, ABI } from "./config";

let instance: Awaited<ReturnType<typeof createInstance>> | null = null;

async function getInstance() {
  if (!instance) instance = await createInstance(SepoliaConfig);
  return instance;
}

export async function deposit(amountStr: string): Promise<string> {
  // 1. Validate
  const validation = validateAmount(amountStr);
  if (!validation.valid) throw new Error(validation.error);

  // 2. Wallet
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const userAddress = await signer.getAddress();
  const contract = new Contract(CONTRACT_ADDRESS, ABI, signer);

  // 3. Encrypt
  const inst = await getInstance();
  const input = inst.createEncryptedInput(CONTRACT_ADDRESS, userAddress);
  input.add64(validation.value);
  const enc = await input.encrypt();

  // 4. Submit
  const tx = await contract.deposit(enc.handles[0], enc.inputProof);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("Transaction reverted");

  return receipt.hash;
}

function validateAmount(raw: string):
  | { valid: true; value: bigint }
  | { valid: false; error: string }
{
  if (!raw.trim()) return { valid: false, error: "Required" };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { valid: false, error: "Numbers only" };
  const value = parseUnits(raw, 6); // adjust decimals
  if (value <= 0n) return { valid: false, error: "Must be positive" };
  if (value > (1n << 64n) - 1n) return { valid: false, error: "Exceeds maximum" };
  return { valid: true, value };
}
```

Wrap in proper UI state machine (see `FRONTEND.md` §6.1) — this snippet shows only the data flow.

---

## §7 — Frontend: user decryption

```typescript
import { ZeroHash } from "ethers";

interface DecryptCache {
  signature: string;
  publicKey: string;
  privateKey: string;
  contractAddress: string;
  signerAddress: string;
}

let session: DecryptCache | null = null;

async function getOrCreateSession(
  signer: any,
  contractAddress: string
): Promise<DecryptCache> {
  if (
    session &&
    session.contractAddress === contractAddress &&
    session.signerAddress.toLowerCase() === (await signer.getAddress()).toLowerCase()
  ) {
    return session;
  }

  const inst = await getInstance();
  const { publicKey, privateKey } = inst.generateKeypair();
  const eip712 = inst.createEIP712(publicKey, contractAddress);
  const signature = await signer.signTypedData(
    eip712.domain,
    eip712.types,
    eip712.message
  );

  session = {
    signature,
    publicKey,
    privateKey,
    contractAddress,
    signerAddress: await signer.getAddress(),
  };
  return session;
}

export async function decryptBalance(
  signer: any,
  contract: any
): Promise<bigint | null> {
  const handle = await contract.getEncryptedBalance();
  if (handle === ZeroHash) return null; // not initialized

  const sess = await getOrCreateSession(signer, await contract.getAddress());
  const inst = await getInstance();

  return inst.userDecrypt(
    handle,
    sess.privateKey,
    sess.publicKey,
    sess.signature,
    sess.contractAddress,
    sess.signerAddress
  );
}

// Reset on account or chain change:
window.ethereum?.on("accountsChanged", () => { session = null; });
window.ethereum?.on("chainChanged",   () => { session = null; });
```

The session caches the EIP-712 signature so the user signs once per session, not per read.

---

## §8 — Frontend: full reveal-and-finalize

```typescript
type Status =
  | "idle"
  | "marking"
  | "decrypting"
  | "finalizing"
  | "done"
  | { kind: "error"; message: string };

export async function revealAndFinalize(
  contract: any,
  handles: { yes: string; no: string },
  setStatus: (s: Status) => void
) {
  try {
    // Step 1: mark decryptable on-chain
    setStatus("marking");
    let tx = await contract.startReveal();
    await tx.wait();

    // Step 2: off-chain decryption (slow on mainnet)
    setStatus("decrypting");
    const inst = await getInstance();
    const handleArray = [handles.yes, handles.no];
    const r = await withRetry(() => inst.publicDecrypt(handleArray));

    const yes = r.clearValues[handles.yes];
    const no = r.clearValues[handles.no];

    // Step 3: submit proof on-chain
    setStatus("finalizing");
    tx = await contract.finalize(yes, no, r.decryptionProof);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("finalize reverted");

    setStatus("done");
  } catch (err: any) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      setStatus("idle");
    } else {
      setStatus({ kind: "error", message: err.shortMessage ?? err.message });
    }
  }
}

async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  for (let i = 0; i < max; i++) {
    try { return await fn(); }
    catch (err: any) {
      const transient = err.code === "NETWORK_ERROR"
        || err.message?.includes("timeout")
        || (err.status >= 500 && err.status < 600);
      if (!transient || i === max - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new Error("unreachable");
}
```

Each phase is distinct; UI binds copy/spinner per phase. Mainnet relayer can take 30–120s — show elapsed time during `decrypting`.
