"use client";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LicenseCommand } from "@/services/license.service";
import { isValidLicenseDays, LIFETIME_DAYS, LIFETIME_DISPLAY_DAYS, MAX_LICENSE_DAYS } from "@/lib/licensing/limits";

type Status = "pending" | "active" | "expired" | "suspended";
type Row = {
  id: string; keyHint: string; durationDays: number; status: Status; suspended: boolean; expiresAt: string | null; createdAt: string;
  customer: { name: string; contact: string | null };
  activation: { installationId: string; createdAt: string; lastSeenAt: string } | null;
};
type Event = { id: string; actorId: string; action: string; days: number | null; note: string | null; createdAt: string; previousExpiry: string | null; newExpiry: string | null };
type RowAction = "extend" | "suspend" | "restore" | "rotate";
type Toast = { text: string; tone: "success" | "error" | "info" };

const DAY_MS = 86_400_000;
const statusLabels: Record<Status, string> = { pending: "รอเปิดใช้", active: "ใช้งานได้", expired: "หมดอายุ", suspended: "ระงับ" };
const actionLabels: Record<string, string> = { create: "ออกคีย์", extend: "เติมวัน", suspend: "ระงับสิทธิ์", restore: "คืนสิทธิ์", rotate: "เปลี่ยนคีย์ / ย้ายเครื่อง", activate: "เปิดใช้ครั้งแรก" };
const presets = [
  { days: 1, label: "1 วัน" }, { days: 7, label: "7 วัน" }, { days: 30, label: "30 วัน" },
  { days: 90, label: "90 วัน" }, { days: 365, label: "1 ปี" }, { days: LIFETIME_DAYS, label: "ถาวร" },
];
const filters: { id: Status | "all"; label: string }[] = [
  { id: "all", label: "ทั้งหมด" }, { id: "active", label: "ใช้งานได้" }, { id: "pending", label: "รอเปิดใช้" },
  { id: "expired", label: "หมดอายุ" }, { id: "suspended", label: "ระงับ" },
];

const num = (n: number) => n.toLocaleString("th-TH");
const isLifetimeDays = (days: number) => days >= LIFETIME_DISPLAY_DAYS;
const daysLabel = (days: number) => isLifetimeDays(days) ? "ถาวร" : `${num(days)} วัน`;
const formatDate = (value: string | number) => new Date(value).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const isLifetimeDate = (value: string | number, now: number) => new Date(value).getTime() - now > LIFETIME_DISPLAY_DAYS * DAY_MS;
function span(ms: number) {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(minutes / 1440); const hours = Math.floor(minutes % 1440 / 60);
  if (days >= 3) return `${num(days)} วัน`;
  if (days >= 1) return `${days} วัน ${hours} ชม.`;
  if (hours >= 1) return `${hours} ชม. ${minutes % 60} นาที`;
  return `${Math.max(1, minutes)} นาที`;
}
const daysError = (text: string) => !text.trim() ? "ใส่จำนวนวัน"
  : !isValidLicenseDays(Number(text)) ? `ใส่ได้ 1–${num(MAX_LICENSE_DAYS)} วัน — ถ้าต้องการไม่จำกัด เลือก "ถาวร"` : "";

// A coarse shared clock keeps relative times fresh without re-rendering every second.
const subscribeClock = (tick: () => void) => { const id = setInterval(tick, 30_000); return () => clearInterval(id); };
function useNow() { return useSyncExternalStore(subscribeClock, () => Math.floor(Date.now() / 30_000) * 30_000, () => null); }

export function LicenseAdmin({ initialLicenses }: { initialLicenses: Row[] }) {
  const now = useNow();
  const [rows, setRows] = useState(initialLicenses);
  const [query, setQuery] = useState(""); const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [name, setName] = useState(""); const [contact, setContact] = useState("");
  const [daysText, setDaysText] = useState("30"); const [note, setNote] = useState("");
  const [dialog, setDialog] = useState<{ action: RowAction; row: Row } | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [events, setEvents] = useState<Event[] | "error" | null>(null);
  const [issued, setIssued] = useState<{ key: string; customer: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep the exact submission for retry after a lost response. Never create a new request ID on retry.
  const [pending, setPending] = useState<LicenseCommand | null>(null);
  const searchSeq = useRef(0);

  const notify = (text: string, tone: Toast["tone"] = "success") => setToast({ text, tone });
  useEffect(() => {
    if (!toast || toast.tone === "error") return;
    const id = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(id);
  }, [toast]);

  async function load(q: string) {
    const seq = ++searchSeq.current;
    const term = q.trim().startsWith("AAS_") ? q.trim().slice(-8) : q;
    const response = await fetch(`/api/admin/licenses?q=${encodeURIComponent(term)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("โหลดสิทธิ์ไม่สำเร็จ");
    const next: Row[] = (await response.json()).licenses;
    if (seq === searchSeq.current) setRows(next);
    return next;
  }
  const searchFor = useEffectEvent((q: string) => {
    setSearching(true);
    load(q).catch(() => notify("ค้นหาไม่สำเร็จ ลองอีกครั้ง", "error")).finally(() => setSearching(false));
  });
  const lastQuery = useRef(query);
  useEffect(() => {
    if (query === lastQuery.current) return;
    lastQuery.current = query;
    const id = setTimeout(() => searchFor(query), 280);
    return () => clearTimeout(id);
  }, [query]);

  async function openHistory(row: Row) {
    setSelected(row); setEvents(null);
    try {
      const response = await fetch(`/api/admin/licenses?licenseId=${encodeURIComponent(row.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("โหลดประวัติไม่สำเร็จ");
      setEvents((await response.json()).events);
    } catch { setEvents("error"); }
  }

  async function submit(command: LicenseCommand) {
    setBusy(true); setPending(command); setToast(null);
    try {
      const response = await fetch("/api/admin/licenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status < 500) setPending(null);
        throw new Error(`ดำเนินการไม่สำเร็จ (${result.code ?? response.status})`);
      }
      setPending(null);
      if (result.key) setIssued({ key: result.key, customer: result.license?.customer?.name ?? "" });
      if (command.action === "create" && !result.replayed) { setName(""); setContact(""); setNote(""); }
      notify(result.replayed ? "คำขอนี้ดำเนินการแล้ว ไม่เติมวันซ้ำ — หากไม่ได้รับคีย์ให้ใช้ \"เปลี่ยนคีย์\"" : `${actionLabels[command.action]}เรียบร้อย`, result.replayed ? "info" : "success");
      const next = await load(query);
      const fresh = selected && next.find(row => row.id === selected.id);
      if (fresh && result.license?.id === fresh.id) void openHistory(fresh);
    } catch (error) { notify(error instanceof Error ? error.message : "ติดต่อระบบไม่ได้", "error"); }
    finally { setBusy(false); }
  }

  const locked = busy || !!pending || !!issued;
  const createError = daysError(daysText);
  const counts = useMemo(() => rows.reduce((acc, row) => ({ ...acc, [row.status]: acc[row.status] + 1 }), { all: rows.length, active: 0, pending: 0, expired: 0, suspended: 0 } as Record<Status | "all", number>), [rows]);
  const visible = filter === "all" ? rows : rows.filter(row => row.status === filter);

  return <div className="flex flex-col gap-6">
    <header className="animate-rise flex flex-col gap-3">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">จัดการ License</h1>
      <ul className="flex flex-wrap gap-2 text-xs text-muted">
        {["1 คีย์ ต่อ 1 Chrome Profile", "เริ่มนับเมื่อเปิดใช้ครั้งแรก", "1 วัน = 24 ชั่วโมง", "เวลาไทย (UTC+7)"].map(rule =>
          <li key={rule} className="rounded-full border border-line bg-white/[0.02] px-3 py-1">{rule}</li>)}
      </ul>
    </header>

    {/* ── Issue a key ─────────────────────────────── */}
    <section className="card animate-rise p-5 sm:p-6" aria-labelledby="issue-title">
      <div className="mb-5 flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary"><Icon name="plus" /></span>
        <div><h2 id="issue-title" className="font-semibold">ออกคีย์ใหม่</h2><p className="text-xs text-muted">คีย์แสดงเต็มเพียงครั้งเดียวหลังออก</p></div>
      </div>
      <form className="grid gap-5" onSubmit={event => {
        event.preventDefault();
        if (createError || locked) return;
        void submit({ requestId: crypto.randomUUID(), action: "create", name, contact, days: Number(daysText), note });
      }}>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="field-label">ชื่อลูกค้า<input className="input" required maxLength={160} placeholder="เช่น คุณนิด" value={name} onChange={e => setName(e.target.value)} /></label>
          <label className="field-label">ช่องทางติดต่อ<input className="input" maxLength={200} placeholder="LINE / Facebook / เบอร์โทร" value={contact} onChange={e => setContact(e.target.value)} /></label>
          <label className="field-label">หมายเหตุ / การรับเงิน<input className="input" maxLength={1000} placeholder="เช่น โอน 299 บาท 13/10" value={note} onChange={e => setNote(e.target.value)} /></label>
        </div>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <DurationPicker id="create-days" value={daysText} onChange={setDaysText} error={createError} />
          <button className="btn btn-primary btn-lg w-full lg:w-auto" disabled={locked || !!createError}>
            {busy && pending?.action === "create" ? <span className="spinner" aria-hidden /> : <Icon name="key" />}{createError ? "ออกคีย์" : isLifetimeDays(Number(daysText)) ? "ออกคีย์ถาวร" : `ออกคีย์ ${daysLabel(Number(daysText))}`}
          </button>
        </div>
      </form>
    </section>

    {/* ── One-time key reveal ─────────────────────── */}
    {issued && <KeyReveal issued={issued} onCopied={ok => notify(ok ? "คัดลอกคีย์แล้ว" : "คัดลอกไม่สำเร็จ เลือกคีย์แล้วคัดลอกเอง", ok ? "success" : "error")} onClose={() => setIssued(null)} />}

    {pending && !busy && <div role="alert" className="animate-pop flex flex-col gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-amber-100"><b className="font-semibold">คำขอล่าสุดยังไม่ได้รับคำตอบ</b> — ส่งคำขอเดิมซ้ำได้อย่างปลอดภัย ระบบจะไม่เติมวันซ้ำ</p>
      <button className="btn btn-sm border-amber-300/40 text-amber-100" onClick={() => void submit(pending)}><Icon name="refresh" />ลองส่งอีกครั้ง</button>
    </div>}

    {/* ── Licenses ────────────────────────────────── */}
    <section className="card animate-rise overflow-hidden" aria-label="รายการ License">
      <div className="flex flex-col gap-4 border-b border-line p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div role="tablist" aria-label="กรองตามสถานะ" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:pb-0">
          {filters.map(f => <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
            className={`flex h-9 shrink-0 items-center gap-2 rounded-xl px-3 text-sm transition ${filter === f.id ? "bg-white/[0.08] text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]" : "text-muted hover:bg-white/[0.04] hover:text-ink"}`}>
            {f.id !== "all" && <span className={`size-1.5 rounded-full ${dotClass[f.id]}`} />}{f.label}
            <span className="rounded-md bg-white/[0.06] px-1.5 text-xs tabular-nums text-muted">{counts[f.id]}</span>
          </button>)}
        </div>
        <div className="relative lg:w-80">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint">{searching ? <span className="spinner block !size-4 !border-white/20 !border-t-white/70" /> : <Icon name="search" />}</span>
          <input className="input !h-10 !pl-10 !pr-9" type="search" placeholder="ค้นหาชื่อ ช่องทางติดต่อ หรือคีย์" value={query} onChange={e => setQuery(e.target.value)} aria-label="ค้นหา License" />
          {query && <button className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-faint hover:bg-white/10 hover:text-ink" onClick={() => setQuery("")} aria-label="ล้างคำค้นหา"><Icon name="x" /></button>}
        </div>
      </div>

      {visible.length === 0 ? <EmptyState searching={!!query.trim()} filtered={filter !== "all"} /> : <>
        {/* Desktop table */}
        <div className="hidden overflow-x-auto lg:block">
          <table className="data-table">
            <thead><tr><th>ลูกค้า</th><th>คีย์</th><th>สถานะ</th><th>อายุการใช้งาน</th><th>เครื่องที่ผูก</th><th>จัดการ</th></tr></thead>
            <tbody>{visible.map((row, i) => <tr key={row.id} style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
              <td><Customer row={row} /></td>
              <td><code className="rounded-lg bg-white/[0.04] px-2 py-1 font-mono text-xs text-muted">…{row.keyHint}</code></td>
              <td><StatusBadge row={row} now={now} /></td>
              <td><Lifetime row={row} now={now} /></td>
              <td><Device row={row} now={now} /></td>
              <td><div className="flex justify-end gap-1.5"><RowActions row={row} locked={locked} onAction={action => setDialog({ action, row })} onHistory={() => void openHistory(row)} /></div></td>
            </tr>)}</tbody>
          </table>
        </div>
        {/* Mobile cards */}
        <ul className="divide-y divide-line lg:hidden">
          {visible.map((row, i) => <li key={row.id} className="animate-rise flex flex-col gap-4 p-4" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
            <div className="flex items-start justify-between gap-3"><Customer row={row} /><StatusBadge row={row} now={now} /></div>
            <dl className="grid grid-cols-2 gap-3 rounded-xl bg-white/[0.02] p-3 text-sm">
              <div><dt className="mb-1 text-xs text-faint">อายุการใช้งาน</dt><dd><Lifetime row={row} now={now} /></dd></div>
              <div><dt className="mb-1 text-xs text-faint">เครื่องที่ผูก</dt><dd><Device row={row} now={now} /></dd></div>
              <div className="col-span-2"><dt className="sr-only">คีย์</dt><dd><code className="font-mono text-xs text-muted">คีย์ …{row.keyHint}</code></dd></div>
            </dl>
            <div className="grid grid-cols-2 gap-2 sm:flex"><RowActions row={row} locked={locked} onAction={action => setDialog({ action, row })} onHistory={() => void openHistory(row)} /></div>
          </li>)}
        </ul>
      </>}
      <p className="border-t border-line px-5 py-3 text-xs text-faint">แสดงล่าสุดสูงสุด 100 คีย์ • ใช้การค้นหาเพื่อหารายการที่เก่ากว่านั้น</p>
    </section>

    {dialog && <ActionDialog key={`${dialog.action}:${dialog.row.id}`} {...dialog} now={now} onClose={() => setDialog(null)} onConfirm={(days, actionNote) => {
      const { action, row } = dialog; setDialog(null);
      void submit({ requestId: crypto.randomUUID(), action, licenseId: row.id, ...(action === "extend" ? { days } : {}), note: actionNote });
    }} />}
    {selected && <HistoryDrawer row={selected} events={events} now={now} onRetry={() => void openHistory(selected)} onClose={() => setSelected(null)} />}
    {toast && <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4" role="status" aria-live="polite">
      <div className={`animate-pop pointer-events-auto flex max-w-lg items-center gap-3 rounded-2xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-xl ${toastClass[toast.tone]}`}>
        <Icon name={toast.tone === "error" ? "alert" : toast.tone === "info" ? "info" : "check"} />
        <span>{toast.text}</span>
        <button className="-mr-1 ml-1 grid size-7 shrink-0 place-items-center rounded-lg opacity-70 hover:bg-white/10 hover:opacity-100" onClick={() => setToast(null)} aria-label="ปิดการแจ้งเตือน"><Icon name="x" /></button>
      </div>
    </div>}
  </div>;
}

const dotClass: Record<Status, string> = { active: "bg-emerald-400", pending: "bg-amber-300", expired: "bg-rose-400", suspended: "bg-slate-400" };
const toastClass: Record<Toast["tone"], string> = {
  success: "border-emerald-400/30 bg-[#0c1a16]/90 text-emerald-100",
  error: "border-rose-400/30 bg-[#1f0d12]/90 text-rose-100",
  info: "border-sky-400/30 bg-[#0b1620]/90 text-sky-100",
};

function DurationPicker({ id, value, onChange, error }: { id: string; value: string; onChange: (value: string) => void; error: string }) {
  const days = Number(value);
  const isPreset = presets.some(p => p.days === days);
  return <fieldset className="flex min-w-0 flex-col gap-2">
    <legend className="mb-2 text-[0.8125rem] font-medium text-muted">ระยะเวลา</legend>
    <div className="flex flex-wrap items-center gap-2">
      {presets.map(p => <button key={p.days} type="button" className="chip" aria-pressed={days === p.days} onClick={() => onChange(String(p.days))}>{p.label}</button>)}
      <div className="relative">
        <input id={id} className={`input !h-9 !w-36 !rounded-full !pr-12 ${!isPreset && value ? "!border-primary" : ""}`} type="number" inputMode="numeric" min={1} max={MAX_LICENSE_DAYS} step={1}
          placeholder="กำหนดเอง" aria-label="จำนวนวันแบบกำหนดเอง" aria-invalid={!!error} aria-describedby={`${id}-hint`}
          value={value} onChange={e => onChange(e.target.value.replace(/\D/g, "").slice(0, 7))} />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs text-faint">วัน</span>
      </div>
    </div>
    <p id={`${id}-hint`} className={`text-xs ${error ? "text-rose-300" : "text-faint"}`} aria-live="polite">
      {error ? <>{error} {value && Number(value) > MAX_LICENSE_DAYS && <button type="button" className="ml-1 font-medium text-primary-2 underline-offset-2 hover:underline" onClick={() => onChange(String(LIFETIME_DAYS))}>ใช้ &quot;ถาวร&quot; แทน</button>}</>
        : isLifetimeDays(days) ? `ถาวร = ${num(days)} วัน (ราว 100 ปี)` : `≈ ${days >= 365 ? `${(days / 365).toLocaleString("th-TH", { maximumFractionDigits: 1 })} ปี` : days >= 30 ? `${(days / 30).toLocaleString("th-TH", { maximumFractionDigits: 1 })} เดือน` : `${num(days * 24)} ชั่วโมง`}`}
    </p>
  </fieldset>;
}

function KeyReveal({ issued, onCopied, onClose }: { issued: { key: string; customer: string }; onCopied: (ok: boolean) => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return <section role="status" className="animate-pop relative overflow-hidden rounded-[20px] p-px [background:linear-gradient(135deg,#34d399,#3ad6f0,#8b7bff)]">
    <div className="rounded-[19px] bg-[#0a1014] p-5 sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-400/15 text-emerald-300"><Icon name="check" /></span>
        <div>
          <h2 className="font-semibold">ออกคีย์{issued.customer ? `ให้ ${issued.customer}` : ""}แล้ว</h2>
          <p className="text-sm text-muted">คีย์นี้แสดงเต็มเพียงครั้งเดียว คัดลอกส่งให้ลูกค้าก่อนปิด</p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className="input flex-1 !h-12 font-mono !text-sm tracking-wide text-emerald-100" readOnly value={issued.key} aria-label="License Key ใหม่" onFocus={e => e.currentTarget.select()} />
        <button className={`btn btn-lg ${copied ? "btn-success" : "btn-primary"}`} onClick={() => {
          void navigator.clipboard.writeText(issued.key).then(() => { setCopied(true); onCopied(true); }).catch(() => onCopied(false));
        }}><Icon name={copied ? "check" : "copy"} />{copied ? "คัดลอกแล้ว" : "คัดลอกคีย์"}</button>
      </div>
      <div className="mt-4 flex justify-end"><button className="btn btn-sm btn-ghost" onClick={onClose}>{copied ? "เก็บคีย์แล้ว — ปิด" : "ปิดโดยไม่คัดลอก"}</button></div>
    </div>
  </section>;
}

function Customer({ row }: { row: Row }) {
  const contact = row.customer.contact;
  const href = contact && /^https?:\/\//i.test(contact) ? contact : null;
  const hue = [...row.customer.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return <div className="flex min-w-0 items-center gap-3">
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white/90" style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 55% / .85), hsl(${(hue + 50) % 360} 70% 45% / .85))` }}>{[...row.customer.name.trim()][0]?.toUpperCase() ?? "?"}</span>
    <div className="min-w-0">
      <p className="truncate font-medium">{row.customer.name}</p>
      {contact && (href
        ? <a href={href} target="_blank" rel="noopener noreferrer" className="block max-w-56 truncate text-xs text-muted hover:text-primary-2">{contact.replace(/^https?:\/\/(www\.)?/i, "")}</a>
        : <p className="max-w-56 truncate text-xs text-muted">{contact}</p>)}
    </div>
  </div>;
}

function StatusBadge({ row, now }: { row: Row; now: number | null }) {
  const lapsed = row.status === "suspended" && !!row.expiresAt && now !== null && new Date(row.expiresAt).getTime() <= now;
  return <span className="inline-flex flex-col items-start gap-1"><span className={`badge badge-${row.status}`}>{statusLabels[row.status]}</span>{lapsed && <span className="text-[11px] text-rose-300/80">และหมดอายุแล้ว</span>}</span>;
}

function Lifetime({ row, now }: { row: Row; now: number | null }) {
  if (!row.expiresAt) return <div className="leading-snug"><p>{daysLabel(row.durationDays)}</p><p className="text-xs text-faint">เริ่มนับเมื่อเปิดใช้</p></div>;
  if (now !== null && isLifetimeDate(row.expiresAt, now)) return <div className="leading-snug"><p className="font-medium text-primary-2">ถาวร</p><p className="text-xs text-faint">ไม่มีวันหมดอายุ</p></div>;
  const left = now === null ? null : new Date(row.expiresAt).getTime() - now;
  return <div className="leading-snug">
    <p className="whitespace-nowrap">{formatDate(row.expiresAt)}</p>
    {left !== null && <p className={`text-xs ${left <= 0 ? "text-rose-300" : left < 3 * DAY_MS ? "text-amber-300" : "text-faint"}`}>{left <= 0 ? `หมดไปแล้ว ${span(left)}` : `เหลือ ${span(left)}`}</p>}
  </div>;
}

function Device({ row, now }: { row: Row; now: number | null }) {
  if (!row.activation) return <span className="text-sm text-faint">ยังไม่ผูก</span>;
  const seen = now === null ? null : now - new Date(row.activation.lastSeenAt).getTime();
  return <div className="leading-snug" title={`Installation ID: ${row.activation.installationId}`}>
    <p className="whitespace-nowrap text-sm">ผูกเมื่อ {formatDate(row.activation.createdAt)}</p>
    <p className="whitespace-nowrap text-xs text-faint">ใช้งานล่าสุด {seen === null ? formatDate(row.activation.lastSeenAt) : seen < 120_000 ? "เมื่อสักครู่" : `${span(seen)}ที่แล้ว`}</p>
  </div>;
}

function RowActions({ row, locked, onAction, onHistory }: { row: Row; locked: boolean; onAction: (action: RowAction) => void; onHistory: () => void }) {
  return <>
    <button className="btn btn-sm btn-primary !h-[2.125rem]" disabled={locked} onClick={() => onAction("extend")}><Icon name="plus" />เติมวัน</button>
    {row.suspended
      ? <button className="btn btn-sm btn-success" disabled={locked} onClick={() => onAction("restore")}><Icon name="play" />คืนสิทธิ์</button>
      : <button className="btn btn-sm" disabled={locked} onClick={() => onAction("suspend")}><Icon name="pause" />ระงับ</button>}
    <button className="btn btn-sm" disabled={locked} onClick={() => onAction("rotate")} title="ออกคีย์ใหม่และยกเลิกเครื่องเดิม — วันหมดอายุคงเดิม"><Icon name="swap" />เปลี่ยนคีย์</button>
    <button className="btn btn-sm btn-ghost" onClick={onHistory} title="ประวัติ"><Icon name="clock" /><span className="lg:sr-only">ประวัติ</span></button>
  </>;
}

function Overlay({ onClose, children, side }: { onClose: () => void; children: React.ReactNode; side?: boolean }) {
  const onKey = useEffectEvent((event: KeyboardEvent) => { if (event.key === "Escape") onClose(); });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", handler);
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", handler); document.body.style.overflow = overflow; };
  }, []);
  return <div className={`fixed inset-0 z-40 flex ${side ? "justify-end" : "items-end justify-center p-0 sm:items-center sm:p-4"}`}>
    <div className="animate-fade absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
    {children}
  </div>;
}

function ActionDialog({ action, row, now, onClose, onConfirm }: { action: RowAction; row: Row; now: number | null; onClose: () => void; onConfirm: (days: number, note: string) => void }) {
  const [daysText, setDaysText] = useState("30"); const [note, setNote] = useState("");
  const error = action === "extend" ? daysError(daysText) : "";
  const days = Number(daysText);
  const copy = {
    extend: { title: "เติมวันใช้งาน", body: "เวลาที่เหลืออยู่จะไม่หาย ระบบต่อจากวันหมดอายุเดิม (หรือจากตอนนี้ถ้าหมดอายุแล้ว)", confirm: error ? "เติมวัน" : isLifetimeDays(days) ? "เปลี่ยนเป็นถาวร" : `เติม ${daysLabel(days)}`, tone: "btn-primary", icon: "plus" },
    suspend: { title: "ระงับสิทธิ์ชั่วคราว", body: "ลูกค้าจะใช้งานไม่ได้ทันที และวันใช้งานยังเดินต่อระหว่างระงับ คืนสิทธิ์ได้ทุกเมื่อ", confirm: "ระงับสิทธิ์", tone: "btn-danger", icon: "pause" },
    restore: { title: "คืนสิทธิ์การใช้งาน", body: row.expiresAt && now !== null && new Date(row.expiresAt).getTime() <= now
      ? `คีย์นี้หมดอายุไปแล้วตั้งแต่ ${formatDate(row.expiresAt)} — คืนสิทธิ์แล้วจะยังใช้งานไม่ได้ ต้อง "เติมวัน" เพิ่มด้วย`
      : "ลูกค้าจะกลับมาใช้งานได้ตามวันหมดอายุเดิม", confirm: "คืนสิทธิ์", tone: "btn-success", icon: "play" },
    rotate: { title: "เปลี่ยนคีย์ / ย้ายเครื่อง", body: "คีย์เดิมและเครื่องที่ผูกไว้จะถูกยกเลิกทันที แล้วออกคีย์ใหม่ให้ วันหมดอายุคงเดิม", confirm: "ยกเลิกคีย์เดิม แล้วออกคีย์ใหม่", tone: "btn-danger", icon: "swap" },
  }[action] as { title: string; body: string; confirm: string; tone: string; icon: IconName };
  let preview: string | null = null;
  if (action === "extend" && !error) {
    if (!row.expiresAt) preview = `รวมเป็น ${daysLabel(row.durationDays + days)} — เริ่มนับเมื่อลูกค้าเปิดใช้`;
    else if (now !== null) {
      const next = Math.max(new Date(row.expiresAt).getTime(), now) + days * DAY_MS;
      preview = isLifetimeDate(next, now) ? "หมดอายุใหม่: ถาวร" : `หมดอายุใหม่: ${formatDate(next)}`;
    }
  }
  return <Overlay onClose={onClose}>
    <form role="dialog" aria-modal="true" aria-labelledby="action-title" className="card animate-pop relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-b-none !bg-[#0e131d] p-6 sm:rounded-b-[20px]"
      onSubmit={event => { event.preventDefault(); if (!error) onConfirm(days, note); }}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 id="action-title" className="text-lg font-semibold">{copy.title}</h2>
          <p className="mt-0.5 text-sm text-muted">{row.customer.name} • คีย์ …{row.keyHint}</p>
        </div>
        <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg text-faint hover:bg-white/10 hover:text-ink" onClick={onClose} aria-label="ปิด"><Icon name="x" /></button>
      </div>
      <p className={`mb-5 rounded-xl border px-3.5 py-3 text-sm ${action === "rotate" || action === "suspend" ? "border-rose-400/25 bg-rose-400/[0.06] text-rose-100" : "border-line bg-white/[0.02] text-muted"}`}>{copy.body}</p>
      <div className="flex flex-col gap-4">
        {action === "extend" && <DurationPicker id="extend-days" value={daysText} onChange={setDaysText} error={error} />}
        {preview && <p className="animate-fade flex items-center gap-2 text-sm text-primary-2"><Icon name="calendar" />{preview}</p>}
        <label className="field-label">หมายเหตุ / การรับเงิน <span className="sr-only">(ไม่บังคับ)</span>
          <input className="input" maxLength={1000} placeholder="ไม่บังคับ" value={note} onChange={e => setNote(e.target.value)} autoFocus={action !== "extend"} />
        </label>
      </div>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn" onClick={onClose}>ยกเลิก</button>
        <button className={`btn ${copy.tone}`} disabled={!!error}><Icon name={copy.icon} />{copy.confirm}</button>
      </div>
    </form>
  </Overlay>;
}

function HistoryDrawer({ row, events, now, onRetry, onClose }: { row: Row; events: Event[] | "error" | null; now: number | null; onRetry: () => void; onClose: () => void }) {
  const expiry = (value: string | null) => !value ? "ยังไม่เริ่มนับ" : now !== null && isLifetimeDate(value, now) ? "ถาวร" : formatDate(value);
  return <Overlay onClose={onClose} side>
    <aside role="dialog" aria-modal="true" aria-labelledby="history-title" className="animate-slide-in relative flex h-full w-full max-w-md flex-col border-l border-line bg-[#0b0f17] shadow-2xl">
      <header className="flex items-start justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0">
          <p className="text-xs text-faint">ประวัติการดำเนินการ</p>
          <h2 id="history-title" className="truncate text-lg font-semibold">{row.customer.name}</h2>
          <div className="mt-2 flex items-center gap-2"><StatusBadge row={row} now={now} /><code className="font-mono text-xs text-muted">…{row.keyHint}</code></div>
        </div>
        <button className="grid size-8 shrink-0 place-items-center rounded-lg text-faint hover:bg-white/10 hover:text-ink" onClick={onClose} aria-label="ปิด" autoFocus><Icon name="x" /></button>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {events === null ? <div className="flex flex-col gap-4" aria-label="กำลังโหลด">{[0, 1, 2].map(i => <div key={i} className="skeleton-shimmer h-16 rounded-xl" />)}</div>
          : events === "error" ? <div className="flex flex-col items-center gap-3 py-10 text-center"><p className="text-sm text-rose-200">โหลดประวัติไม่สำเร็จ</p><button className="btn btn-sm" onClick={onRetry}><Icon name="refresh" />ลองอีกครั้ง</button></div>
          : events.length === 0 ? <p className="py-10 text-center text-sm text-faint">ยังไม่มีประวัติ</p>
          : <ol className="relative flex flex-col gap-5 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-line">
            {events.map((event, i) => <li key={event.id} className="animate-rise relative flex gap-4" style={{ animationDelay: `${i * 30}ms` }}>
              <span className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-full border ${eventTone[event.action] ?? "border-line bg-[#121826] text-muted"}`}><Icon name={eventIcon[event.action] ?? "dot"} /></span>
              <div className="min-w-0 flex-1 pb-1">
                <p className="font-medium">{actionLabels[event.action] ?? event.action}{event.days ? <span className="ml-1.5 text-primary-2">+{daysLabel(event.days)}</span> : null}</p>
                <p className="text-xs text-faint">{formatDate(event.createdAt)}</p>
                {event.note && <p className="mt-2 rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-muted">{event.note}</p>}
                {(event.previousExpiry || event.newExpiry) && event.previousExpiry !== event.newExpiry && <p className="mt-2 text-xs text-muted">หมดอายุ: {expiry(event.previousExpiry)} → <span className="text-ink">{expiry(event.newExpiry)}</span></p>}
                <p className="mt-1 truncate text-[11px] text-faint" title={event.actorId}>โดย {event.actorId.startsWith("installation:") ? "เครื่องลูกค้า" : `แอดมิน ${event.actorId.slice(0, 8)}…`}</p>
              </div>
            </li>)}
          </ol>}
      </div>
    </aside>
  </Overlay>;
}
const eventIcon: Record<string, IconName> = { create: "key", extend: "plus", suspend: "pause", restore: "play", rotate: "swap", activate: "bolt" };
const eventTone: Record<string, string> = {
  create: "border-primary/40 bg-primary/15 text-primary", extend: "border-sky-400/40 bg-sky-400/10 text-sky-300",
  suspend: "border-slate-400/40 bg-slate-400/10 text-slate-300", restore: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  rotate: "border-amber-400/40 bg-amber-400/10 text-amber-300", activate: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
};

function EmptyState({ searching, filtered }: { searching: boolean; filtered: boolean }) {
  return <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
    <span className="grid size-12 place-items-center rounded-2xl border border-line bg-white/[0.03] text-faint"><Icon name={searching ? "search" : "key"} /></span>
    <p className="font-medium">{searching ? "ไม่พบผลลัพธ์" : filtered ? "ไม่มีคีย์ในสถานะนี้" : "ยังไม่มี License"}</p>
    <p className="max-w-sm text-sm text-faint">{searching ? "ลองค้นหาด้วยชื่อ ช่องทางติดต่อ หรือ 8 ตัวท้ายของคีย์" : "ออกคีย์แรกจากฟอร์มด้านบน แล้วส่งให้ลูกค้า"}</p>
  </div>;
}

type IconName = "plus" | "key" | "search" | "x" | "check" | "copy" | "alert" | "info" | "refresh" | "pause" | "play" | "swap" | "clock" | "calendar" | "bolt" | "dot";
const iconPaths: Record<IconName, string> = {
  plus: "M12 5v14M5 12h14",
  key: "M7.5 11a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9M10.7 12.3 20 3M17 6l3 3M14 9l2 2",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  copy: "M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1zM16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0",
  info: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M12 16v-4M12 8h.01",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
  pause: "M10 4H6v16h4zM18 4h-4v16h4z",
  play: "M6 4l14 8-14 8z",
  swap: "M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16",
  clock: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M12 6v6l4 2",
  calendar: "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9z",
  dot: "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4",
};
function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={iconPaths[name]} /></svg>;
}
