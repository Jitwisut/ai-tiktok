"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  return <div className="grid min-h-[80dvh] place-items-center">
    <section className="card animate-pop w-full max-w-md p-7 sm:p-8">
      <span aria-hidden className="mb-6 grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-[#8b7bff] to-[#3ad6f0] shadow-[0_10px_30px_-8px_rgb(139_123_255/0.8)]">
        <svg viewBox="0 0 24 24" className="size-6 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2" /></svg>
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">เข้าสู่ระบบแอดมิน</h1>
      <p className="mb-7 mt-1.5 text-sm text-muted">ออกคีย์ เติมวัน และดูแลสิทธิ์ลูกค้า AI Affiliate Studio</p>
      <form className="flex flex-col gap-4" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError("");
        try {
          const result = await authClient.signIn.email({ email, password });
          if (result.error) setError("เข้าสู่ระบบไม่สำเร็จ ตรวจอีเมลและรหัสผ่านแล้วลองใหม่");
          else { router.push("/admin/licenses"); router.refresh(); }
        } catch { setError("ติดต่อระบบไม่ได้ กรุณาลองอีกครั้ง"); }
        finally { setBusy(false); }
      }}>
        <label className="field-label">อีเมล<input className="input" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label className="field-label">รหัสผ่าน<input className="input" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        {error && <p role="alert" className="animate-fade rounded-xl border border-rose-400/30 bg-rose-400/10 px-3.5 py-2.5 text-sm text-rose-200">{error}</p>}
        <button className="btn btn-primary btn-lg mt-2" disabled={busy}>{busy && <span className="spinner" aria-hidden />}{busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</button>
      </form>
    </section>
  </div>;
}
