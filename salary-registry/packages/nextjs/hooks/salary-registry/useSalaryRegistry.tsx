"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useAllow, useEncrypt, useIsAllowed, useUserDecrypt } from "@zama-fhe/react-sdk";
import { ZERO_HANDLE } from "@zama-fhe/sdk";
import { bytesToHex, isAddress, parseAbiItem } from "viem";
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { SalaryRegistry } from "~~/contracts/SalaryRegistry";
import { deploymentFor } from "~~/utils/contract";

export enum Role {
  None = 0,
  Employee = 1,
  Manager = 2,
  Admin = 3,
}

export const ROLE_LABELS: Record<Role, string> = {
  [Role.None]: "None",
  [Role.Employee]: "Employee",
  [Role.Manager]: "Manager",
  [Role.Admin]: "Admin",
};

export type EmployeeEntry = {
  address: `0x${string}`;
  blockNumber: bigint;
};

export type TxPhase = "idle" | "encrypting" | "awaiting-wallet" | "mining";

export function useSalaryRegistry() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const registry = useMemo(() => deploymentFor(SalaryRegistry, chainId), [chainId]);

  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const [activeOp, setActiveOp] = useState<string>("");
  const [employees, setEmployees] = useState<EmployeeEntry[]>([]);
  const [mySalaryBlock, setMySalaryBlock] = useState<bigint | undefined>();

  const isProcessing = txPhase !== "idle";
  const hasContract = Boolean(registry?.address && registry?.abi);

  // --- Read: connected user's role ---
  const roleResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "roles" as const,
    args: address ? [address] : undefined,
    query: { enabled: Boolean(hasContract && isConnected && address), refetchOnWindowFocus: false },
  });
  const myRole = (roleResult.data as Role | undefined) ?? Role.None;
  const isLoadingRole = roleResult.isLoading;

  // --- Read: connected user's encrypted salary handle ---
  const myHandleResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "getEncryptedSalary" as const,
    args: address ? [address] : undefined,
    query: { enabled: Boolean(hasContract && isConnected && address), refetchOnWindowFocus: false },
  });
  const myHandle = (myHandleResult.data as string | undefined) ?? undefined;
  const hasMySalary = myHandle && myHandle !== ZERO_HANDLE;
  const isLoadingHandle = myHandleResult.isLoading;

  // --- Fetch SalarySet events for employee list + last-set block ---
  useEffect(() => {
    if (!hasContract || !registry?.address || !publicClient) return;
    const fetchLogs = async () => {
      try {
        const logs = await publicClient.getLogs({
          address: registry.address,
          event: parseAbiItem("event SalarySet(address indexed employee, bytes32 handle)"),
          fromBlock: BigInt(registry.deployedOnBlock ?? 0),
          toBlock: "latest",
        });
        const map = new Map<string, EmployeeEntry>();
        for (const log of logs) {
          if (log.args.employee) {
            map.set(log.args.employee.toLowerCase(), {
              address: log.args.employee,
              blockNumber: log.blockNumber ?? 0n,
            });
          }
        }
        const sorted = [...map.values()].sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1));
        setEmployees(sorted);
        if (address) {
          const mine = sorted.find(e => e.address.toLowerCase() === address.toLowerCase());
          setMySalaryBlock(mine?.blockNumber);
        }
      } catch {
        // non-critical
      }
    };
    fetchLogs();
  }, [hasContract, registry?.address, registry?.deployedOnBlock, publicClient, address]);

  // --- Decrypt ---
  const decryptHandles = useMemo(() => {
    if (!hasMySalary || !registry?.address) return [];
    return [{ handle: myHandle as `0x${string}`, contractAddress: registry.address }];
  }, [hasMySalary, myHandle, registry?.address]);

  const contractAddr = (registry?.address ?? "0x0") as `0x${string}`;
  const { mutate: allow, isPending: isAllowing } = useAllow();
  const { data: isAllowed } = useIsAllowed({ contractAddresses: [contractAddr] });

  const [decryptEnabled, setDecryptEnabled] = useState(false);
  const decrypt = useUserDecrypt({ handles: decryptHandles }, { enabled: decryptEnabled && !!isAllowed });

  const mySalary = useMemo(() => {
    if (!myHandle || !decrypt.data) return undefined;
    return decrypt.data[myHandle as `0x${string}`];
  }, [myHandle, decrypt.data]);

  const isDecrypted = mySalary !== undefined;

  useEffect(() => {
    if (decrypt.error) toast.error("Decryption failed: " + decrypt.error.message);
  }, [decrypt.error]);

  const decryptSalary = useCallback(async () => {
    if (!hasMySalary || !registry?.address) return;
    setDecryptEnabled(true);
    if (!isAllowed) {
      toast("Sign the EIP-712 message in your wallet to authorize decryption", { icon: "🔑" });
      allow([registry.address]);
      return;
    }
    toast("Decrypting salary...", { icon: "⏳" });
  }, [hasMySalary, registry?.address, isAllowed, allow]);

  const encrypt = useEncrypt();
  const { writeContractAsync } = useWriteContract();

  // --- Core write helper: Confirm in wallet → Mining → Done/Error ---
  const writeWithPhases = useCallback(
    async (opKey: string, fn: () => Promise<`0x${string}`>, successMsg: string, onSuccess?: () => void) => {
      if (!hasContract || !publicClient) return;
      setActiveOp(opKey);
      setTxPhase("awaiting-wallet");
      const tid = toast.loading("Confirm in wallet...");
      try {
        const hash = await fn();
        setTxPhase("mining");
        toast.loading("Mining...", { id: tid });
        await publicClient.waitForTransactionReceipt({ hash });
        toast.success(successMsg, { id: tid });
        onSuccess?.();
      } catch (e: any) {
        if (e.code === 4001 || e.code === "ACTION_REJECTED") {
          toast.dismiss(tid);
        } else {
          toast.error(`Failed: ${e.shortMessage ?? e.message ?? String(e)}`, { id: tid });
        }
      } finally {
        setActiveOp("");
        setTxPhase("idle");
      }
    },
    [hasContract, publicClient],
  );

  // --- Set salary (Manager): Encrypting → Confirm in wallet → Mining → Done ---
  const setSalary = useCallback(
    async (employeeAddr: string, salaryAmount: number) => {
      if (!hasContract || !address || !registry?.address) return;
      if (!isAddress(employeeAddr)) { toast.error("Invalid employee address"); return; }
      setActiveOp("setSalary");
      setTxPhase("encrypting");
      const tid = toast.loading("Encrypting salary...");
      try {
        const enc = await encrypt.mutateAsync({
          values: [{ value: BigInt(salaryAmount), type: "euint64" }],
          contractAddress: registry.address,
          userAddress: address,
        });
        setTxPhase("awaiting-wallet");
        toast.loading("Confirm in wallet...", { id: tid });
        const hash = await writeContractAsync({
          address: registry.address,
          abi: registry.abi,
          functionName: "setSalary",
          args: [employeeAddr as `0x${string}`, bytesToHex(enc.handles[0]!), bytesToHex(enc.inputProof)],
          gas: 15_000_000n,
        });
        setTxPhase("mining");
        toast.loading("Mining...", { id: tid });
        await publicClient!.waitForTransactionReceipt({ hash });
        toast.success(`Salary set for ${employeeAddr.slice(0, 8)}...`, { id: tid });
        myHandleResult.refetch();
      } catch (e: any) {
        if (e.code === 4001 || e.code === "ACTION_REJECTED") {
          toast.dismiss(tid);
        } else {
          toast.error(`Failed: ${e.shortMessage ?? e.message ?? String(e)}`, { id: tid });
        }
      } finally {
        setActiveOp("");
        setTxPhase("idle");
      }
    },
    [hasContract, address, registry, encrypt, writeContractAsync, publicClient, myHandleResult],
  );

  // --- Set role (Admin) ---
  const setRole = useCallback(
    async (targetAddr: string, role: Role) => {
      if (!hasContract || !registry?.address) return;
      if (!isAddress(targetAddr)) { toast.error("Invalid address"); return; }
      await writeWithPhases(
        "setRole",
        () =>
          writeContractAsync({
            address: registry.address,
            abi: registry.abi,
            functionName: "setRole",
            args: [targetAddr as `0x${string}`, role],
          }),
        `${ROLE_LABELS[role]} role granted to ${targetAddr.slice(0, 8)}...`,
        () => roleResult.refetch(),
      );
    },
    [hasContract, registry, writeContractAsync, writeWithPhases, roleResult],
  );

  const revokeRole = useCallback((targetAddr: string) => setRole(targetAddr, Role.None), [setRole]);
  const addManager = useCallback((targetAddr: string) => setRole(targetAddr, Role.Manager), [setRole]);

  // --- Grant manager access to salary (Admin) ---
  const grantManagerAccess = useCallback(
    async (managerAddr: string, employeeAddr: string) => {
      if (!hasContract || !registry?.address) return;
      if (!isAddress(managerAddr) || !isAddress(employeeAddr)) { toast.error("Invalid address"); return; }
      await writeWithPhases(
        "grantManagerAccess",
        () =>
          writeContractAsync({
            address: registry.address,
            abi: registry.abi,
            functionName: "grantManagerAccess",
            args: [managerAddr as `0x${string}`, employeeAddr as `0x${string}`],
          }),
        "Manager access granted",
      );
    },
    [hasContract, registry, writeContractAsync, writeWithPhases],
  );

  // --- Grant observer access to salary (Admin) — any third-party address ---
  const grantObserverAccess = useCallback(
    async (observerAddr: string, employeeAddr: string) => {
      if (!hasContract || !registry?.address) return;
      if (!isAddress(observerAddr) || !isAddress(employeeAddr)) { toast.error("Invalid address"); return; }
      await writeWithPhases(
        "grantObserverAccess",
        () =>
          writeContractAsync({
            address: registry.address,
            abi: registry.abi,
            functionName: "grantObserverAccess",
            args: [observerAddr as `0x${string}`, employeeAddr as `0x${string}`],
          }),
        "Observer access granted",
      );
    },
    [hasContract, registry, writeContractAsync, writeWithPhases],
  );

  // --- Self-register as Employee ---
  const registerAsEmployee = useCallback(async () => {
    if (!hasContract || !registry?.address) return;
    await writeWithPhases(
      "register",
      () =>
        writeContractAsync({
          address: registry.address,
          abi: registry.abi,
          functionName: "register",
          args: [],
        }),
      "Registered as Employee!",
      () => roleResult.refetch(),
    );
  }, [hasContract, registry, writeContractAsync, writeWithPhases, roleResult]);

  // --- Role lookup ---
  const [lookupAddr, setLookupAddr] = useState<string>("");
  const lookupResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "roles" as const,
    args: isAddress(lookupAddr) ? [lookupAddr as `0x${string}`] : undefined,
    query: { enabled: Boolean(hasContract && isAddress(lookupAddr)), refetchOnWindowFocus: false },
  });
  const lookupRole = (lookupResult.data as Role | undefined) ?? Role.None;

  // --- hasSalary check ---
  const [checkAddr, setCheckAddr] = useState<string>("");
  const hasSalaryResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "hasSalary" as const,
    args: isAddress(checkAddr) ? [checkAddr as `0x${string}`] : undefined,
    query: { enabled: Boolean(hasContract && isAddress(checkAddr)), refetchOnWindowFocus: false },
  });
  const checkHasSalary = hasSalaryResult.data as boolean | undefined;

  return {
    contractAddress: registry?.address,
    myRole,
    myHandle,
    hasMySalary,
    mySalary,
    isDecrypted,
    isDecrypting: decrypt.isFetching,
    isAllowing,
    isLoadingRole,
    isLoadingHandle,
    decryptSalary,
    setSalary,
    setRole,
    revokeRole,
    addManager,
    grantManagerAccess,
    grantObserverAccess,
    registerAsEmployee,
    isProcessing,
    txPhase,
    activeOp,
    isConnected,
    address,
    employees,
    mySalaryBlock,
    lookupAddr,
    setLookupAddr,
    lookupRole,
    checkAddr,
    setCheckAddr,
    checkHasSalary,
    refreshRole: roleResult.refetch,
  };
}
