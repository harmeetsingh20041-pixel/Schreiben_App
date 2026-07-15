export type PublicErrorCode =
  | "auth_invalid_credentials"
  | "auth_email_unconfirmed"
  | "auth_rate_limited"
  | "auth_weak_password"
  | "auth_invalid_email"
  | "auth_session_expired"
  | "auth_signup_disabled"
  | "auth_sign_in_failed"
  | "auth_sign_up_failed"
  | "auth_confirmation_failed"
  | "auth_password_reset_failed"
  | "auth_password_update_failed"
  | "auth_sign_out_failed"
  | "auth_context_failed"
  | "auth_workspace_failed"
  | "auth_mfa_failed"
  | "auth_mfa_code_invalid"
  | "data_unavailable"
  | "data_session_expired"
  | "data_mfa_required"
  | "data_fresh_reauthentication_required"
  | "data_permission_denied"
  | "data_rate_limited"
  | "data_invalid_request"
  | "data_not_found"
  | "data_conflict"
  | "data_request_failed"
  | "data_invalid_response";

export class PublicAppError extends Error {
  readonly code: PublicErrorCode;
  readonly publicMessage: string;

  constructor(code: PublicErrorCode, publicMessage: string) {
    super(publicMessage);
    this.name = "PublicAppError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function isPublicAppError(error: unknown): error is PublicAppError {
  return error instanceof PublicAppError;
}
