import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  challengeAndVerify: vi.fn(),
  enroll: vi.fn(),
  getAuthenticatorAssuranceLevel: vi.fn(),
  getSession: vi.fn(),
  listFactors: vi.fn(),
  unenroll: vi.fn(),
}));

vi.mock("@/lib/supabaseClient", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: mocks.getSession,
      mfa: {
        challengeAndVerify: mocks.challengeAndVerify,
        enroll: mocks.enroll,
        getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel,
        listFactors: mocks.listFactors,
        unenroll: mocks.unenroll,
      },
    },
  }),
  isSupabaseConfigured: true,
}));

import {
  cancelTotpEnrollment,
  enrollTotpFactor,
  getMfaState,
  verifyTotpFactor,
} from "@/services/authService";

const factorId = "11111111-1111-4111-8111-111111111111";

describe("MFA service", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    mocks.listFactors.mockResolvedValue({
      data: {
        totp: [
          {
            id: factorId,
            friendly_name: "Primary authenticator",
            status: "verified",
            created_at: "2026-07-13T10:00:00.000Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            friendly_name: "Incomplete",
            status: "unverified",
            created_at: "2026-07-13T10:01:00.000Z",
          },
          { id: "invalid", status: "unexpected" },
        ],
      },
      error: null,
    });
  });

  it("returns assurance and only marks verified TOTP factors ready", async () => {
    await expect(getMfaState()).resolves.toMatchObject({
      currentLevel: "aal1",
      nextLevel: "aal2",
      verifiedTotpFactors: [
        {
          id: factorId,
          friendlyName: "Primary authenticator",
          status: "verified",
        },
      ],
    });
  });

  it("orders the named primary first and otherwise uses oldest enrollment", async () => {
    const backupId = "22222222-2222-4222-8222-222222222222";
    const olderId = "33333333-3333-4333-8333-333333333333";
    const invalidTimestampId = "44444444-4444-4444-8444-444444444444";
    const providerFactors = [
      {
        id: invalidTimestampId,
        friendly_name: "A authenticator with invalid timestamp",
        status: "verified",
        created_at: "not-a-timestamp",
      },
      {
        id: backupId,
        friendly_name: "Backup authenticator",
        status: "verified",
        created_at: "2026-07-13T10:02:00.000Z",
      },
      {
        id: factorId,
        friendly_name: "Primary authenticator",
        status: "verified",
        created_at: "2026-07-13T10:03:00.000Z",
      },
      {
        id: olderId,
        friendly_name: "Older authenticator",
        status: "verified",
        created_at: "2026-07-13T10:01:00.000Z",
      },
    ];
    mocks.listFactors.mockResolvedValue({
      data: { totp: providerFactors },
      error: null,
    });

    const result = await getMfaState();

    expect(result.verifiedTotpFactors.map((factor) => factor.id)).toEqual([
      factorId,
      olderId,
      backupId,
      invalidTimestampId,
    ]);
    expect(providerFactors.map((factor) => factor.id)).toEqual([
      invalidTimestampId,
      backupId,
      factorId,
      olderId,
    ]);
  });

  it("keeps the QR secret only in the enrollment result", async () => {
    mocks.enroll.mockResolvedValue({
      data: {
        id: factorId,
        totp: {
          qr_code: "data:image/svg+xml;utf8,encoded",
          secret: "PRIVATE-TOTP-SECRET",
          uri: "otpauth://totp/example",
        },
      },
      error: null,
    });

    await expect(enrollTotpFactor("Primary authenticator")).resolves.toEqual({
      factorId,
      qrCode: "data:image/svg+xml;utf8,encoded",
      secret: "PRIVATE-TOTP-SECRET",
      uri: "otpauth://totp/example",
    });
    expect(mocks.enroll).toHaveBeenCalledWith({
      factorType: "totp",
      friendlyName: "Primary authenticator",
    });
  });

  it("rejects malformed factor IDs and codes before calling Auth", async () => {
    await expect(
      verifyTotpFactor("not-a-factor", "12ab"),
    ).rejects.toMatchObject({ code: "auth_mfa_code_invalid" });
    expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
  });

  it("waits until challenge verification installs the refreshed session", async () => {
    mocks.challengeAndVerify.mockResolvedValue({ data: {}, error: null });
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "aal2-token" } },
      error: null,
    });

    await expect(verifyTotpFactor(factorId, "123456")).resolves.toBeUndefined();
    expect(mocks.challengeAndVerify).toHaveBeenCalledWith({
      factorId,
      code: "123456",
    });
    expect(mocks.getSession).toHaveBeenCalledOnce();
  });

  it("maps invalid TOTP and supports cleanup only through explicit unenroll", async () => {
    mocks.challengeAndVerify.mockResolvedValue({
      data: null,
      error: { code: "mfa_verification_failed", message: "Invalid TOTP" },
    });
    await expect(verifyTotpFactor(factorId, "123456")).rejects.toMatchObject({
      code: "auth_mfa_code_invalid",
    });

    mocks.unenroll.mockResolvedValue({ data: {}, error: null });
    await expect(cancelTotpEnrollment(factorId)).resolves.toBeUndefined();
    expect(mocks.unenroll).toHaveBeenCalledWith({ factorId });
  });
});
