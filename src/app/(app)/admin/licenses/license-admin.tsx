"use client";
import { useState } from "react";
import type { LicenseCommand } from "@/services/license.service";

type Row = { id: string; keyHint: string; durationDays: number; status: string; suspended: boolean; expiresAt: string | null; customer: { name: string; contact: string | null }; activation: { installationId: string; lastSeenAt: string } | null };
type Event = { id: string; actorId: string; action: string; days: number | null; note: string | null; createdAt: string; previousExpiry: string | null; newExpiry: string | null };
const labels: Record<string, string> = { pending: "รอเปิดใช้", active: "ใช้งานได้", expired: "หมดอายุ", suspended: "ระงับ", create: "ออกคีย์", extend: "เติมวัน", suspend: "ระงับ", restore: "คืนสิทธิ์", rotate: "เปลี่ยนคีย์ / ย้ายเครื่อง", activate: "เปิดใช้ครั้งแรก" };
const date = (value: string | null) => value ? new Date(value).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "ยังไม่เริ่มนับวัน";
const field = "rounded border bg-background px-3 py-2";
const button = `${field} cursor-pointer disabled:opacity-50`;
export function LicenseAdmin({ initialLicenses }: { initialLicenses: Row[] }) {
  const [rows, setRows] = useState(initialLicenses);
  const [query, setQuery] = useState("");
  const [name, setName] = useState(""); const [contact, setContact] = useState("");
  const [days, setDays] = useState(30); const [note, setNote] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  // Keep the exact submission for retry after a lost response. Never create a new request ID on retry.
  const [pending, setPending] = useState<LicenseCommand | null>(null);
  async function refresh() {
    const response = await fetch(`/api/admin/licenses?q=${encodeURIComponent(query.trim().startsWith("AAS_") ? query.trim().slice(-8) : query)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("โหลดสิทธิ์ไม่สำเร็จ");
    setRows((await response.json()).licenses);
  }
  async function history(row: Row) {
    setSelected(row); setEvents([]);
    try {
      const response = await fetch(`/api/admin/licenses?licenseId=${encodeURIComponent(row.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("โหลดประวัติไม่สำเร็จ");
      setEvents((await response.json()).events);
    } catch (error) { setMessage(error instanceof Error ? error.message : "โหลดประวัติไม่สำเร็จ"); }
  }
  async function submit(command: LicenseCommand) {
    setBusy(true); setPending(command); setMessage("");
    try {
      const response = await fetch("/api/admin/licenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) setPending(null);
        throw new Error(`ดำเนินการไม่สำเร็จ (${result.code ?? response.status})`);
      }
      setPending(null);
      if (result.key) setKey(result.key);
      setMessage(result.replayed ? "คำขอนี้ดำเนินการแล้ว ไม่เติมวันซ้ำ หากไม่ได้รับคีย์ให้ใช้เปลี่ยนคีย์ / ย้ายเครื่อง" : "บันทึกเรียบร้อย");
      await refresh();
      if (result.license && selected?.id === result.license.id) await history(result.license);
    } catch (error) { setMessage(error instanceof Error ? error.message : "ติดต่อระบบไม่ได้"); }
    finally { setBusy(false); }
  }
  function act(row: Row, action: LicenseCommand["action"]) {
    if (action === "rotate" && !window.confirm("ยกเลิกคีย์และการติดตั้งเดิม แล้วออกคีย์ใหม่โดยคงวันหมดอายุเดิม?")) return;
    void submit({ requestId: crypto.randomUUID(), action, licenseId: row.id, ...(action === "extend" ? { days } : {}), note });
  }
  const locked = busy || !!pending || !!key;
  return <div className="flex flex-col gap-5">
    <h1 className="text-2xl font-semibold">จัดการ License</h1>
    <p className="text-sm text-muted-foreground">หนึ่งคีย์ต่อหนึ่ง Chrome Profile • เริ่มนับเมื่อเปิดใช้ครั้งแรก • หนึ่งวัน = 24 ชั่วโมง • เวลาไทย</p>
    <form className="flex flex-wrap gap-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void submit({ requestId: crypto.randomUUID(), action: "create", name, contact, days, note }); }}>
      <label>ชื่อลูกค้า <input className={field} required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>ช่องทางติดต่อ <input className={field} maxLength={200} value={contact} onChange={e => setContact(e.target.value)} /></label>
      <label>จำนวนวัน <input className={`${field} w-24`} type="number" min={1} max={3650} required value={days} onChange={e => setDays(Number(e.target.value))} /></label>
      {[1, 7, 30].map(n => <button key={n} className={button} type="button" onClick={() => setDays(n)}>{n} วัน</button>)}
      <label>หมายเหตุ / การรับเงิน <input className={field} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label>
      <button className={`${button} bg-primary text-primary-foreground`} disabled={locked}>ออกคีย์</button>
      <p className="w-full text-sm text-muted-foreground">จำนวนวันและหมายเหตุด้านบนใช้กับการเติมวันในตารางด้วย</p>
    </form>
    {key && <section className="rounded-lg border border-green-600 p-4" role="status">
      <p>คีย์นี้แสดงเต็มเพียงครั้งเดียว คัดลอกเพื่อส่งให้ลูกค้าก่อนปิด</p>
      <input className={`${field} my-2 w-full font-mono`} readOnly value={key} aria-label="License Key ใหม่" />
      <button className={button} onClick={() => { void navigator.clipboard.writeText(key).then(() => setMessage("คัดลอกคีย์แล้ว")).catch(() => setMessage("คัดลอกไม่สำเร็จ เลือกคีย์แล้วคัดลอกเอง")); }}>คัดลอก</button>{" "}
      <button className={button} onClick={() => setKey(null)}>เก็บคีย์แล้ว / ปิด</button>
    </section>}
    <p role="status">{message}</p>
    {pending && !busy && <button className={button} onClick={() => void submit(pending)}>ลองส่งคำขอเดิมอีกครั้ง (ไม่เติมวันซ้ำ)</button>}
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setBusy(true); void refresh().catch(() => setMessage("ค้นหาไม่สำเร็จ")).finally(() => setBusy(false)); }}>
      <input className={`${field} flex-1`} placeholder="ค้นหาชื่อ ช่องทางติดต่อ หรือคีย์ / 8 ตัวท้าย" value={query} onChange={e => setQuery(e.target.value)} aria-label="ค้นหา License" />
      <button className={button} disabled={busy}>ค้นหา</button>
    </form>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["ลูกค้า", "คีย์ท้าย", "สถานะ", "หมดอายุ", "Profile", "จัดการ"].map(label => <th key={label} className="border-b p-2">{label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td className="border-b p-2">{row.customer.name}<br /><span className="text-muted-foreground">{row.customer.contact}</span></td>
        <td className="border-b p-2 font-mono">…{row.keyHint}</td><td className="border-b p-2">{labels[row.status]}</td>
        <td className="border-b p-2">{date(row.expiresAt)}{!row.expiresAt && ` (${row.durationDays} วัน)`}</td>
        <td className="border-b p-2">{row.activation ? <span title={row.activation.installationId}>เปิดใช้แล้ว<br />{date(row.activation.lastSeenAt)}</span> : "ยังไม่ผูก"}</td>
        <td className="border-b p-2"><div className="flex flex-wrap gap-1">
          <button className={button} disabled={locked || !Number.isInteger(days) || days < 1 || days > 3650} onClick={() => act(row, "extend")}>เติม {days} วัน</button>
          <button className={button} disabled={locked} onClick={() => act(row, row.suspended ? "restore" : "suspend")}>{row.suspended ? "คืนสิทธิ์" : "ระงับ"}</button>
          <button className={button} disabled={locked} onClick={() => act(row, "rotate")}>เปลี่ยนคีย์ / ย้ายเครื่อง</button>
          <button className={button} onClick={() => void history(row)}>ประวัติ</button>
        </div></td>
      </tr>)}</tbody></table>{rows.length === 0 && <p className="p-4">ยังไม่มีสิทธิ์ที่ตรงกับการค้นหา</p>}</div>
    <p className="text-sm text-muted-foreground">แสดงล่าสุดสูงสุด 100 คีย์ ใช้การค้นหาเพื่อค้นหารายการเก่า</p>
    {selected && <section className="rounded border p-4"><h2 className="font-semibold">ประวัติ — {selected.customer.name} / …{selected.keyHint}</h2>
      {events.map(event => <p className="border-b py-2 text-sm" key={event.id}>{date(event.createdAt)} • {labels[event.action] ?? event.action} {event.days ? `${event.days} วัน` : ""} • {event.note || "ไม่มีหมายเหตุ"}<br /><span className="text-muted-foreground">ผู้ดำเนินการ: {event.actorId} • หมดอายุ: {date(event.previousExpiry)} → {date(event.newExpiry)}</span></p>)}
    </section>}
  </div>;
}
