import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import StudentPractice from "@/pages/student/practice";
import "@/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: Number.POSITIVE_INFINITY,
    },
    mutations: { retry: false },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Practice state matrix root is unavailable.");

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <main>
      <StudentPractice />
    </main>
  </QueryClientProvider>,
);
