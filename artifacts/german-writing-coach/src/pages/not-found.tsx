import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-[60dvh] w-full flex items-center justify-center px-4">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="p-6">
          <div className="flex mb-4 items-start gap-3">
            <AlertCircle className="h-7 w-7 shrink-0 text-destructive" aria-hidden="true" />
            <h1 className="text-2xl font-bold">Page not found</h1>
          </div>

          <p className="text-sm text-muted-foreground">
            This link may be outdated, or the page may no longer be available.
          </p>
          <Button asChild className="mt-5 w-full sm:w-auto">
            <Link href="/">Return to your home page</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
