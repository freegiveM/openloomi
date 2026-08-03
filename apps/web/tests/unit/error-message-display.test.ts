import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { returnObjects?: boolean }) => {
      if (options?.returnObjects) {
        if (key === "common.errors.codexCompatibilityError.suggestions") {
          return ["Upgrade Codex", "Choose a compatible model"];
        }
        if (key === "common.errors.genericError.suggestions") {
          return ["Please try again later"];
        }
        if (key === "auth.errors.runtimeNotLoggedIn.suggestions") {
          return [
            "Run `claude auth login` in your terminal, then retry",
            "Or open API Settings and add an Anthropic-compatible provider",
          ];
        }
        return [];
      }

      const messages: Record<string, string> = {
        "common.errors.codexCompatibilityError.title":
          "Codex setup needs attention",
        "common.errors.codexCompatibilityError.docsAction":
          "Open Codex installation guide",
        "common.errors.genericError.title": "An Error Occurred",
        "common.errors.genericError.description":
          "There was a problem processing your request.",
        "auth.errors.runtimeNotLoggedIn.title": "Claude runtime not signed in",
        "auth.errors.runtimeNotLoggedIn.description":
          "The chat is using the built-in Claude runtime, but no Claude credentials were found.",
        "auth.errors.runtimeNotLoggedIn.apiSettingsAction": "Open API Settings",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("@/components/remix-icon", () => ({
  RemixIcon: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: unknown }) => children,
}));

vi.mock("next/navigation", () => ({
  // The component now calls useRouter() to deep-link to API Settings
  // when the `showApiSettings` affordance fires. The existing SSR
  // tests don't click the button, so a no-op stub is enough.
  useRouter: () => ({ push: () => undefined }),
}));

import { ErrorMessageDisplay } from "@/components/message/error-message-display";

describe("ErrorMessageDisplay", () => {
  it("renders the original backend detail for an otherwise generic error", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorMessageDisplay, {
        errorContent:
          "Error: The provider rejected this exact request for account policy ABC-123.",
      }),
    );

    expect(html).toContain(
      "The provider rejected this exact request for account policy ABC-123.",
    );
    expect(html).toContain("An Error Occurred");
  });

  it("renders actionable Codex compatibility detail and the upgrade guide", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorMessageDisplay, {
        errorContent:
          'The selected model "gpt-new" is not available in Codex CLI 0.100.0. Upgrade Codex or choose a compatible model.',
      }),
    );

    expect(html).toContain("Codex setup needs attention");
    expect(html).toContain("gpt-new");
    expect(html).toContain("Codex CLI 0.100.0");
    expect(html).toContain("Upgrade Codex");
    expect(html).toContain("Choose a compatible model");
    expect(html).toContain(
      'href="https://github.com/openai/codex#installation"',
    );
  });

  // Mirrors the alloomi `authentication_error` policy entry: when the
  // Claude runtime preflight surfaces "Not logged in" / "claude auth
  // login", the chat card must name both remediation paths and expose
  // a deep-link to API Settings instead of the generic "permission
  // error" wording.
  it("renders runtimeNotLoggedIn card for Claude runtime auth failures", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorMessageDisplay, {
        errorContent:
          "Error: Not logged in. Run `claude auth login` to authenticate the Claude runtime.",
      }),
    );

    // Title + description must mention Claude runtime login.
    expect(html).toContain("Claude runtime not signed in");
    expect(html).toContain("Claude credentials were found");

    // Both suggestions must render (claude auth login + API Settings).
    expect(html).toContain("claude auth login");
    expect(html).toContain("Or open API Settings");

    // The "Open API Settings" affordance must be present.
    expect(html).toContain("Open API Settings");
  });
});
