#!/usr/bin/env bash
# Install Docker CE directly inside WSL Ubuntu (no Docker Desktop, C: drive stays clean).
# Run inside WSL as a normal user (the script will sudo when needed):
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/install-docker-ce.sh

set -u

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }
err()  { printf "\033[1;31m%s\033[0m\n" "$*"; }

bold "Step 0: check WSL & sudo"
# Allow both root and non-root. If we're already root, replace sudo with a no-op.
if [ "$(id -u)" -eq 0 ]; then
    sudo() { "$@"; }
    ok "user: root (sudo passthrough enabled)"
else
    command -v sudo >/dev/null 2>&1 || { err "sudo not installed"; exit 1; }
    ok "user: $(whoami), sudo: OK"
fi

bold "Step 1: ensure iptables legacy mode is used (Docker on WSL needs this)"
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy 2>&1 | tail -2 || true
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>&1 | tail -2 || true
ok "iptables switched to legacy"

bold "Step 2: remove any old docker packages"
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    sudo apt-get remove -y $pkg 2>/dev/null || true
done
ok "old packages cleaned"

bold "Step 3: add Docker's official apt repository (Aliyun mirror first, fall back to docker.com)"
sudo apt-get update -o Acquire::ForceIPv4=true 2>&1 | tail -3

# Try Aliyun's docker-ce mirror first (faster in CN).
ALIYUN_KEYRING=/etc/apt/keyrings/docker.aliyun.gpg
if curl -fsSL --max-time 15 https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg -o /tmp/docker-aliyun.gpg 2>/dev/null; then
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo gpg --dearmor < /tmp/docker-aliyun.gpg | sudo tee $ALIYUN_KEYRING >/dev/null
    sudo chmod a+r $ALIYUN_KEYRING
    echo "deb [arch=$(dpkg --print-architecture) signed-by=$ALIYUN_KEYRING] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.aliyun.list >/dev/null
    ok "using Aliyun mirror for Docker apt"
else
    warn "Aliyun mirror failed, falling back to docker.com"
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o $ALIYUN_KEYRING
    sudo chmod a+r $ALIYUN_KEYRING
    echo "deb [arch=$(dpkg --print-architecture) signed-by=$ALIYUN_KEYRING] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    ok "using docker.com mirror"
fi

bold "Step 4: apt-get install docker-ce"
sudo apt-get update -o Acquire::ForceIPv4=true 2>&1 | tail -3
sudo apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>&1 | tail -8
ok "docker-ce installed: $(docker --version)"

bold "Step 5: configure registry mirror (Aliyun for image pulls)"
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://docker.mirrors.ustc.edu.cn"
  ],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "default-runtime": "runc",
  "storage-driver": "overlay2"
}
EOF
ok "daemon.json written with Aliyun + USTC mirrors"

bold "Step 6: enable & start dockerd"
sudo systemctl enable docker.service 2>&1 | tail -2
sudo systemctl start docker.service 2>&1 | tail -2
sleep 2

# If systemd isn't available in this WSL distro, fall back to direct dockerd.
if ! sudo systemctl is-active --quiet docker 2>/dev/null; then
    warn "systemd not active; starting dockerd directly in background"
    sudo nohup dockerd >/tmp/dockerd.log 2>&1 &
    sleep 4
fi

bold "Step 6: add current user to docker group (so 'docker' works without sudo)"
if [ "$(id -u)" -ne 0 ]; then
    sudo usermod -aG docker "$USER"
    ok "added $USER to docker group (re-login or run 'newgrp docker' to apply)"
else
    warn "running as root; skipping docker group add (root already has all capabilities via setuid docker socket)"
fi

bold "Step 8: smoke test"
docker --version
docker run --rm hello-world 2>&1 | head -10

bold "Step 9: check docker info"
docker info 2>&1 | head -25

bold "DONE"
ok "Docker CE is up. From a NEW WSL session (so the docker group takes effect):"
echo "  exit"
echo "  wsl"
echo "  docker run hello-world"
echo ""
echo "Then back to CL-bench:"
echo "  cd /mnt/d/clbench-work/continual-learning-bench"
echo "  /mnt/d/clbench-work/continual-learning-bench/.venv/bin/clbench setup --all"
echo "  /mnt/d/clbench-work/continual-learning-bench/.venv/bin/clbench run exploitable_poker --schedule quick_test --system openloomi --system.model claude-sonnet-4-5"
