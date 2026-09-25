#!/usr/bin/env bash
# TechShare 一键启动：./start.sh
# 幂等：容器存在则直接启动，不存在则创建；数据全在卷里，重建不丢。
# 顺序：network → mysql → redis → app → nginx（nginx 共享 app 网络，必须最后起）
set -u
cd "$(dirname "$0")"

NET=techshare
SUBNET=192.168.77.0/24
GW=192.168.77.1
# 配置与代码分离：密钥只住家目录，项目里不留 .env
ENV_FILE="$HOME/.config/techshare/.env"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺 $1，请先安装 podman"; exit 1; }; }
need podman
[ -f "$ENV_FILE" ] || { echo "缺 $ENV_FILE，按 backend/.env.example 建一份"; exit 1; }

# 读配置（值可能含空格，只取键值，不执行）
getenv() { python3 -c "print([l.split('=',1)[1].rstrip('\n') for l in open('$ENV_FILE', encoding='utf-8-sig') if l.startswith('$1=')][0])" 2>/dev/null; }
DBPW="$(getenv DB_PASSWORD)"

echo "== [1/5] 网络 =="
if ! podman network exists "$NET" 2>/dev/null; then
  podman network create --subnet "$SUBNET" --gateway "$GW" "$NET"
else
  echo "network $NET 已存在"
fi

echo "== [2/5] MySQL =="
if podman container exists ts-mysql 2>/dev/null; then
  podman start ts-mysql >/dev/null
else
  podman run -d --name ts-mysql --network "$NET" \
    -e MYSQL_ROOT_PASSWORD="$DBPW" \
    -e MYSQL_DATABASE=tech_share \
    -v ts-mysql-data:/var/lib/mysql \
    -v "$(pwd)/backend/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro,z" \
    docker.io/library/mysql:8.4 >/dev/null
fi
echo "等 MySQL 就绪..."
for _ in $(seq 1 30); do
  podman exec ts-mysql mysqladmin ping -h 127.0.0.1 -uroot -p"$DBPW" 2>/dev/null && break
  sleep 3
done
podman exec ts-mysql mysqladmin ping -h 127.0.0.1 -uroot -p"$DBPW" 2>/dev/null || { echo "MySQL 起不来，看日志：podman logs ts-mysql"; exit 1; }

echo "== [3/5] Redis =="
# 密码来自 .env 的 REDIS_PASSWORD（没有则无密码直连，保持本地开发零改动）
RWPW="$(getenv REDIS_PASSWORD)"
RCMD="docker.io/library/redis:alpine"
if [ -n "$RWPW" ]; then RSET=(redis-server --save "" --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass "$RWPW"); else RSET=(); fi
if podman container exists ts-redis 2>/dev/null; then
  podman start ts-redis >/dev/null
else
  podman run -d --name ts-redis --network "$NET" $RCMD "${RSET[@]}" >/dev/null
fi
if [ -n "$RWPW" ]; then podman exec ts-redis redis-cli -a "$RWPW" ping 2>/dev/null | grep -q PONG || { echo "Redis 起不来"; exit 1; }
else podman exec ts-redis redis-cli ping 2>/dev/null | grep -q PONG || { echo "Redis 起不来"; exit 1; }; fi
unset RWPW

echo "== [4/5] App（8080 发布在这里） =="
if podman container exists app 2>/dev/null; then
  podman start app >/dev/null
else
  podman run -d --name app --network "$NET" \
    -p 127.0.0.1:8080:80 \
    --env-file "$ENV_FILE" \
    -e DB_HOST=ts-mysql \
    -e DB_PORT=3306 \
    -e CLUSTER=1 \
    -e CLUSTER_WORKERS=8 \
    localhost/techshare-app:latest >/dev/null
fi
echo "等 App 就绪..."
for _ in $(seq 1 30); do
  # 3000 只在容器内网监听，从容器内探活
  podman exec app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 3
done

echo "== [5/5] Nginx（共享 app 网络，必须最后起） =="
# 按配置渲染 nginx S3 占位（不提交真实桶名到仓库）
render_nginx() {
  ENV_FILE="$ENV_FILE" python3 - "$@" <<'PY'
import sys, re, os
env = {}
try:
  for line in open(os.environ['ENV_FILE'], encoding='utf-8-sig'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k, v = line.split('=', 1)
    env[k.strip()] = v.strip()
except FileNotFoundError:
  pass
ep = (env.get('S3_ENDPOINT') or '').strip().rstrip('/')
if not ep and env.get('R2_ACCOUNT_ID'):
  ep = f"https://{env['R2_ACCOUNT_ID'].strip()}.r2.cloudflarestorage.com"
if not ep:
  ep = 'https://s3.example.com'
if not re.match(r'^[a-z][a-z0-9+.-]*://', ep, re.I):
  ep = 'https://' + ep
host = re.sub(r'^https?://', '', ep)
base = ep
bucket = (env.get('S3_BUCKET') or env.get('R2_BUCKET') or 'placeholder-bucket').strip() or 'placeholder-bucket'
ua = env.get('S3_USER_AGENT', '') or 'TechShare/1.0'
ua = ua.replace('"', '')
s = open('nginx.conf', encoding='utf-8').read()
s = s.replace('__S3_HOST__', host).replace('__S3_BASE__', base).replace('__S3_BUCKET__', bucket).replace('__S3_UA__', ua)
open('/tmp/techshare-nginx.rendered.conf', 'w', encoding='utf-8').write(s)
PY
}
render_nginx
# Nginx 每次重建（配置由 .env 渲染，复用旧容器会吃到过期配置；无状态，重建无损）
podman rm -f ts-nginx >/dev/null 2>&1 || true
podman run -d --name ts-nginx --network container:app \
  -v "/tmp/techshare-nginx.rendered.conf:/etc/nginx/nginx.conf:ro,z" \
  -v "$(pwd):/usr/share/web:ro,z" \
  localhost/techshare-nginx:latest >/dev/null
sleep 4

echo "== 验活 =="
if curl -s --max-time 10 http://127.0.0.1:8080/api/health | grep -q '"db":"up"'; then
  echo "✅ 启动成功：http://localhost:8080/ （管理账号见 启动说明.md）"
  podman ps --format "  {{.Names}} {{.Status}}"
else
  echo "❌ 接口未就绪，排查：podman ps; podman logs app --tail 20; podman logs ts-nginx --tail 20"
  exit 1
fi
