import { describe, expect, it } from "vitest";
import {
  normalizeMonitoringRoute,
  sanitizeMonitoringEvent,
  scrubMonitoringValue,
} from "@/lib/monitoring";

describe("monitoring privacy boundary", () => {
  it("redacts student and provider payloads regardless of nesting", () => {
    expect(
      scrubMonitoringValue({
        safe_error_code: "worksheet_provider_unavailable",
        submission_id: "11111111-1111-4111-8111-111111111111",
        detail: "Mein vollständiger Aufsatz steht hier.",
        response: { content: "provider output with answer key" },
        original_text: "Private writing",
        email: "student@example.test",
      }),
    ).toEqual({
      safe_error_code: "worksheet_provider_unavailable",
      submission_id: "[Redacted]",
      detail: "[Redacted]",
      response: { content: "[Redacted]" },
      original_text: "[Redacted]",
      email: "[Redacted]",
    });
  });

  it("removes object UUIDs and normalizes dynamic route segments", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(normalizeMonitoringRoute(`/student/submission/${id}?tab=feedback`))
      .toBe("/student/submission/:id");
    expect(sanitizeMonitoringEvent({
      tags: {
        route: `/teacher/practice/${id}`,
        workspace_id: id,
        assignment_id: id,
      },
    }).tags).toEqual({
      route: "/teacher/practice/:id",
      workspace_id: "[Redacted]",
      assignment_id: "[Redacted]",
    });
  });

  it("drops free-form exception, request, log, and breadcrumb channels", () => {
    const event = sanitizeMonitoringEvent({
      message: "Student wrote private text",
      request: { data: "private body" },
      breadcrumbs: [{ message: "private click label" }],
      logentry: { message: "provider payload" },
      exception: { values: [{ type: "Error", value: "private response" }] },
      tags: { route: "/student/write", role: "student" },
    });

    expect(event.message).toBe("Client error captured");
    expect(event.request).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.logentry).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/private|provider payload/i);
  });

  it("retains privacy-safe grouping evidence without retaining error content", () => {
    const event = sanitizeMonitoringEvent({
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Student wrote Geheimtext and provider returned a secret",
            stacktrace: {
              frames: [
                {
                  filename:
                    "https://schreiben.example/assets/write-AbCd1234.js?student=private",
                  function: "submitWriting",
                  lineno: 412,
                  colno: 19,
                  context_line: "throw new Error(studentWriting)",
                },
                {
                  filename: "https://evil.example/private student name.js",
                  function: "private student name",
                  lineno: 1,
                },
              ],
            },
          },
        ],
      },
      tags: {
        safe_error_code: "submission_queue_failed",
        route: "/student/write",
      },
    });

    expect(event.exception).toEqual({
      values: [
        {
          type: "TypeError",
          value: "Client error captured (submission_queue_failed)",
          stacktrace: {
            frames: [
              {
                filename: "/assets/write-AbCd1234.js",
                function: "submitWriting",
                lineno: 412,
                colno: 19,
                in_app: false,
              },
            ],
          },
        },
      ],
    });
    expect(event.tags).toMatchObject({
      safe_error_code: "submission_queue_failed",
      route: "/student/write",
    });
    expect(JSON.stringify(event)).not.toMatch(
      /Geheimtext|provider returned|student name|context_line/i,
    );
  });
});
