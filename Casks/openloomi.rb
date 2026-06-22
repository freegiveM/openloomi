cask "openloomi" do
  if Hardware::CPU.intel?
    version "0.6.1"
    sha256 "237c9cacae04fd02b79c1ae7afe504ad08257e83764598cf861b6845bf22da5c"
    url "https://github.com/melandlabs/openloomi/releases/download/v0.6.1/openloomi_0.6.1_macOS_amd64.dmg"
  else
    version "0.6.1"
    sha256 "fe7f3f6e12529e9f56d584b6b8a5b8a5356034cf7288f17ccb171f1a650f5a6d"
    url "https://github.com/melandlabs/openloomi/releases/download/v0.6.1/openloomi_0.6.1_macOS_aarch64.dmg"
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
