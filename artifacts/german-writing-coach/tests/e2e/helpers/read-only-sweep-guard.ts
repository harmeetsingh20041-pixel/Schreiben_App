import type {
  BrowserContext,
  Page,
  Request,
  Response,
  Route,
} from "@playwright/test";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * RPCs reviewed as application mutations. Supabase invokes both read and write
 * RPCs with POST, so method alone cannot distinguish them safely.
 */
export const REVIEWED_MUTATING_RPC_NAMES = [
  "assign_student_to_batch",
  "complete_onboarding_step",
  "create_next_practice_assignment",
  "create_teacher_workspace",
  "create_workspace_batch",
  "create_workspace_question",
  "decide_batch_join",
  "decide_quarantined_practice_worksheet",
  "decide_teacher_access",
  "disable_teacher_access",
  "ensure_student_practice_assignment",
  "finalize_practice_semantic_review",
  "offboard_student",
  "override_practice_attempt_score",
  "reassign_practice_assignment",
  "release_feedback",
  "remove_student_batch_assignment",
  "request_batch_join",
  "request_teacher_access",
  "resolve_practice_assignment_class_context",
  "resolve_practice_support",
  "retry_practice_attempt_evaluation",
  "rotate_batch_join_code",
  "save_practice_draft",
  "save_writing_draft",
  "set_batch_active",
  "set_question_active",
  "start_practice_assignment",
  "submit_practice_attempt",
  "submit_writing",
  "submit_writing_draft",
  "transfer_student_class",
  "update_feedback_draft",
  "update_teacher_workspace_limit",
  "update_workspace_batch",
  "update_workspace_question",
] as const;

const REVIEWED_MUTATING_RPC_SET = new Set<string>(
  REVIEWED_MUTATING_RPC_NAMES,
);

export type ReadOnlySweepViolationKind =
  | "edge_function"
  | "mutating_rpc"
  | "direct_rest_write";

export interface ReadOnlySweepViolation {
  kind: ReadOnlySweepViolationKind;
  method: string;
  pathname: string;
}

export interface ReadOnlySweepEvidence {
  violations: string[];
  fatalFailures: string[];
}

export interface ReadOnlySweepGuard {
  evidence: ReadOnlySweepEvidence;
  dispose: () => Promise<void>;
}

function safePathname(rawUrl: string) {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "";
  }
}

function reviewedRpcName(pathname: string) {
  const marker = "/rest/v1/rpc/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return "";
  return pathname.slice(markerIndex + marker.length).split("/", 1)[0] ?? "";
}

function isDirectRestTablePath(pathname: string) {
  const marker = "/rest/v1/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return false;
  const resource = pathname.slice(markerIndex + marker.length).split("/", 1)[0];
  return Boolean(resource && resource !== "rpc");
}

export function classifyReadOnlySweepRequest(
  method: string,
  rawUrl: string,
): ReadOnlySweepViolation | null {
  const normalizedMethod = method.toUpperCase();
  const pathname = safePathname(rawUrl);
  if (!pathname) return null;

  if (pathname === "/functions/v1" || pathname.startsWith("/functions/v1/")) {
    return { kind: "edge_function", method: normalizedMethod, pathname };
  }

  const rpcName = reviewedRpcName(pathname);
  if (rpcName && REVIEWED_MUTATING_RPC_SET.has(rpcName)) {
    return { kind: "mutating_rpc", method: normalizedMethod, pathname };
  }

  if (
    WRITE_METHODS.has(normalizedMethod) &&
    isDirectRestTablePath(pathname)
  ) {
    return { kind: "direct_rest_write", method: normalizedMethod, pathname };
  }

  return null;
}

export function readOnlySweepFailureMessages(evidence: ReadOnlySweepEvidence) {
  return [
    ...evidence.violations.map((value) => `blocked:${value}`),
    ...evidence.fatalFailures.map((value) => `fatal:${value}`),
  ];
}

export function assertReadOnlySweepPassed(evidence: ReadOnlySweepEvidence) {
  const failures = readOnlySweepFailureMessages(evidence);
  if (failures.length > 0) {
    throw new Error(
      `Read-only dialog sweep recorded unsafe or fatal browser activity:\n${failures.join("\n")}`,
    );
  }
}

export async function installReadOnlySweepGuard(
  context: BrowserContext,
): Promise<ReadOnlySweepGuard> {
  const evidence: ReadOnlySweepEvidence = {
    violations: [],
    fatalFailures: [],
  };
  const pageListeners = new Map<
    Page,
    {
      onPageError: (error: Error) => void;
      onResponse: (response: Response) => void;
    }
  >();

  const onPage = (page: Page) => {
    if (pageListeners.has(page)) return;
    const onPageError = (error: Error) => {
      evidence.fatalFailures.push(`pageerror:${error.name}`);
    };
    const onResponse = (response: Response) => {
      if (response.status() < 500) return;
      const request = response.request();
      const pathname = safePathname(response.url()) || "unparseable";
      evidence.fatalFailures.push(
        `http:${response.status()}:${request.method()}:${pathname}`,
      );
    };
    page.on("pageerror", onPageError);
    page.on("response", onResponse);
    pageListeners.set(page, { onPageError, onResponse });
  };

  const handleRoute = async (route: Route) => {
    const request: Request = route.request();
    const violation = classifyReadOnlySweepRequest(
      request.method(),
      request.url(),
    );
    if (violation) {
      evidence.violations.push(
        `${violation.kind}:${violation.method}:${violation.pathname}`,
      );
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  };

  context.pages().forEach(onPage);
  context.on("page", onPage);
  await context.route("**/*", handleRoute);

  return {
    evidence,
    dispose: async () => {
      await context.unroute("**/*", handleRoute);
      context.off("page", onPage);
      for (const [page, listeners] of pageListeners) {
        page.off("pageerror", listeners.onPageError);
        page.off("response", listeners.onResponse);
      }
      pageListeners.clear();
    },
  };
}
