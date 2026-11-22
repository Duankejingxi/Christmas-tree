#!/usr/bin/env bash
# 圣诞树一键部署（在腾讯云轻量服务器上用 root 运行）
#   用法：bash deploy.sh 你的域名
#   例如：bash deploy.sh tree.example.com
# 做的事：安装 Node 和 Caddy（自动 HTTPS）→ 拉代码 → 注册成开机自启的服务。可以重复运行（相当于升级）。
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "用法: bash deploy.sh 你的域名   例如: bash deploy.sh tree.example.com"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "请用 root 运行（先执行 sudo -i）"; exit 1; fi

REPO="${REPO:-https://github.com/Duankejingxi/Christmas-tree.git}"
BRANCH="${BRANCH:-claude/christmas-tree-photo-gallery-lrv14a}"
APP=/opt/christmas-tree
DATA=/var/lib/christmas-tree
NODE_VER="${NODE_VER:-v20.18.1}"
CADDY_VER="${CADDY_VER:-2.8.4}"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

case "$(uname -m)" in
  x86_64|amd64) NARCH=x64; CARCH=amd64 ;;
  aarch64|arm64) NARCH=arm64; CARCH=arm64 ;;
  *) echo "不支持的 CPU 架构: $(uname -m)"; exit 1 ;;
esac

say "1/6 检查基础工具（git、curl、tar）"
need=""
for c in git curl tar; do command -v $c >/dev/null 2>&1 || need="$need $c"; done
if [ -n "$need" ]; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y $need
  elif command -v dnf >/dev/null 2>&1; then dnf install -y $need
  elif command -v yum >/dev/null 2>&1; then yum install -y $need
  else echo "请先手动安装:$need"; exit 1; fi
fi

say "2/6 安装 Node.js（$NODE_VER）"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  echo "已有 Node $(node -v)，跳过"
else
  tmp=$(mktemp -d)
  curl -fSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NARCH.tar.gz" -o "$tmp/node.tgz" \
    || curl -fSL "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-linux-$NARCH.tar.gz" -o "$tmp/node.tgz"
  tar -xzf "$tmp/node.tgz" -C /usr/local --strip-components=1
  rm -rf "$tmp"
  echo "Node $(node -v) 安装完成"
fi
NODE_BIN="$(command -v node)"

say "3/6 安装 Caddy（自动申请并续期 HTTPS 证书）"
if [ -x /usr/local/bin/caddy ]; then
  echo "已有 Caddy，跳过"
else
  tmp=$(mktemp -d)
  curl -fSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VER/caddy_${CADDY_VER}_linux_${CARCH}.tar.gz" -o "$tmp/caddy.tgz"
  tar -xzf "$tmp/caddy.tgz" -C "$tmp" caddy
  install -m 0755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
fi

say "4/6 获取网页和后端代码"
id -u christmas >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin christmas
id -u caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --depth 1 origin "$BRANCH"
  git -C "$APP" reset --hard FETCH_HEAD
else
  rm -rf "$APP"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi
mkdir -p "$DATA"
chown -R christmas:christmas "$DATA"
chmod -R a+rX "$APP"

say "5/6 写入服务配置"
cat > /etc/systemd/system/christmas-api.service <<EOF
[Unit]
Description=Christmas tree server
After=network.target

[Service]
User=christmas
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA
ExecStart=$NODE_BIN $APP/server/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    encode zstd gzip
    request_body {
        max_size 4MB
    }
    reverse_proxy 127.0.0.1:3000
}
EOF

cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy (HTTPS for christmas tree)
After=network.target christmas-api.service

[Service]
User=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

say "6/6 启动服务"
systemctl daemon-reload
systemctl enable --now christmas-api
systemctl restart christmas-api
systemctl enable --now caddy
systemctl restart caddy
sleep 3

echo
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  echo "后端运行正常：$(curl -s http://127.0.0.1:3000/api/health)"
else
  echo "后端没起来，看日志：journalctl -u christmas-api -n 50 --no-pager"
fi
echo
echo "完成。现在在浏览器打开： https://$DOMAIN"
echo "（第一次访问前，请确认：域名已解析到本机公网 IP，并且轻量服务器防火墙已放行 TCP 80 和 443）"
echo "  升级：bash $APP/server/deploy.sh $DOMAIN"
echo "  看后端日志：journalctl -u christmas-api -f"
echo "  看证书/HTTPS 日志：journalctl -u caddy -f"
echo "  数据位置（备份这个目录）：$DATA"
