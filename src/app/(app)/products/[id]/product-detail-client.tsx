"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ProductDetail = {
  id: string;
  name: string;
  description: string | null;
  price: string | null;
  currency: string | null;
  category: string | null;
  sellerName: string | null;
  status: string;
  sourceUrl: string | null;
  images: { id: string; url: string }[];
};

export function ProductDetailClient({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [price, setPrice] = useState(product.price ?? "");
  const [category, setCategory] = useState(product.category ?? "");
  const [sellerName, setSellerName] = useState(product.sellerName ?? "");

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const res = await fetch(`/api/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: description || undefined,
        price: price || undefined,
        category: category || undefined,
        sellerName: sellerName || undefined,
      }),
    });

    setSaving(false);

    if (!res.ok) {
      toast.error("บันทึกไม่สำเร็จ");
      return;
    }

    toast.success("บันทึกข้อมูลสินค้าแล้ว");
    router.refresh();
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`/api/products/${product.id}/images`, {
      method: "POST",
      body: formData,
    });

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "อัปโหลดรูปไม่สำเร็จ");
      return;
    }

    router.refresh();
  }

  async function handleDeleteImage(imageId: string) {
    const res = await fetch(`/api/products/${product.id}/images/${imageId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      toast.error("ลบรูปไม่สำเร็จ");
      return;
    }
    router.refresh();
  }

  async function handleDeleteProduct() {
    if (!confirm(`ลบสินค้า "${product.name}" ใช่หรือไม่?`)) return;

    setDeleting(true);
    const res = await fetch(`/api/products/${product.id}`, {
      method: "DELETE",
    });
    setDeleting(false);

    if (!res.ok) {
      toast.error("ลบสินค้าไม่สำเร็จ");
      return;
    }

    toast.success("ลบสินค้าแล้ว");
    router.push("/products");
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">{product.name}</h1>
          <Badge variant="secondary">{product.status}</Badge>
        </div>
        <Button
          variant="destructive"
          onClick={handleDeleteProduct}
          disabled={deleting}
        >
          {deleting ? "กำลังลบ..." : "ลบสินค้า"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>รูปภาพสินค้า</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {product.images.map((img) => (
              <div key={img.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={product.name}
                  className="aspect-square w-full rounded-md object-cover"
                />
                <button
                  type="button"
                  onClick={() => handleDeleteImage(img.id)}
                  className="absolute top-1 right-1 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ลบ
                </button>
              </div>
            ))}
          </div>
          <div>
            <Input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={handleUpload}
              disabled={uploading}
            />
            {uploading && (
              <p className="mt-1 text-xs text-muted-foreground">
                กำลังอัปโหลด...
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>รายละเอียดสินค้า</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">ชื่อสินค้า</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="description">รายละเอียด</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="price">ราคา</Label>
                <Input
                  id="price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="category">หมวดหมู่</Label>
                <Input
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sellerName">ผู้ขาย</Label>
              <Input
                id="sellerName"
                value={sellerName}
                onChange={(e) => setSellerName(e.target.value)}
              />
            </div>
            {product.sourceUrl && (
              <p className="text-xs text-muted-foreground">
                ที่มา:{" "}
                <a
                  href={product.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {product.sourceUrl}
                </a>
              </p>
            )}
            <Button type="submit" disabled={saving}>
              {saving ? "กำลังบันทึก..." : "บันทึกการเปลี่ยนแปลง"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
