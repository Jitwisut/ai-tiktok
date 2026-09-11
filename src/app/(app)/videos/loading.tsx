import { Skeleton } from "@/components/ui/skeleton";

export default function VideosLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-32" />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, col) => (
          <div key={col} className="flex flex-col gap-3">
            <Skeleton className="h-4 w-24" />
            <div className="flex flex-col gap-3 rounded-xl border p-3">
              <Skeleton className="aspect-video w-full rounded-md" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
