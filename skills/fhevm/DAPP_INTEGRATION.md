# DAPP_INTEGRATION.md — Complete dApp Wiring Guide

This file covers the full end-to-end pattern for wiring an FHEVM contract into a working frontend. Read this alongside `FRONTEND.md`. This file is about structure and completeness — `FRONTEND.md` has the SDK-specific details.

---

## §0 — Critical rules before writing any frontend code

**NEVER generate a random wallet or use a hardcoded private key in a frontend.** The frontend MUST use `window.ethereum` (MetaMask, Rabby, or any injected wallet). Random wallet generation is a security violation and breaks the user flow entirely.

**MUST expose ALL contract functions** in the UI — not just one. If the contract has `setSalary`, `getSalary`, `registerEmployee`, `getEmployeeList` — every function needs a UI element.

**MUST use real wallet connection** via `window.ethereum.request({ method: 'eth_requestAccounts' })`. No wallet libraries, no random key generation.

**MUST show role-based UI** — if the contract has distinct roles (manager vs employee), show different panels based on the connected address.

---

## §1 — Project structure for agent-generated dApp

When building from scratch, always generate this structure:

```
project/
  contracts/
    MyContract.sol
  scripts/
    deploy.ts
  frontend/
    index.html          ← single file, complete app
    sdk-bundle.js       ← built by esbuild
    ethers-bundle.js    ← built by esbuild
    kms_lib_bg.wasm     ← copied from node_modules
    tfhe_bg.wasm        ← copied from node_modules
    workerHelpers.js    ← copied from node_modules
  hardhat.config.ts
  package.json
  .env                  ← NEVER commit
  .gitignore            ← MUST include .env
```

---

## §2 — Complete wallet connection pattern

This is the only acceptable wallet connection pattern for FHEVM frontends:

```javascript
let provider, signer, userAddress, instance;

async function connectWallet() {
  // 1. Check wallet exists
  if (!window.ethereum) {
    showError('No wallet detected. Install MetaMask or Rabby.');
    return;
  }

  // 2. Request accounts
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  userAddress = accounts[0];

  // 3. Set up ethers provider
  const { BrowserProvider } = await import('./ethers-bundle.js');
  provider = new BrowserProvider(window.ethereum);
  signer = await provider.getSigner();

  // 4. Check chain — switch to Sepolia if needed (chainId 11155111)
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 11155111) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xaa36a7' }],
      });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0xaa36a7',
            chainName: 'Sepolia',
            rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            blockExplorerUrls: ['https://sepolia.etherscan.io'],
          }],
        });
      }
    }
    // Re-initialize after chain switch
    provider = new BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
  }

  // 5. Initialize FHEVM SDK
  const { createInstance, SepoliaConfig, initSDK } = await import('./sdk-bundle.js');
  await initSDK();
  instance = await createInstance({
    ...SepoliaConfig,
    network: 'https://ethereum-sepolia-rpc.publicnode.com',
  });

  // 6. Wire contract
  const { Contract } = await import('./ethers-bundle.js');
  contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

  // 7. Update UI
  updateConnectedState(userAddress);
  await loadContractData();
}

// MUST handle account and chain changes
window.ethereum?.on('accountsChanged', (accounts) => {
  if (!accounts.length) disconnectWallet();
  else { userAddress = accounts[0]; connectWallet(); }
});
window.ethereum?.on('chainChanged', () => connectWallet());
```

---

## §3 — Role-based UI pattern

For contracts with distinct roles (manager / employee), detect and show the correct panel:

```javascript
async function loadContractData() {
  // Check if current user is a manager
  const isManager = await contract.isManager(userAddress);
  const isEmployee = await contract.isEmployee(userAddress);

  document.getElementById('manager-panel').style.display = isManager ? 'block' : 'none';
  document.getElementById('employee-panel').style.display = isEmployee ? 'block' : 'none';
  document.getElementById('register-panel').style.display = (!isManager && !isEmployee) ? 'block' : 'none';
}
```

Always show all three states. Never hide the registration panel entirely — a new user needs a way in.

---

## §4 — Complete function exposure pattern

Every contract function needs a UI element. For each function:

```javascript
// Pattern for every write function
async function callContractFunction(params) {
  const btn = document.getElementById('function-btn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    // Encrypt if needed
    // ...

    const tx = await contract.functionName(...params);
    btn.textContent = 'Mining...';
    const receipt = await tx.wait();
    btn.textContent = 'Done ✓';
    showSuccess(`Transaction confirmed. Gas: ${receipt.gasUsed.toLocaleString()}`);
    await loadContractData(); // refresh UI
  } catch (e) {
    const msg = e.shortMessage ?? e.message ?? 'Unknown error';
    showError(msg);
    btn.textContent = 'Retry';
  } finally {
    btn.disabled = false;
  }
}
```

---

## §5 — Encrypted input → contract call → decrypt pattern

The full lifecycle for an encrypted value:

```javascript
// Step 1: Encrypt
async function encryptAndSubmit(plaintextValue) {
  const input = instance.createEncryptedInput(CONTRACT_ADDRESS, userAddress);
  input.add64(BigInt(plaintextValue));
  const { handles, inputProof } = await input.encrypt();

  // Step 2: Submit to contract
  const tx = await contract.setValue(handles[0], inputProof);
  await tx.wait();
}

// Step 3: Decrypt (separate user action)
async function decryptMyValue() {
  // Get handle from contract
  const rawHandle = await contract.getMyValue(userAddress);
  if (BigInt(rawHandle) === 0n) {
    showError('No value set yet.');
    return;
  }

  const handle = '0x' + BigInt(rawHandle).toString(16).padStart(64, '0');

  // Generate keypair
  const { publicKey, privateKey } = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;

  // Sign EIP-712 — ethers v6: strip EIP712Domain
  const eip712 = instance.createEIP712(publicKey, [CONTRACT_ADDRESS], startTimestamp, durationDays);
  const { EIP712Domain: _, ...types } = eip712.types;
  const sig = await signer.signTypedData(eip712.domain, types, eip712.message);

  // Decrypt
  const result = await instance.userDecrypt(
    [{ handle, contractAddress: CONTRACT_ADDRESS }],
    privateKey, publicKey, sig,
    [CONTRACT_ADDRESS], userAddress, startTimestamp, durationDays
  );

  const plaintext = result[handle];
  document.getElementById('decrypted-value').textContent = plaintext.toString();
}
```

---

## §6 — Minimum viable UI structure

Every generated frontend MUST include these sections:

```html
<!-- 1. Header with wallet state -->
<header>
  <h1>Contract Name</h1>
  <div id="wallet-section">
    <button id="connect-btn" onclick="connectWallet()">Connect Wallet</button>
    <span id="wallet-address" style="display:none"></span>
  </div>
</header>

<!-- 2. Status / error display -->
<div id="status-bar" style="display:none"></div>
<div id="error-bar" style="display:none"></div>

<!-- 3. Role panels — shown/hidden based on connected address -->
<div id="register-panel" style="display:none">
  <!-- Registration UI -->
</div>

<div id="manager-panel" style="display:none">
  <!-- All manager functions -->
</div>

<div id="employee-panel" style="display:none">
  <!-- All employee functions including decrypt -->
</div>

<!-- 4. Transaction history (optional but recommended) -->
<div id="tx-history"></div>
```

---

## §7 — GitHub Pages deployment pattern

For static frontends deployed to GitHub Pages:

```json
// package.json scripts
{
  "scripts": {
    "build:sdk": "npx esbuild node_modules/@zama-fhe/relayer-sdk/lib/web.js --bundle --format=esm --platform=browser --outfile=frontend/sdk-bundle.js --external:*.wasm",
    "build:ethers": "npx esbuild node_modules/ethers/lib.esm/ethers.js --bundle --format=esm --platform=browser --outfile=frontend/ethers-bundle.js",
    "build": "npm run build:sdk && npm run build:ethers && cp node_modules/@zama-fhe/relayer-sdk/lib/*.wasm frontend/ && cp node_modules/@zama-fhe/relayer-sdk/lib/workerHelpers.js frontend/",
    "deploy": "npm run build && git add frontend/ && git commit -m 'build' && git push"
  }
}
```

GitHub Pages requires all WASM files to be in the same directory as the HTML file. The copy step above ensures this.

---

## §8 — Common agent mistakes to avoid

| Mistake | What to do instead |
|---|---|
| Generating a random wallet with `ethers.Wallet.createRandom()` | Use `window.ethereum` — NEVER generate wallets in frontend |
| Only wiring one contract function | Wire every function — read functions AND write functions |
| Hardcoding RPC URL differently from SepoliaConfig | Use `https://ethereum-sepolia-rpc.publicnode.com` consistently |
| Forgetting to handle the case where user has no wallet | Check `window.ethereum` before any call, show install prompt |
| Not showing decrypt button | Every encrypted value the user owns MUST have a decrypt button |
| Showing all panels at once | Show panels based on role detection from contract state |
| Not handling `accountsChanged` | Wire event listeners for `accountsChanged` and `chainChanged` |
| Using `ethers.providers.Web3Provider` | Use `ethers.BrowserProvider` — ethers v6 API |
| Calling `getAddress()` on provider instead of signer | Always `await signer.getAddress()` |
| Not awaiting `tx.wait()` before updating UI | Always wait for confirmation before showing success |
