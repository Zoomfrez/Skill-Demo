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

export function useSalaryRegistry() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const registry = useMemo(() => deploymentFor(SalaryRegistry, chainId), [chainId]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [employees, setEmployees] = useState<EmployeeEntry[]>([]);
  const [mySalaryBlock, setMySalaryBlock] = useState<bigint | undefined>();

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

  // --- Fetch SalarySet events for employee list (managers) + last-set block (employees) ---
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
        // non-critical — silently ignore RPC errors
      }
    };
    fetchLogs();
  }, [hasContract, registry?.address, registry?.deployedOnBlock, publicClient, address]);

  // --- Decrypt: connected user decrypts their own salary ---
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

  // --- Set salary (Manager) ---
  const setSalary = useCallback(
    async (employeeAddr: string, salaryAmount: number) => {
      if (!hasContract || !address || !registry?.address) return;
      if (!isAddress(employeeAddr)) { toast.error("Invalid employee address"); return; }
      setIsProcessing(true);
      const tid = toast.loading("Encrypting salary...");
      try {
        const enc = await encrypt.mutateAsync({
          values: [{ value: BigInt(salaryAmount), type: "euint64" }],
          contractAddress: registry.address,
          userAddress: address,
        });
        toast.loading("Sending transaction...", { id: tid });
        await writeContractAsync({
          address: registry.address,
          abi: registry.abi,
          functionName: "setSalary",
          args: [employeeAddr as `0x${string}`, bytesToHex(enc.handles[0]!), bytesToHex(enc.inputProof)],
          gas: 15_000_000n,
        });
        toast.success(`Salary set for ${employeeAddr.slice(0, 8)}...`, { id: tid });
      } catch (e) {
        toast.error(`Failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`, { id: tid });
      } finally {
        setIsProcessing(false);
      }
    },
    [hasContract, address, registry, encrypt, writeContractAsync],
  );

  // --- Set role (Admin) ---
  const setRole = useCallback(
    async (targetAddr: string, role: Role) => {
      if (!hasContract || !registry?.address) return;
      if (!isAddress(targetAddr)) { toast.error("Invalid address"); return; }
      setIsProcessing(true);
      const tid = toast.loading("Setting role...");
      try {
        await writeContractAsync({
          address: registry.address,
          abi: registry.abi,
          functionName: "setRole",
          args: [targetAddr as `0x${string}`, role],
        });
        toast.success(`${ROLE_LABELS[role]} role granted to ${targetAddr.slice(0, 8)}...`, { id: tid });
        roleResult.refetch();
      } catch (e) {
        toast.error(`Failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`, { id: tid });
      } finally {
        setIsProcessing(false);
      }
    },
    [hasContract, registry, writeContractAsync, roleResult],
  );

  const revokeRole = useCallback((targetAddr: string) => setRole(targetAddr, Role.None), [setRole]);

  // --- Grant manager access to a specific salary (Admin) ---
  const grantManagerAccess = useCallback(
    async (managerAddr: string, employeeAddr: string) => {
      if (!hasContract || !registry?.address) return;
      if (!isAddress(managerAddr) || !isAddress(employeeAddr)) { toast.error("Invalid address"); return; }
      setIsProcessing(true);
      const tid = toast.loading("Granting access...");
      try {
        await writeContractAsync({
          address: registry.address,
          abi: registry.abi,
          functionName: "grantManagerAccess",
          args: [managerAddr as `0x${string}`, employeeAddr as `0x${string}`],
        });
        toast.success("Manager access granted", { id: tid });
      } catch (e) {
        toast.error(`Failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`, { id: tid });
      } finally {
        setIsProcessing(false);
      }
    },
    [hasContract, registry, writeContractAsync],
  );

  // --- Self-register as Employee ---
  const registerAsEmployee = useCallback(async () => {
    if (!hasContract || !registry?.address) return;
    setIsProcessing(true);
    const tid = toast.loading("Registering...");
    try {
      await writeContractAsync({
        address: registry.address,
        abi: registry.abi,
        functionName: "register",
        args: [],
      });
      toast.success("Registered as Employee!", { id: tid });
      roleResult.refetch();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`, { id: tid });
    } finally {
      setIsProcessing(false);
    }
  }, [hasContract, registry, writeContractAsync, roleResult]);

  // --- Role lookup for admin panel ---
  const [lookupAddr, setLookupAddr] = useState<string>("");
  const lookupResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "roles" as const,
    args: isAddress(lookupAddr) ? [lookupAddr as `0x${string}`] : undefined,
    query: { enabled: Boolean(hasContract && isAddress(lookupAddr)), refetchOnWindowFocus: false },
  });
  const lookupRole = (lookupResult.data as Role | undefined) ?? Role.None;

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
    grantManagerAccess,
    registerAsEmployee,
    isProcessing,
    isConnected,
    address,
    employees,
    mySalaryBlock,
    lookupAddr,
    setLookupAddr,
    lookupRole,
    refreshRole: roleResult.refetch,
  };
}
