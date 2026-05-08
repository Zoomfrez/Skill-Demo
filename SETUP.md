# SETUP.md — FHEVM Development Environment from Zero

Step-by-step setup using the official Zama Hardhat template. Covers local mock environment, Sepolia testnet, and mainnet.

---

## §0 — Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18.x or 20.x | 22.x has peer-dep conflicts with Hardhat 2.x |
| npm | 8+ | Use `--legacy-peer-deps` on all installs |
| Git | any | — |
| MetaMask or Rabby | latest | Browser wallet for testnet interaction |
| Sepolia ETH | ~0.5 ETH | From faucet: sepoliafaucet.com or alchemy.com/faucets |

---

## §1 — Bootstrap from Zama template

The fastest path is forking the official React dApp template:

```bash
git clone https://github.com/zama-ai/dapp-react-hardhat-template my-fhevm-app
cd my-fhevm-app
npm install --legacy-peer-deps
```

**Why `--legacy-peer-deps`:** Hardhat 2.x has peer dependency conflicts with some Nomicfoundation tooling on Node 18+. This flag is required — do not omit it. See `CHANGELOG.md` for full version pin rationale.

The template includes:
- `hardhat.config.ts` pre-configured for local mock + Sepolia
- `@fhevm/hardhat-plugin` already installed
- `@fhevm/solidity` and `@zama-fhe/relayer-sdk` installed
- Example confidential ERC-20 contract
- React frontend with SDK integration

---

## §2 — Environment variables

Create `.env` in the project root (never commit this file):

```bash
# .env
SEPOLIA_RPC_URL=https://ethereum-sepolia.blockpi.network/v1/rpc/public
PRIVATE_KEY=0x<your_deployer_private_key>
ETHERSCAN_API_KEY=<your_etherscan_api_key>

# Mainnet only
MAINNET_RPC_URL=https://mainnet.infura.io/v3/<key>
MAINNET_PRIVATE_KEY=0x<mainnet_deployer_key>
ZAMA_RELAYER_API_KEY=<key_from_zama>
```

Verify `.gitignore` includes `.env`:
```bash
grep ".env" .gitignore || echo ".env" >> .gitignore
```

---

## §3 — Project structure

After setup, your project should look like:

```
my-fhevm-app/
  contracts/
    MyConfidentialContract.sol   ← your contract
  scripts/
    deploy.ts                    ← deployment script
  test/
    MyConfidentialContract.ts    ← hardhat tests
  frontend/
    src/                         ← React app
  hardhat.config.ts
  package.json
  tsconfig.json
  .env                           ← never commit
```

---

## §4 — Writing your first confidential contract

Minimal confidential counter (start here before complex types):

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHEVM.sol";
import "@fhevm/solidity/lib/FHE.sol";

contract ConfidentialCounter is FHEVM {
    euint32 private _count;

    function increment(externalEuint32 calldata encAmount, bytes calldata inputProof) external {
        euint32 amount = FHE.fromExternal(encAmount, inputProof);
        _count = FHE.add(_count, amount);
        FHE.allowThis(_count);        // contract can use it next time
        FHE.allow(_count, msg.sender); // caller can decrypt it
    }

    function getCount() external view returns (euint32) {
        return _count;
    }
}
```

Key rules demonstrated:
- `FHEVM` base contract is required
- `externalEuint32` + `inputProof` for all user inputs
- `FHE.fromExternal` validates the input proof before use
- `FHE.allowThis` after every state-modifying op
- `FHE.allow` for anyone who needs to decrypt

---

## §5 — Compile and test locally

```bash
# Compile
npx hardhat compile

# Run tests against local mock (no network needed)
npx hardhat test

# Run a specific test file
npx hardhat test test/ConfidentialCounter.ts
```

The `@fhevm/hardhat-plugin` sets up a local mock FHEVM environment automatically. Tests run fast — no KMS round-trips in mock mode.

**Mock vs Sepolia behaviour:**
| | Mock | Sepolia |
|---|---|---|
| FHE operations | Instant | Async (coprocessor) |
| Decryption | Synchronous | ~5–15s KMS round-trip |
| Gas | Estimated only | Real gas consumed |
| Cost | Free | Sepolia ETH required |

---

## §6 — Deploy to Sepolia

```bash
# Single command deploy
npx hardhat run scripts/deploy.ts --network sepolia

# Save the deployed address — you need it for verification and frontend
```

Minimal `deploy.ts`:

```typescript
import { ethers } from "hardhat";

async function main() {
  const factory = await ethers.getContractFactory("ConfidentialCounter");
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("Deployed to:", address);
}

main().catch(console.error);
```

---

## §7 — Verify on Etherscan

```bash
# Standard verify
npx hardhat verify --network sepolia <CONTRACT_ADDRESS>

# If verify fails with bytecode mismatch:
# Use Standard JSON Input from the original compile (not --force)
# Go to Etherscan → Verify → Solidity Standard JSON Input → paste
```

---

## §8 — Interact via scripts

After deployment, test the contract with a script before building the UI:

```typescript
import { ethers } from "hardhat";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk";

async function main() {
  const [signer] = await ethers.getSigners();
  const contract = await ethers.getContractAt("ConfidentialCounter", "<ADDRESS>");

  // Initialize SDK
  const instance = await createInstance({
    ...SepoliaConfig,
    network: process.env.SEPOLIA_RPC_URL!,
  });

  // Encrypt input
  const input = instance.createEncryptedInput("<ADDRESS>", signer.address);
  input.add32(42);
  const { handles, inputProof } = await input.encrypt();

  // Call contract
  const tx = await contract.increment(handles[0], inputProof);
  await tx.wait();
  console.log("Incremented by 42 (encrypted)");
}

main().catch(console.error);
```

---

## §9 — Common setup failures

| Error | Cause | Fix |
|---|---|---|
| `Cannot find module '@fhevm/hardhat-plugin'` | Missing install | `npm install --legacy-peer-deps` |
| `peer dep conflict` | Node 22 + Hardhat 2.x | Use Node 18 or 20 |
| `HH9: Error while loading config` | Missing import in hardhat.config.ts | Add `import "@fhevm/hardhat-plugin"` at top |
| `transaction underpriced` on Sepolia | RPC issue | Switch to a different public RPC |
| `CompilerError: Source not found` | Wrong import path | Check `@fhevm/solidity` version in CHANGELOG.md |
| `FHE operations in constructor` | Wrong placement | Move all FHE ops to initializer function |

---

## §10 — From template to production checklist

Before shipping beyond testnet:

- [ ] All `FHE.allowThis` calls verified after every stored handle mutation
- [ ] No FHE operations in constructor
- [ ] No `if (ebool)` — using `FHE.select` instead
- [ ] Input proofs validated with `FHE.fromExternal` before every operation
- [ ] Replay protection on all `decryptionProof` consumers
- [ ] `ZAMA_RELAYER_API_KEY` set for mainnet
- [ ] Contract verified on Etherscan
- [ ] Frontend `vercel.json` has WASM content-type header
