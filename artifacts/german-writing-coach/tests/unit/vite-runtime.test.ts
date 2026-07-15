import { describe, expect, it } from "vitest";
import {
  DEFAULT_VITE_BASE_PATH,
  DEFAULT_VITE_PORT,
  resolveViteRuntimeConfig,
} from "../../../../config/vite-runtime";

describe("resolveViteRuntimeConfig", () => {
  it("provides deterministic local and CI defaults", () => {
    expect(resolveViteRuntimeConfig({})).toEqual({
      port: DEFAULT_VITE_PORT,
      basePath: DEFAULT_VITE_BASE_PATH,
    });
  });

  it("accepts an explicit port and deployment subpath", () => {
    expect(
      resolveViteRuntimeConfig({ PORT: "4173", BASE_PATH: "/schreiben/" }),
    ).toEqual({ port: 4173, basePath: "/schreiben/" });
  });

  it.each(["0", "65536", "12.5", "not-a-port"])(
    "rejects invalid PORT=%s",
    (port) => {
      expect(() => resolveViteRuntimeConfig({ PORT: port })).toThrow(
        "Invalid PORT value",
      );
    },
  );

  it("rejects a deployment base that is not an absolute path", () => {
    expect(() => resolveViteRuntimeConfig({ BASE_PATH: "schreiben" })).toThrow(
      "Invalid BASE_PATH value",
    );
  });

  it.each([
    "//attacker.invalid/",
    "/\\\\attacker.invalid/",
    "/schreiben/?redirect=//attacker.invalid/",
    "/schreiben/#//attacker.invalid/",
  ])("rejects an unsafe deployment BASE_PATH=%s", (basePath) => {
    expect(() => resolveViteRuntimeConfig({ BASE_PATH: basePath })).toThrow(
      "Invalid BASE_PATH value",
    );
  });
});
