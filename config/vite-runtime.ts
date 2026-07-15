export const DEFAULT_VITE_PORT = 5173;
export const DEFAULT_VITE_BASE_PATH = "/";

export interface ViteRuntimeConfig {
  port: number;
  basePath: string;
}

const VITE_BASE_ORIGIN = "https://schreiben.invalid";

export function isSafeViteBasePath(value: string) {
  if (value === "./") return true;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (/[\\?#\u0000-\u001f\u007f]/.test(value)) return false;

  try {
    return new URL(value, VITE_BASE_ORIGIN).origin === VITE_BASE_ORIGIN;
  } catch {
    return false;
  }
}

export function resolveViteRuntimeConfig(
  environment: Record<string, string | undefined>,
): ViteRuntimeConfig {
  const rawPort = environment.PORT?.trim() || String(DEFAULT_VITE_PORT);

  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = environment.BASE_PATH?.trim() || DEFAULT_VITE_BASE_PATH;
  if (!isSafeViteBasePath(basePath)) {
    throw new Error(
      `Invalid BASE_PATH value: "${basePath}". Use an absolute path such as "/" or "/schreiben/".`,
    );
  }

  return { port, basePath };
}
