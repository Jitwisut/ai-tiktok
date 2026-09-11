import { Card, CardContent } from "@/components/ui/card";

export default function ContentsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Content</h1>
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          AI Content Generation — เริ่มพัฒนาใน Phase 4
        </CardContent>
      </Card>
    </div>
  );
}
