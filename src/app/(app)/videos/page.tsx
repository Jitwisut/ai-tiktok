import { Card, CardContent } from "@/components/ui/card";

export default function VideosPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Videos</h1>
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          Video Generation & Library — เริ่มพัฒนาใน Phase 6
        </CardContent>
      </Card>
    </div>
  );
}
