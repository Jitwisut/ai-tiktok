import { SignOut } from "./sign-out";
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>
    <nav className="mb-8 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-[#8b7bff] to-[#3ad6f0] shadow-[0_8px_24px_-8px_rgb(139_123_255/0.8)]">
          <svg viewBox="0 0 24 24" className="size-5 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2" /></svg>
        </span>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-tight">AI Affiliate Studio</p>
          <p className="text-xs text-muted">License Console</p>
        </div>
      </div>
      <SignOut />
    </nav>
    {children}
  </>;
}
