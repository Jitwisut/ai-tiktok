"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
export function SignOut() {
  const router = useRouter();
  return <button className="rounded border border-slate-700 px-3 py-2 text-sm" onClick={async () => { await authClient.signOut(); router.push("/login"); router.refresh(); }}>ออกจากระบบ</button>;
}
