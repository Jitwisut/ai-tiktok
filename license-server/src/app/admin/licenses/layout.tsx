import { SignOut } from "./sign-out";
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <><nav className="mb-6 flex items-center justify-between border-b border-slate-700 pb-4"><span>AI Affiliate Studio • License</span><SignOut /></nav>{children}</>;
}
