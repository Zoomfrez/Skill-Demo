"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/helper/RainbowKitCustomConnectButton";
import { Role, ROLE_LABELS, useSalaryRegistry } from "~~/hooks/salary-registry/useSalaryRegistry";

// ── Styles ────────────────────────────────────────────────────────────────────
const card = "bg-white border border-gray-200 shadow p-6 mb-4";
const title = "font-bold text-gray-900 text-lg mb-4 border-b border-gray-200 pb-2";
const btn =
  "inline-flex items-center justify-center px-5 py-2.5 font-semibold text-sm shadow transition-all " +
  "focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-40 disabled:pointer-events-none cursor-pointer";
const primary = `${btn} bg-[#FFD208] text-gray-900 hover:bg-[#e6bd00] focus:ring-[#FFD208]`;
const secondary = `${btn} bg-gray-900 text-white hover:bg-gray-700 focus:ring-gray-500`;
const inputCls =
  "w-full border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#FFD208]";
const labelCls = "block text-sm font-medium text-gray-700 mb-1";

// ── Role badge ────────────────────────────────────────────────────────────────
function RoleBadge({ role }: { role: Role }) {
  const colours: Record<Role, string> = {
    [Role.None]: "bg-gray-100 text-gray-600",
    [Role.Employee]: "bg-blue-100 text-blue-700",
    [Role.Manager]: "bg-purple-100 text-purple-700",
    [Role.Admin]: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={`inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full ${colours[role]}`}>
      {ROLE_LABELS[role]}
    </span>
  );
}

// ── Manager panel ─────────────────────────────────────────────────────────────
function ManagerPanel({ registry }: { registry: ReturnType<typeof useSalaryRegistry> }) {
  const [employee, setEmployee] = useState("");
  const [amount, setAmount] = useState("");

  return (
    <div className={card}>
      <h3 className={title}>Set Employee Salary</h3>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Employee Address</label>
          <input
            className={inputCls}
            placeholder="0x..."
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls}>Salary (plaintext — encrypted on submission)</label>
          <input
            className={inputCls}
            type="number"
            min="0"
            placeholder="e.g. 85000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <button
          className={primary}
          disabled={registry.isProcessing || !employee || !amount}
          onClick={() => registry.setSalary(employee, parseInt(amount, 10))}
        >
          {registry.isProcessing ? "Processing..." : "Encrypt & Set Salary"}
        </button>
      </div>
    </div>
  );
}

// ── Admin panel ───────────────────────────────────────────────────────────────
function AdminPanel({ registry }: { registry: ReturnType<typeof useSalaryRegistry> }) {
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<Role>(Role.Employee);

  return (
    <div className={card}>
      <h3 className={title}>Manage Roles</h3>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Address</label>
          <input
            className={inputCls}
            placeholder="0x..."
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls}>Role</label>
          <select
            className={inputCls}
            value={role}
            onChange={(e) => setRole(parseInt(e.target.value, 10) as Role)}
          >
            <option value={Role.None}>None</option>
            <option value={Role.Employee}>Employee</option>
            <option value={Role.Manager}>Manager</option>
            <option value={Role.Admin}>Admin</option>
          </select>
        </div>
        <button
          className={secondary}
          disabled={registry.isProcessing || !target}
          onClick={() => registry.setRole(target, role)}
        >
          {registry.isProcessing ? "Processing..." : "Set Role"}
        </button>
      </div>

      <div className="mt-6 border-t border-gray-100 pt-4">
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Look up role</h4>
        <div className="flex gap-2">
          <input
            className={`${inputCls} flex-1`}
            placeholder="0x..."
            value={registry.lookupAddr}
            onChange={(e) => registry.setLookupAddr(e.target.value)}
          />
        </div>
        {registry.lookupAddr && (
          <p className="mt-2 text-sm text-gray-600">
            Role: <RoleBadge role={registry.lookupRole} />
          </p>
        )}
      </div>
    </div>
  );
}

// ── Employee panel ────────────────────────────────────────────────────────────
function EmployeePanel({ registry }: { registry: ReturnType<typeof useSalaryRegistry> }) {
  return (
    <div className={card}>
      <h3 className={title}>My Salary</h3>
      {!registry.hasMySalary ? (
        <p className="text-sm text-gray-500">No salary has been set for your address yet.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-gray-50 border border-gray-200 px-4 py-3">
            <span className="text-sm text-gray-600">Encrypted handle</span>
            <span className="font-mono text-xs text-gray-800 truncate max-w-[240px]">{registry.myHandle}</span>
          </div>

          {registry.isDecrypted ? (
            <div className="flex items-center justify-between bg-green-50 border border-green-200 px-4 py-3">
              <span className="text-sm text-gray-700 font-medium">Salary (decrypted)</span>
              <span className="text-2xl font-bold text-green-700">{registry.mySalary?.toString()}</span>
            </div>
          ) : (
            <button
              className={primary}
              disabled={registry.isDecrypting || registry.isAllowing}
              onClick={registry.decryptSalary}
            >
              {registry.isAllowing
                ? "Waiting for signature..."
                : registry.isDecrypting
                  ? "Decrypting..."
                  : "Decrypt My Salary"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Root page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const { isConnected } = useAccount();
  const registry = useSalaryRegistry();

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="bg-white border border-gray-200 shadow-xl p-10 text-center max-w-sm w-full">
          <div className="text-4xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Confidential Salary Registry</h2>
          <p className="text-gray-500 mb-6 text-sm">
            Salaries are encrypted on-chain using FHE. Only you can decrypt your own.
          </p>
          <RainbowKitCustomConnectButton />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-2">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Confidential Salary Registry</h1>
        <p className="text-sm text-gray-500 mt-1">
          Contract:{" "}
          <a
            href={`https://sepolia.etherscan.io/address/${registry.contractAddress}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-blue-600 hover:underline"
          >
            {registry.contractAddress}
          </a>
        </p>
      </div>

      {/* Status bar */}
      <div className={`${card} flex items-center justify-between`}>
        <div>
          <p className="text-xs text-gray-500">Connected as</p>
          <p className="font-mono text-sm text-gray-800">{registry.address}</p>
        </div>
        <RoleBadge role={registry.myRole} />
      </div>

      {/* Role-specific panels */}
      {registry.myRole >= Role.Employee && <EmployeePanel registry={registry} />}
      {registry.myRole >= Role.Manager && <ManagerPanel registry={registry} />}
      {registry.myRole >= Role.Admin && <AdminPanel registry={registry} />}

      {/* Catch-all for Role.None */}
      {registry.myRole === Role.None && (
        <div className={card}>
          <p className="text-sm text-gray-500">
            Your address has no role on this contract. Ask the admin to assign you one.
          </p>
          <p className="text-xs text-gray-400 mt-2 font-mono break-all">Admin address set at deployment.</p>
        </div>
      )}

      {/* Message log */}
      {registry.message && (
        <div className="bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700">
          {registry.message}
        </div>
      )}
    </div>
  );
}
