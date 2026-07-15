import { createRoot } from "react-dom/client";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Toaster } from "@/components/ui/toaster";
import StudentWorksheet from "@/pages/student/worksheet";
import "@/index.css";

export const OBJECTIVE_ASSIGNMENT_ID = "55555555-5555-4555-8555-555555555555";

const root = document.getElementById("root");
if (!root) throw new Error("Objective worksheet root is unavailable.");

const location = memoryLocation({
  path: `/student/practice/${OBJECTIVE_ASSIGNMENT_ID}`,
});

createRoot(root).render(
  <Router hook={location.hook}>
    <Route path="/student/practice/:id" component={StudentWorksheet} />
    <Toaster />
  </Router>,
);
