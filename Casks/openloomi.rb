cask "openloomi" do
  if Hardware::CPU.intel?
    version "0.6.3"
    sha256 "8c0819293601bba3a6c89ebd2a56981627ffc3c9aa892eb48d13d7c4ff67ed9b"
    url "https://github.com/melandlabs/openloomi/releases/download/v0.6.3/openloomi_0.6.3_macOS_amd64.dmg"
  else
    version "0.6.3"
    sha256 "95f66b34a9ba083aaecabc482c9e20b3db985ec70fb2e951e1b5bced207de210"
    url "https://github.com/melandlabs/openloomi/releases/download/v0.6.3/openloomi_0.6.3_macOS_aarch64.dmg"
  end

  name "openloomi"
  desc "Open source AI workspace assistant"
  homepage "https://github.com/melandlabs/openloomi"

  auto_updates true

  app "openloomi.app"

  zap trash: [
    "~/Library/Application Support/com.openloomi.app",
    "~/Library/Logs/openloomi",
  ]
end
