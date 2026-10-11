"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  return <section className="mx-auto mt-14 max-w-md rounded-xl border p-6">
    <h1 className="mb-2 text-2xl font-semibold">เข้าสู่ระบบแอดมิน License</h1>
    <p className="mb-6 text-sm text-muted-foreground">สำหรับผู้ดูแลระบบออกคีย์และเติมวันใช้งาน</p>
    <form className="flex flex-col gap-4" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError("");
      try {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) setError("เข้าสู่ระบบไม่สำเร็จ ตรวจอีเมลและรหัสผ่านแล้วลองใหม่");
        else { router.push("/admin/licenses"); router.refresh(); }
      } catch { setError("ติดต่อระบบไม่ได้ กรุณาลองอีกครั้ง"); }
      finally { setBusy(false); }
    }}>
      <label>อีเมล<input className="rounded border bg-background p-3" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>รหัสผ่าน<input className="rounded border bg-background p-3" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
      <button className="rounded bg-primary p-3 font-semibold text-primary-foreground disabled:opacity-50" disabled={busy}>{busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</button>
    </form>
  </section>;
}
