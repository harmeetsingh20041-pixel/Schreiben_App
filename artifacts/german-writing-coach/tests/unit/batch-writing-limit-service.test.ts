import { beforeEach, describe, expect, it, vi } from "vitest";

const callApiRpc = vi.hoisted(() => vi.fn());

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc };
});

import {
  decideBatchWritingLimit,
  listBatchWritingLimitRequests,
} from "@/services/batchWritingLimitService";

const timestamp = "2026-07-14T10:00:00.000Z";

function requestItem(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    workspace_name: "Nursing School",
    batch_id: "33333333-3333-4333-8333-333333333333",
    batch_name: "A2 Evening",
    batch_active: true,
    requested_by: "44444444-4444-4444-8444-444444444444",
    requester_name: "Pilot Teacher",
    requester_email: "teacher@example.test",
    current_writing_daily_limit: 3,
    requested_writing_daily_limit: 7,
    request_status: "pending",
    request_revision: 2,
    requested_at: timestamp,
    decided_at: null,
    decided_by: null,
    updated_at: timestamp,
    ...overrides,
  };
}

function page(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    items,
    total_count: items.length,
    returned_count: items.length,
    page_size: 25,
    has_more: false,
    next_cursor: null,
    ...overrides,
  };
}

describe("batch writing-limit service", () => {
  beforeEach(() => {
    callApiRpc.mockReset();
  });

  it("parses a strict pending page and sends the exact keyset contract", async () => {
    callApiRpc.mockResolvedValue(page([requestItem()]));

    await expect(
      listBatchWritingLimitRequests({
        status: "pending",
        pageSize: 25,
        cursor: {
          updated_at: "2026-07-14T09:00:00.000Z",
          id: "55555555-5555-4555-8555-555555555555",
        },
      }),
    ).resolves.toMatchObject({
      items: [
        {
          batch_name: "A2 Evening",
          current_writing_daily_limit: 3,
          requested_writing_daily_limit: 7,
          request_revision: 2,
        },
      ],
      total_count: 1,
      has_more: false,
    });
    expect(callApiRpc).toHaveBeenCalledWith(
      "list_batch_writing_limit_requests",
      {
        status: "pending",
        page_size: 25,
        cursor_updated_at: "2026-07-14T09:00:00.000Z",
        cursor_id: "55555555-5555-4555-8555-555555555555",
      },
      expect.any(String),
    );
  });

  it("accepts only a complete next cursor when another page exists", async () => {
    callApiRpc.mockResolvedValue(
      page([requestItem()], {
        total_count: 2,
        has_more: true,
        next_cursor: {
          updated_at: timestamp,
          id: "11111111-1111-4111-8111-111111111111",
        },
      }),
    );

    await expect(listBatchWritingLimitRequests()).resolves.toMatchObject({
      has_more: true,
      next_cursor: {
        updated_at: timestamp,
        id: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("rejects a cursor that does not match the last returned request", async () => {
    callApiRpc.mockResolvedValue(
      page([requestItem()], {
        total_count: 2,
        has_more: true,
        next_cursor: {
          updated_at: timestamp,
          id: "99999999-9999-4999-8999-999999999999",
        },
      }),
    );

    await expect(listBatchWritingLimitRequests()).rejects.toMatchObject({
      code: "data_invalid_response",
    });
  });

  it("rejects malformed limits and contradictory decision fields", async () => {
    callApiRpc
      .mockResolvedValueOnce(
        page([requestItem({ requested_writing_daily_limit: 11 })]),
      )
      .mockResolvedValueOnce(
        page([
          requestItem({
            decided_at: timestamp,
            decided_by: "66666666-6666-4666-8666-666666666666",
          }),
        ]),
      );

    await expect(listBatchWritingLimitRequests()).rejects.toMatchObject({
      code: "data_invalid_response",
    });
    await expect(listBatchWritingLimitRequests()).rejects.toMatchObject({
      code: "data_invalid_response",
    });
  });

  it("sends a revision-safe decision and validates the resulting limit", async () => {
    callApiRpc.mockResolvedValue([
      {
        request_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        batch_id: "33333333-3333-4333-8333-333333333333",
        request_status: "approved",
        request_revision: 3,
        previous_writing_daily_limit: 3,
        current_writing_daily_limit: 7,
        requested_writing_daily_limit: 7,
        decided_at: timestamp,
        decided_by: "66666666-6666-4666-8666-666666666666",
      },
    ]);

    await expect(
      decideBatchWritingLimit({
        requestId: "11111111-1111-4111-8111-111111111111",
        decision: "approved",
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({
      request_status: "approved",
      request_revision: 3,
      previous_writing_daily_limit: 3,
      current_writing_daily_limit: 7,
    });
    expect(callApiRpc).toHaveBeenCalledWith(
      "decide_batch_writing_limit",
      {
        request_id: "11111111-1111-4111-8111-111111111111",
        decision: "approved",
        expected_revision: 2,
      },
      expect.any(String),
    );
  });

  it("rejects a decision response that contradicts the requested action", async () => {
    callApiRpc.mockResolvedValue([
      {
        request_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        batch_id: "33333333-3333-4333-8333-333333333333",
        request_status: "rejected",
        request_revision: 3,
        previous_writing_daily_limit: 3,
        current_writing_daily_limit: 3,
        requested_writing_daily_limit: 7,
        decided_at: timestamp,
        decided_by: "66666666-6666-4666-8666-666666666666",
      },
    ]);

    await expect(
      decideBatchWritingLimit({
        requestId: "11111111-1111-4111-8111-111111111111",
        decision: "approved",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "data_invalid_response" });
  });
});
