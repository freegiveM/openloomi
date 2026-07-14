// Loomi Pet — user-customizable theme system.
//
// The user can:
//   * Pick one of two built-in themes (`fox` or `capybara`).
//   * Add custom themes under `~/.openloomi/pet-custom/<name>/` —
//     each subdirectory whose PNG filenames match known state names
//     becomes a theme.
//   * Override individual state images for any theme via the config
//     file's `overrides` map.
//
// The single source of truth for everything user-facing is
// `~/.openloomi/pet-config.json` — it's a plain JSON file designed to
// be hand-edited or rewritten by external tools. The widget reads it
// on boot and on `pet:config-changed` events; the right-click menu
// only exposes a few shortcuts (open file, open folder, reload).
//
// All IO errors are swallowed at the read path and degrade to the
// default config (`activeTheme = fox`, no overrides). That's a
// deliberate choice: a malformed config must never crash the pet
// window. We surface the failure via the `console.warn`-equivalent
// in the host log instead.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Built-in theme name — kept in lock-step with `loomi-widget.html`'s
/// `BUILTIN_THEMES` map. If you add a new built-in, register it here
/// AND in the JS map.
pub const DEFAULT_THEME: &str = "fox";
pub const DEFAULT_CUSTOM_THEMES_DIR: &str = "~/.openloomi/pet-custom";
pub const CONFIG_FILENAME: &str = "pet-config.json";
pub const BUILTIN_THEMES: &[&str] = &["fox", "capybara"];

/// State keys we recognize when scanning a custom theme directory.
/// Anything that doesn't normalize to one of these is ignored.
const KNOWN_STATES: &[&str] = &[
    "idle",
    "thinking",
    "sweeping",
    "working",
    "needsinput",
    "greet",
    "sleeping",
    "juggling",
    "happy",
    "presenting",
];

/// On-disk configuration shape. Mirrors the JSON the user edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetConfig {
    pub version: u32,
    #[serde(default = "default_active_theme")]
    pub active_theme: String,
    #[serde(default = "default_custom_dir")]
    pub custom_themes_dir: String,
    #[serde(default)]
    pub overrides: HashMap<String, HashMap<String, PathBuf>>,
    /// ISO 8601 stamp; we update this on every successful write.
    #[serde(default)]
    pub updated_at: Option<String>,
}

fn default_active_theme() -> String {
    DEFAULT_THEME.to_string()
}

fn default_custom_dir() -> String {
    DEFAULT_CUSTOM_THEMES_DIR.to_string()
}

impl Default for PetConfig {
    fn default() -> Self {
        Self {
            version: 1,
            active_theme: DEFAULT_THEME.to_string(),
            custom_themes_dir: DEFAULT_CUSTOM_THEMES_DIR.to_string(),
            overrides: HashMap::new(),
            updated_at: None,
        }
    }
}

/// Wire-shape view sent to the JS side. Same as `PetConfig` plus a
/// derived `customThemes: Vec<String>` listing directory names.
///
/// `rename_all = "camelCase"` matches the JS convention — without it
/// the widget reads `view.activeTheme` (camelCase) but receives
/// `active_theme` (snake_case) and silently no-ops the assignment.
/// That was the root cause of "switch theme doesn't work": the
/// command *did* update disk and returned a fresh view, but the JS
/// side never saw the new `activeTheme` so the menu tick and the
/// painted sprite never moved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetConfigView {
    pub version: u32,
    pub active_theme: String,
    pub custom_themes_dir: String,
    /// Maps `theme_name → { state_name → path }`. For built-ins the
    /// path is the bundled asset URL; for custom themes the path is
    /// an absolute filesystem path (the widget converts to
    /// `asset://localhost/<encoded-path>` via `convertFileSrc`).
    pub overrides: HashMap<String, HashMap<String, OverrideRef>>,
    /// All custom theme names discovered under `customThemesDir`.
    pub custom_themes: Vec<String>,
    pub updated_at: Option<String>,
}

/// One override entry — wraps the path with a `kind` discriminator so
/// the JS side knows whether to render an asset URL (bundled) or to
/// convert to an `asset://` URL (user-provided absolute path).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OverrideRef {
    Asset { path: String },
    Absolute { path: PathBuf },
}

impl PetConfig {
    /// Read the config from disk. Any IO/parse failure yields a
    /// `PetConfig::default()` so the widget always has *something*
    /// usable on cold boot.
    pub fn read(app: &AppHandle) -> Self {
        let path = config_path(app);
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<PetConfig>(&bytes) {
                Ok(cfg) => cfg,
                Err(e) => {
                    eprintln!(
                        "[loomi-pet/theme] failed to parse {}: {e}; using defaults",
                        path.display()
                    );
                    Self::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => {
                eprintln!(
                    "[loomi-pet/theme] failed to read {}: {e}; using defaults",
                    path.display()
                );
                Self::default()
            }
        }
    }

    /// Resolve the absolute path of the user's custom themes dir
    /// (expanding the leading `~/`).
    pub fn custom_themes_path(&self) -> PathBuf {
        expand_home(&self.custom_themes_dir)
    }

    /// Resolve the absolute filesystem path for one (theme, state)
    /// override — returns `None` if there's no override configured.
    pub fn override_path(&self, theme: &str, state: &str) -> Option<PathBuf> {
        self.overrides
            .get(theme)
            .and_then(|m| m.get(state))
            .cloned()
    }
}

/// Convenience free-function — equivalent to `PetConfig::read(app)`.
pub fn read_config(app: &AppHandle) -> PetConfig {
    PetConfig::read(app)
}

/// Atomically write the config. We write to a sibling `.tmp` file and
/// `rename` into place — on POSIX that's atomic; on Windows it's
/// best-effort but still safer than a streaming write.
pub fn write_config(app: &AppHandle, cfg: &PetConfig) -> Result<(), String> {
    let path = config_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut to_write = cfg.clone();
    to_write.updated_at = Some(now_iso());
    let bytes =
        serde_json::to_vec_pretty(&to_write).map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename tmp → final: {e}"))?;
    let _ = app; // reserved: future "config persisted" event hook
    Ok(())
}

/// Where the config file lives. Always under the user's home
/// directory so external tools can find it.
pub fn config_path(app: &AppHandle) -> PathBuf {
    let mut p = home_dir(app).join(".openloomi");
    p.push(CONFIG_FILENAME);
    p
}

/// The bundled assets directory for a built-in theme, as a URL-
/// friendly path the webview can load.
pub fn builtin_theme_base_dir(theme: &str) -> Option<PathBuf> {
    if !BUILTIN_THEMES.contains(&theme) {
        return None;
    }
    Some(PathBuf::from(format!("loomi-pet/assets/{theme}")))
}

/// Resolve the sprite URL/path for an `(theme, state)` pair, applying
/// overrides when present. The widget uses this when building the
/// `PetConfigView` — keeps the resolve priority centralized.
///
/// For built-ins the asset path matches the on-disk filename
/// convention (`loomi-pet/assets/<theme>/<sprite_prefix>-<state>.png`).
/// The sprite prefix is NOT the same as the theme name — `fox` ships
/// with the legacy `loomi-` prefix while `capybara` uses `capybara-`.
/// We centralise that mapping in `builtin_sprite_prefix` so the JS
/// `BUILTIN_THEMES` map and the Rust resolver stay in lock-step.
pub fn resolve_sprite(cfg: &PetConfig, theme: &str, state: &str) -> Option<OverrideRef> {
    if let Some(path) = cfg.override_path(theme, state) {
        return Some(OverrideRef::Absolute { path });
    }
    let prefix = builtin_sprite_prefix(theme)?;
    builtin_theme_base_dir(theme).map(|base| OverrideRef::Asset {
        path: format!("{}/{}-{}.png", base.display(), prefix, state),
    })
}

/// Sprite filename prefix for a built-in theme. The directory name
/// follows the theme (`loomi-pet/assets/<theme>/`) but the file
/// prefix is independent — `fox` keeps the legacy `loomi-` prefix
/// while `capybara` uses `capybara-`. Returns `None` for unknown
/// themes so the caller falls through to `None`.
fn builtin_sprite_prefix(theme: &str) -> Option<&'static str> {
    match theme {
        "fox" => Some("loomi"),
        "capybara" => Some("capybara"),
        _ => None,
    }
}

/// Scan `cfg.custom_themes_dir` for sub-directories that contain at
/// least one recognizable state PNG. Returned list is alphabetized.
pub fn list_custom_themes(cfg: &PetConfig) -> Vec<String> {
    let dir = cfg.custom_themes_path();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if !p.is_dir() {
                return None;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            if has_known_state_png(&p) {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    out.sort();
    out
}

/// Build a `PetConfigView` from a `PetConfig` and a freshly discovered
/// list of custom theme names. Includes override entries for both
/// built-ins AND custom themes (resolved via the per-theme override
/// map on the config).
pub fn build_view(cfg: PetConfig, custom_themes: Vec<String>) -> PetConfigView {
    let mut overrides: HashMap<String, HashMap<String, OverrideRef>> = HashMap::new();
    let mut themes_to_emit: Vec<String> = BUILTIN_THEMES.iter().map(|s| s.to_string()).collect();
    for t in &custom_themes {
        themes_to_emit.push(t.clone());
    }
    for theme in themes_to_emit {
        let mut m = HashMap::new();
        for state in KNOWN_STATES {
            if let Some(r) = resolve_sprite(&cfg, &theme, state) {
                m.insert((*state).to_string(), r);
            }
        }
        overrides.insert(theme, m);
    }
    PetConfigView {
        version: cfg.version,
        active_theme: cfg.active_theme,
        custom_themes_dir: cfg.custom_themes_dir,
        overrides,
        custom_themes,
        updated_at: cfg.updated_at,
    }
}

// --- internals ---------------------------------------------------------

/// `~/.openloomi/pet-custom/<name>/` — does the directory contain at
/// least one recognized state PNG?
fn has_known_state_png(dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return false;
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        if p.extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            != Some("png".into())
        {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if KNOWN_STATES.contains(&normalize_state_key(stem).as_str()) {
                return true;
            }
        }
    }
    false
}

/// Strip any `<theme>-` prefix and lowercase. Used so a theme can
/// keep its sprites named `loomi-idle.png`, `capybara-idle.png`, or
/// just `idle.png`.
///
/// Strategy:
///   1. Try the known built-in theme names (`fox-`, `capybara-`) and
///      the legacy `loomi-` alias.
///   2. As a fallback, peel off *any* prefix ending in `-` so custom
///      themes that follow the `<theme-name>-<state>.png` convention
///      (e.g. `my-pack-sweeping.png`) still classify correctly. We
///      keep only the last segment after `-` if the suffix is a
///      recognized state.
///
/// Both branches lowercase for case-insensitive matching.
pub fn normalize_state_key(stem: &str) -> String {
    let lower = stem.to_ascii_lowercase();
    let known_prefixes: &[&str] = &["fox-", "loomi-", "capybara-"];
    for prefix in known_prefixes {
        if let Some(rest) = lower.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    // Generic `<anything>-<state>` strip — preserves the suffix so
    // users get the expected key (e.g. `my-pack-sweeping` →
    // `sweeping`) without us having to know about every custom
    // theme name at compile time. We search from the right so multi-
    // hyphen theme names like `my-pack` work.
    if let Some(idx) = lower.rfind('-') {
        let rest = &lower[idx + 1..];
        if KNOWN_STATES.contains(&rest) {
            return rest.to_string();
        }
    }
    lower
}

fn home_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn expand_home(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(raw)
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal RFC3339-ish formatter — we don't need timezone precision
    // for an updatedAt stamp.
    let (year, month, day, h, m, s) = epoch_to_ymdhms(secs);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

fn epoch_to_ymdhms(secs: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = (secs % 60) as u32;
    let m = ((secs / 60) % 60) as u32;
    let h = ((secs / 3600) % 24) as u32;
    let days = (secs / 86_400) as i64;
    let (y, mo, d) = civil_from_days(days);
    (y, mo, d, h, m, s)
}

/// Inverse of `days_from_civil` from the watcher module — Howard
/// Hinnant's date algorithm. Returned `(y, m, d)` is the Gregorian
/// date of the given Unix-day count.
fn civil_from_days(z: i64) -> (u32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y_signed = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d_signed = doy - (153 * mp + 2) / 5 + 1;
    let m_signed = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m_signed <= 2 {
        y_signed + 1
    } else {
        y_signed
    };
    (y as u32, m_signed as u32, d_signed as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_fox() {
        let cfg = PetConfig::default();
        assert_eq!(cfg.active_theme, "fox");
        assert_eq!(cfg.custom_themes_dir, "~/.openloomi/pet-custom");
        assert!(cfg.overrides.is_empty());
    }

    #[test]
    fn normalize_strips_known_prefixes() {
        assert_eq!(normalize_state_key("loomi-idle"), "idle");
        assert_eq!(normalize_state_key("capybara-thinking"), "thinking");
        assert_eq!(normalize_state_key("presenting"), "presenting");
        assert_eq!(normalize_state_key("MY-PACK-SWEEPING"), "sweeping");
    }

    #[test]
    fn resolve_sprite_uses_override_when_present() {
        let mut cfg = PetConfig::default();
        cfg.overrides
            .entry("fox".to_string())
            .or_default()
            .insert("idle".to_string(), PathBuf::from("/tmp/foxy.png"));
        match resolve_sprite(&cfg, "fox", "idle") {
            Some(OverrideRef::Absolute { path }) => {
                assert_eq!(path, PathBuf::from("/tmp/foxy.png"))
            }
            other => panic!("expected Absolute override, got {other:?}"),
        }
    }

    #[test]
    fn resolve_sprite_falls_back_to_asset_path() {
        let cfg = PetConfig::default();
        match resolve_sprite(&cfg, "fox", "idle") {
            Some(OverrideRef::Asset { path }) => {
                // Fox ships with the legacy `loomi-` filename prefix,
                // not `fox-` — see `builtin_sprite_prefix`.
                assert_eq!(path, "loomi-pet/assets/fox/loomi-idle.png");
            }
            other => panic!("expected Asset fallback, got {other:?}"),
        }
    }

    #[test]
    fn resolve_sprite_capybara_uses_capybara_prefix() {
        let cfg = PetConfig::default();
        match resolve_sprite(&cfg, "capybara", "idle") {
            Some(OverrideRef::Asset { path }) => {
                assert_eq!(path, "loomi-pet/assets/capybara/capybara-idle.png");
            }
            other => panic!("expected Asset fallback, got {other:?}"),
        }
    }

    #[test]
    fn resolve_sprite_unknown_theme_returns_none() {
        let cfg = PetConfig::default();
        assert!(resolve_sprite(&cfg, "no-such-theme", "idle").is_none());
    }

    #[test]
    fn custom_themes_dir_default_expands_under_home() {
        let cfg = PetConfig::default();
        let resolved = cfg.custom_themes_path();
        assert!(resolved.ends_with(".openloomi/pet-custom"));
    }

    #[test]
    fn view_serializes_with_camel_case_keys() {
        // The widget reads `view.activeTheme` / `view.customThemes`
        // — without `rename_all = "camelCase"` on `PetConfigView` the
        // keys arrive snake_case and the JS-side applyConfig silently
        // no-ops (the root cause of an earlier "switch theme doesn't
        // work" bug). Lock the wire format in.
        let cfg = PetConfig::default();
        let view = build_view(cfg, vec!["my-pack".into()]);
        let json = serde_json::to_value(&view).unwrap();
        assert!(
            json.get("activeTheme").is_some(),
            "expected `activeTheme` key"
        );
        assert!(
            json.get("active_theme").is_none(),
            "did not expect `active_theme` key"
        );
        assert!(
            json.get("customThemes").is_some(),
            "expected `customThemes` key"
        );
        assert!(
            json.get("custom_themes_dir").is_none(),
            "did not expect `custom_themes_dir` key"
        );
        assert_eq!(json["activeTheme"], "fox");
    }
}
