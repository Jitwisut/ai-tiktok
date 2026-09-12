"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function NewProductPage() {
  return (
    <Suspense>
      <NewProductForm />
    </Suspense>
  );
}

function NewProductForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromExtension = searchParams.get("source") === "extension";

  const [name, setName] = useState(searchParams.get("name") ?? "");
  const [sourceUrl, setSourceUrl] = useState(searchParams.get("sourceUrl") ?? "");
  const [description, setDescription] = useState(searchParams.get("description") ?? "");
  const [price, setPrice] = useState(searchParams.get("price") ?? "");
  // The extension sends every product shot it found; the analysis reads all
  // of them, so keep more than the first.
  const [images] = useState<string[]>(() => {
    const extra = searchParams.get("images")?.split("|").filter(Boolean) ?? [];
    const primary = searchParams.get("image");
    return Array.from(new Set([primary, ...extra].filter((v): v is string => Boolean(v))));
  });
  const [importUrl, setImportUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        sourceUrl: sourceUrl || undefined,
        description: description || undefined,
        price: price || undefined,
        currency: price ? "THB" : undefined,
        source: fromExtension ? "extension" : "manual",
        images: images.length ? images : undefined,
      }),
    });

    setLoading(false);

    if (!res.ok) {
      setError("เพิ่มสินค้าไม่สำเร็จ กรุณาตรวจสอบข้อมูล");
      return;
    }

    router.push("/products");
    router.refresh();
  }

  async function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await fetch("/api/products/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: importUrl }),
    });

    setLoading(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "นำเข้าสินค้าจาก URL ไม่สำเร็จ");
      return;
    }

    router.push("/products");
    router.refresh();
  }

  return (
    <div className="mx-auto w-full max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>เพิ่มสินค้าใหม่</CardTitle>
        </CardHeader>
        <CardContent>
          {fromExtension && (
            <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              ดึงข้อมูลจาก Chrome Extension มาให้แล้ว ตรวจสอบก่อนบันทึก
            </p>
          )}
          <Tabs defaultValue={fromExtension ? "manual" : "url"}>
            <TabsList className="w-full">
              <TabsTrigger value="url" className="flex-1">
                นำเข้าจาก URL
              </TabsTrigger>
              <TabsTrigger value="manual" className="flex-1">
                กรอกข้อมูลเอง
              </TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="mt-4">
              <form onSubmit={handleImportSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="importUrl">URL หน้าสินค้า *</Label>
                  <Input
                    id="importUrl"
                    type="url"
                    placeholder="https://..."
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    ระบบจะพยายามดึงชื่อ, รายละเอียด และรูปสินค้าให้อัตโนมัติ
                  </p>
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" disabled={loading || !importUrl}>
                  {loading ? "กำลังนำเข้า..." : "นำเข้าสินค้า"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="manual" className="mt-4">
              <form onSubmit={handleManualSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">ชื่อสินค้า *</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="sourceUrl">URL สินค้า</Label>
                  <Input
                    id="sourceUrl"
                    type="url"
                    placeholder="https://..."
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="description">รายละเอียด</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="price">ราคา (บาท)</Label>
                  <Input
                    id="price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" disabled={loading || !name}>
                  {loading ? "กำลังบันทึก..." : "เพิ่มสินค้า"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
