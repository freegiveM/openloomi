// Phase 6 — re-export shim over `@melandlabs/insights/resolve-language`.
// The leaf module owns `resolveAgentLanguage` — picks the effective
// agent-prompt language from explicit `language` / auto-learned
// `languageAuto` settings. Pure utility, no external imports.

export { resolveAgentLanguage } from "@melandlabs/insights";
