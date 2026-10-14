"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return <button className="btn btn-sm btn-ghost" disabled={busy} onClick={async () => {
    setBusy(true);
    try { await authClient.signOut(); router.push("/login"); router.refresh(); } finally { setBusy(false); }
  }}>
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>
    {busy ? "กำลังออก…" : "ออกจากระบบ"}
  </button>;
}
