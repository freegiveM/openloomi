import { describe, expect, it } from "vitest";

import {
  type EmbeddingSetting,
  type EmbeddingSystemDefaults,
  createDraft,
  getEmbeddingBadgeState,
} from "../../components/embedding-api-settings";

function defaults(
  configuredProvider: "cloud" | "local" | null = null,
): EmbeddingSystemDefaults {
  return {
    configuredProvider,
    cloud: {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "text-embedding-3-small",
      hasApiKey: configuredProvider === "cloud",
      ready: configuredProvider === "cloud",
    },
    local: {
      model: "Xenova/all-MiniLM-L6-v2",
      device: "cpu",
      localFilesOnly: false,
      ready: true,
    },
  };
}

function setting(overrides: Partial<EmbeddingSetting> = {}): EmbeddingSetting {
  return {
    id: "s-1",
    userId: "u-1",
    providerType: "cloud",
    baseUrl: null,
    model: null,
    device: null,
    localFilesOnly: false,
    enabled: true,
    hasApiKey: false,
    ...overrides,
  };
}

describe("EmbeddingApiSettings — getEmbeddingBadgeState", () => {
  it("returns 'Not configured' (secondary) when UNSET (no setting, configuredProvider=null)", () => {
    expect(getEmbeddingBadgeState(null, null)).toEqual({
      variant: "secondary",
      labelKey: "settings.aiSettingsNotConfigured",
      labelFallback: "Not configured",
    });
  });

  it("returns 'System default' (secondary) when cloud is configured but no user override", () => {
    expect(getEmbeddingBadgeState(null, "cloud")).toEqual({
      variant: "secondary",
      labelKey: "settings.aiSettingsSystem",
      labelFallback: "System default",
    });
  });

  it("returns 'System default' (secondary) when local is configured but no user override", () => {
    expect(getEmbeddingBadgeState(null, "local")).toEqual({
      variant: "secondary",
      labelKey: "settings.aiSettingsSystem",
      labelFallback: "System default",
    });
  });

  it("returns 'User override' (default) when a user setting is present, regardless of configuredProvider", () => {
    const userSetting = setting({ providerType: "cloud", hasApiKey: true });
    expect(getEmbeddingBadgeState(userSetting, null)).toEqual({
      variant: "default",
      labelKey: "settings.aiSettingsOverride",
      labelFallback: "User override",
    });
    // Even when the system is UNSET, a user override wins.
    expect(getEmbeddingBadgeState(userSetting, null).labelKey).toBe(
      "settings.aiSettingsOverride",
    );
  });

  it("returns 'User override' (default) for a local user setting", () => {
    const userSetting = setting({ providerType: "local" });
    expect(getEmbeddingBadgeState(userSetting, "cloud")).toEqual({
      variant: "default",
      labelKey: "settings.aiSettingsOverride",
      labelFallback: "User override",
    });
  });
});

describe("EmbeddingApiSettings — createDraft", () => {
  it("leaves providerType=null and model='' in the UNSET state (no preselected card, no form)", () => {
    const draft = createDraft(null, defaults(null));

    // No provider card highlighted.
    expect(draft.providerType).toBeNull();
    // Cloud form fields (model) stay blank so Save stays disabled.
    expect(draft.model).toBe("");
    // baseUrl still defaults to the system base URL — that's a Cloud-only
    // concern and is irrelevant when no provider is selected.
    expect(draft.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(draft.localFilesOnly).toBe(false);
  });

  it("preselects cloud and seeds the cloud model when system cloud is configured", () => {
    const draft = createDraft(null, defaults("cloud"));

    expect(draft.providerType).toBe("cloud");
    expect(draft.model).toBe("text-embedding-3-small");
    expect(draft.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("preselects local and seeds the local model when system local is configured", () => {
    const draft = createDraft(null, defaults("local"));

    expect(draft.providerType).toBe("local");
    expect(draft.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("honors the user override's providerType even when the system is UNSET", () => {
    const userSetting = setting({
      providerType: "cloud",
      model: "custom-embed",
      baseUrl: "https://example.test/v1",
      hasApiKey: true,
    });
    const draft = createDraft(userSetting, defaults(null));

    expect(draft.providerType).toBe("cloud");
    expect(draft.model).toBe("custom-embed");
    expect(draft.baseUrl).toBe("https://example.test/v1");
  });

  it("honors a user override's local provider", () => {
    const userSetting = setting({
      providerType: "local",
      model: "user/local-model",
      device: "wasm",
      localFilesOnly: true,
    });
    const draft = createDraft(userSetting, defaults("cloud"));

    expect(draft.providerType).toBe("local");
    expect(draft.model).toBe("user/local-model");
    expect(draft.localFilesOnly).toBe(true);
  });
});
