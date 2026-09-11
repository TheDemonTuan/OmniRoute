// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ConnectionRow, {
  type ConnectionRowProps,
  type ConnectionRowConnection,
} from "../components/ConnectionRow";
import {
  isConnectionPendingVerification,
  inferConnectionErrorType,
  getConnectionStatusPresentation,
} from "../providerPageHelpers";

const noop = () => {};

function buildProps(
  connection: ConnectionRowConnection,
  overrides?: Partial<ConnectionRowProps>
): ConnectionRowProps {
  return {
    connection,
    isOAuth: false,
    isFirst: false,
    isLast: false,
    onMoveUp: noop,
    onMoveDown: noop,
    onToggleActive: noop,
    onToggleRateLimit: noop,
    onRetest: noop,
    onEdit: noop,
    onDelete: noop,
    ...overrides,
  } as ConnectionRowProps;
}

const roots: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function render(props: ConnectionRowProps) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<ConnectionRow {...props} />));
  roots.push({ root, el });
  return el;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, el } of roots.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.clearAllMocks();
});

const mockT = (key: string, _values?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    statusDisabled: "Disabled",
    statusConnected: "Connected",
    statusPendingVerification: "Pending Verification",
    statusAuthFailed: "Auth Failed",
    statusRateLimited: "Rate Limited",
    statusNetworkIssue: "Network Issue",
    statusRuntimeIssue: "Runtime Issue",
    statusTestUnsupported: "Unsupported",
    statusBanned: "Banned (403)",
    statusCreditsExhausted: "Out of Credits",
    statusDeactivated: "Deactivated",
    statusUnavailable: "Unavailable",
    statusFailed: "Failed",
    statusError: "Error",
  };
  return map[key] || key;
};

describe("Pending Verification display behavior (TDD regression suite)", () => {
  describe("Pure helper status projection (providerPageHelpers)", () => {
    it("preserves genuine pending on save when active and error-free", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { pendingBrowserVerification: true },
      };
      expect(isConnectionPendingVerification(conn)).toBe(true);

      const presentation = getConnectionStatusPresentation(conn, "active", false, mockT);
      expect(presentation.statusLabel).toBe("Pending Verification");
      expect(presentation.statusVariant).toBe("warning");
      expect(presentation.errorType).toBe("pending_verification");
    });

    it("preserves genuine pending when testStatus is pending and error-free", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: true,
        testStatus: "pending",
      };
      expect(isConnectionPendingVerification(conn)).toBe(true);

      const presentation = getConnectionStatusPresentation(conn, "pending", false, mockT);
      expect(presentation.statusLabel).toBe("Pending Verification");
      expect(presentation.statusVariant).toBe("warning");
    });

    it("does not mask disabled status when connection.isActive is false even with pending metadata", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: false,
        testStatus: "pending",
        providerSpecificData: { pendingBrowserVerification: true },
      };
      expect(isConnectionPendingVerification(conn)).toBe(false);

      const presentation = getConnectionStatusPresentation(conn, "pending", false, mockT);
      expect(presentation.statusLabel).toBe("Disabled");
      expect(presentation.statusVariant).toBe("default");
    });

    it("does not mask upstream auth error / reauth need with stale pending metadata", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: true,
        errorCode: 401,
        lastError: "Unauthorized invalid session",
        lastErrorType: "upstream_auth_error",
        testStatus: "failed",
        providerSpecificData: { pendingBrowserVerification: true },
      };
      expect(inferConnectionErrorType(conn, false)).toBe("upstream_auth_error");
      expect(isConnectionPendingVerification(conn)).toBe(false);

      const presentation = getConnectionStatusPresentation(conn, "failed", false, mockT);
      expect(presentation.statusLabel).toBe("Auth Failed");
      expect(presentation.statusVariant).toBe("error");
      expect(presentation.errorType).toBe("upstream_auth_error");
    });

    it("does not mask rate limit / cooldown with stale pending metadata", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: true,
        testStatus: "unavailable",
        rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
        providerSpecificData: { pendingBrowserVerification: true },
      };
      expect(inferConnectionErrorType(conn, true)).toBe("upstream_rate_limited");
      expect(isConnectionPendingVerification(conn, true)).toBe(false);

      const presentation = getConnectionStatusPresentation(conn, "unavailable", true, mockT);
      expect(presentation.statusLabel).toBe("Rate Limited");
      expect(presentation.statusVariant).toBe("warning");
    });

    it("does not mask banned status with stale pending metadata", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: true,
        testStatus: "banned",
        providerSpecificData: { pendingBrowserVerification: true },
      };
      expect(isConnectionPendingVerification(conn)).toBe(false);

      const presentation = getConnectionStatusPresentation(conn, "banned", false, mockT);
      expect(presentation.statusLabel).toBe("Banned (403)");
      expect(presentation.statusVariant).toBe("error");
    });

    it("does not mask credits exhausted status with stale pending metadata", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: true,
        testStatus: "credits_exhausted",
        providerSpecificData: { pendingBrowserVerification: true },
      };
      expect(isConnectionPendingVerification(conn)).toBe(false);

      const presentation = getConnectionStatusPresentation(conn, "credits_exhausted", false, mockT);
      expect(presentation.statusLabel).toBe("Out of Credits");
      expect(presentation.statusVariant).toBe("warning");
    });

    it("does not mask network / timeout failure with stale pending metadata", () => {
      const conn: ConnectionRowConnection = {
        provider: "chatgpt-web-codex",
        isActive: true,
        testStatus: "failed",
        lastError: "fetch failed: network timeout",
        providerSpecificData: { pendingBrowserVerification: true },
      };
      expect(inferConnectionErrorType(conn, false)).toBe("network_error");
      expect(isConnectionPendingVerification(conn)).toBe(false);

      const presentation = getConnectionStatusPresentation(conn, "failed", false, mockT);
      expect(presentation.statusLabel).toBe("Network Issue");
      expect(presentation.statusVariant).toBe("warning");
    });
  });

  describe("Real ConnectionRow component rendering", () => {
    it("renders Disabled badge when isActive is false, even if pendingBrowserVerification is true", () => {
      const conn: ConnectionRowConnection = {
        id: "conn-disabled-pending",
        name: "Test Codex",
        provider: "chatgpt-web-codex",
        isActive: false,
        priority: 1,
        providerSpecificData: { pendingBrowserVerification: true },
      };

      const el = render(buildProps(conn));
      // Real translated text in en.json for statusDisabled is "disabled"
      expect(el.textContent?.toLowerCase()).toContain("disabled");
      expect(el.textContent).not.toContain("Pending Verification");
    });

    it("renders Auth Failed and lastError text when credential fails, not Pending Verification", () => {
      const conn: ConnectionRowConnection = {
        id: "conn-auth-fail",
        name: "Test Codex",
        provider: "chatgpt-web-codex",
        isActive: true,
        priority: 1,
        errorCode: 401,
        lastError: "Invalid session cookie",
        testStatus: "failed",
        providerSpecificData: { pendingBrowserVerification: true },
      };

      const el = render(buildProps(conn));
      // Real translated text in en.json for statusAuthFailed is "auth failed"
      expect(el.textContent?.toLowerCase()).toContain("auth failed");
      expect(el.textContent).toContain("Invalid session cookie");
      expect(el.textContent).not.toContain("Pending Verification");
    });

    it("renders Pending Verification badge when newly saved without errors", () => {
      const conn: ConnectionRowConnection = {
        id: "conn-genuine-pending",
        name: "Test Codex",
        provider: "chatgpt-web-codex",
        isActive: true,
        priority: 1,
        testStatus: "active",
        providerSpecificData: { pendingBrowserVerification: true },
      };

      const el = render(buildProps(conn));
      expect(el.textContent).toContain("Pending Verification");
    });
  });
});
