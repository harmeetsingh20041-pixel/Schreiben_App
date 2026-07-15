import { useEffect, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { Router, useParams } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    canCreateTeacherWorkspace: false,
    loading: false,
    needsWorkspace: false,
    role: "student",
  }),
}));

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => children,
}));

import { ProtectedRoute } from "@/App";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("dynamic protected-route isolation", () => {
  it("remounts on an id change so a slow previous assignment cannot commit into the next route", async () => {
    const first = deferred();
    const second = deferred();
    const pending = new Map([
      ["assignment-a", first.promise],
      ["assignment-b", second.promise],
    ]);

    function DeferredWorksheet() {
      const { id = "missing" } = useParams<{ id: string }>();
      const [loadedId, setLoadedId] = useState("pending");
      useEffect(() => {
        void pending.get(id)?.then(() => setLoadedId(id));
      }, []);
      return <div data-testid="route-result">{`${id}:${loadedId}`}</div>;
    }

    const location = memoryLocation({
      path: "/student/practice/assignment-a",
    });
    render(
      <Router hook={location.hook}>
        <ProtectedRoute
          path="/student/practice/:id"
          role="student"
          component={DeferredWorksheet}
        />
      </Router>,
    );
    expect(screen.getByTestId("route-result")).toHaveTextContent(
      "assignment-a:pending",
    );

    act(() => location.navigate("/student/practice/assignment-b"));
    expect(screen.getByTestId("route-result")).toHaveTextContent(
      "assignment-b:pending",
    );

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(screen.getByTestId("route-result")).toHaveTextContent(
      "assignment-b:pending",
    );

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(screen.getByTestId("route-result")).toHaveTextContent(
      "assignment-b:assignment-b",
    );
  });
});
