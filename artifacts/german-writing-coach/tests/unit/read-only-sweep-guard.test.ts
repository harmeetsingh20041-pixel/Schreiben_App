import { describe, expect, it } from "vitest";
import {
  assertReadOnlySweepPassed,
  classifyReadOnlySweepRequest,
  readOnlySweepFailureMessages,
  REVIEWED_MUTATING_RPC_NAMES,
} from "../e2e/helpers/read-only-sweep-guard";

const SUPABASE_ORIGIN = "https://project-ref.supabase.co";

describe("read-only dialog sweep guard", () => {
  it.each(["GET", "POST", "OPTIONS"])(
    "blocks every %s request to an Edge Function path",
    (method) => {
      expect(
        classifyReadOnlySweepRequest(
          method,
          `${SUPABASE_ORIGIN}/functions/v1/generate-practice-worksheet`,
        ),
      ).toMatchObject({ kind: "edge_function", method });
    },
  );

  it.each(REVIEWED_MUTATING_RPC_NAMES)(
    "blocks reviewed mutating RPC %s",
    (functionName) => {
      expect(
        classifyReadOnlySweepRequest(
          "POST",
          `${SUPABASE_ORIGIN}/rest/v1/rpc/${functionName}`,
        ),
      ).toMatchObject({ kind: "mutating_rpc", method: "POST" });
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "blocks direct REST table %s writes",
    (method) => {
      expect(
        classifyReadOnlySweepRequest(
          method,
          `${SUPABASE_ORIGIN}/rest/v1/workspace_batches?id=eq.fixture`,
        ),
      ).toMatchObject({ kind: "direct_rest_write", method });
    },
  );

  it.each([
    ["POST", "/auth/v1/token?grant_type=password"],
    ["POST", "/rest/v1/rpc/get_auth_context"],
    ["POST", "/rest/v1/rpc/list_workspace_batches_page"],
    ["GET", "/rest/v1/workspace_batches?select=id"],
    ["HEAD", "/rest/v1/workspace_batches?select=id"],
  ])("allows %s %s as authentication or read traffic", (method, pathname) => {
    expect(
      classifyReadOnlySweepRequest(method, `${SUPABASE_ORIGIN}${pathname}`),
    ).toBeNull();
  });

  it("keeps blocked and fatal evidence together for the teardown failure", () => {
    const evidence = {
      violations: ["mutating_rpc:POST:/rest/v1/rpc/request_batch_join"],
      fatalFailures: ["http:503:GET:/rest/v1/rpc/get_auth_context"],
    };
    expect(readOnlySweepFailureMessages(evidence)).toEqual([
      "blocked:mutating_rpc:POST:/rest/v1/rpc/request_batch_join",
      "fatal:http:503:GET:/rest/v1/rpc/get_auth_context",
    ]);
    expect(() => assertReadOnlySweepPassed(evidence)).toThrow(
      /blocked:.*\nfatal:/,
    );
    expect(() =>
      assertReadOnlySweepPassed({ violations: [], fatalFailures: [] }),
    ).not.toThrow();
  });
});
