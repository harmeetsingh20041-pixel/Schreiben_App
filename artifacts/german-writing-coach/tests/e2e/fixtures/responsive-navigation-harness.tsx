import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Layout } from "@/components/layout";

export function mountResponsiveNavigationHarness() {
  document.getElementById("responsive-navigation-harness")?.remove();
  const applicationRoot = document.getElementById("root");
  if (applicationRoot) applicationRoot.hidden = true;

  const harnessRoot = document.createElement("div");
  harnessRoot.id = "responsive-navigation-harness";
  document.body.append(harnessRoot);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  createRoot(harnessRoot).render(
    <QueryClientProvider client={queryClient}>
      <Layout>
        <div>Responsive navigation fixture</div>
      </Layout>
    </QueryClientProvider>,
  );
}
