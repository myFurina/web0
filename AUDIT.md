# TechShare 安全与优化审阅报告（2026-09-19）

> 范围：`backend/server.js`、`backend/sigv4.js`、`backend/schema.sql`、`nginx.conf`、`compose.yaml`、`Containerfile`、`start.sh`、`js/*.js`、`*.html`
> 目标：给出可执行的修复清单，修完可上公网。

## 0. 已确认的好点（保持）

- `.env` 已在 `.gitignore`，`git ls-files` 无 `.env`，`.dockerignore` 也排除了 `.env`。
- SQL 全用 `?` 占位符，无拼接注入；`rclone` 全用 `spawn/execFileSync(args数组)`，无 shell 注入。
- 上传白名单排除了 `.html/.svg`，`helmet + compression + rate-limit + Redis共享计数` 方向对。

## 1. 高危（P0，上公网前必修）

### P0-1 鉴权可伪造 — `backend/server.js:406-418,535,548,604,792,841,898`
- 现状：`authOptional` 无 JWT 时回落 `x-username`；`PUT /api/user/profile` 只信 body 的 `oldUsername`；删用户/资源/帖子只信 `operator = req.username || x-username`。
- 复现：`curl -H "x-username: admin" -X DELETE http://localhost:8080/api/users/xxx`
- 修复：
  1. 删 `x-username` 回落，只认 `Authorization: Bearer JWT`。
  2. 写操作一律取 `req.username`（JWT 解出），不信 body/header 的 `username/uploader/operator`。
  3. `PUT /api/user/profile` 加 `if (req.username !== oldUsername && !isAdmin) return 403`。
  4. `POST /api/comments,/api/posts,/api/resources/upload,/register` 的 `username/uploader` 改为服务端填入。
- 验证：不带 JWT 调写接口应 `401`；伪造 `x-username: admin` 应 `401/403`；正常登录流程全通。

### P0-2 存储型 XSS — `js/front.js:20-32,77-95`、`js/admin.js:79-131`、`forum.html:129,165,179`、`talk.html:133`、`source.html:363`、`mine.html:360`
- 现状：`innerHTML + ${title/content/username/category}` 直接拼接，后端无过滤。
- 修复：新增 `js/escape.js: escapeHtml()`，所有渲染点先转义；后端入库加长度校验（title<=200, content<=5000）；`admin.js handleDelete('${username}')` 改用 `data-username + addEventListener`，消掉单引号断句。
- 验证：发 `<img src=x onerror=alert(1)>` 标题/评论，前台显示为文本不执行；进 `admin.html` 无弹窗。

### P0-3 硬编码秘密 + 默认密钥
- `启动说明.md:18-22` 明文 `admin/[已轮换-见启动说明]`；`backend/server.js:410,431` 回落 `'dev-secret-change-me'`；`nginx.conf:40-43` 真实 `s3_host/s3_bucket`。
- 修复：文档删密码，改写“注册后 SQL 提权”；`JWT_SECRET` 缺失直接 `console.error + process.exit(1)`；轮换 admin 密码哈希；`nginx.conf` 四个 `set` 改为构建时模板替换，不提交真实值。
- 验证：`grep -r "[已轮换-见启动说明]\|[已脱敏]" .` 无命中；删 `JWT_SECRET` 启动应退出非零。

## 2. 中危（P1）

### P1-1 任意文件删/读 — `backend/server.js:324-343,764-789,746`
- `POST /api/resources/register` 的 `fileUrl` 无校验入库，`removeFile/download` 用 `path.join(__dirname,'..',fileUrl)`。
- 修复：`register` 白名单：`^/uploads/[a-zA-Z0-9._/-]+$` 或 `^(resources|avatars)/` 裸 key 或 `publicBase` 前缀；`download/remove` 用 `path.resolve` 卡在 `uploads/` 内，越界 `403`。
- 验证：传 `fileUrl=/uploads/../../etc/passwd` 应 `400`；`download` 越界应 `403`。

### P1-2 CORS 全开 — `backend/server.js:131-137`
- `origin: true` 反射任意源。修复：`CORS_ORIGIN` 必配，默认 `http://localhost:8080`，非白名单 `403`。

### P1-3 后台纯前端守卫 — `js/admin.js:7-14`
- 修复：进页先 `GET /api/auth/me` 验 JWT role，非 admin 踢到 `login.html`。

### P1-4 上传校验弱 — `backend/server.js:218-236`
- 修复：加 magic bytes 校验；`uploads` 响应加 `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`。

### P1-5 Nginx 静态越权面 — `nginx.conf:88-96`
- 项目根全挂载 `.:/usr/share/web:ro`，正则 `^/(backend|node_modules|.git)/` 可被大小写/编码绕过，且绕过 Node 的 helmet。
- 修复：只挂 `*.html/css/js/uploads`；正则加 `(?i)`；Nginx 加 `X-Frame-Options/CSP/HSTS` 头。

## 3. 优化（P2）

### P2-1 DB 连接爆炸 — `backend/server.js:181` × `start.sh:63`
- `8 worker × 每worker pool 30 = 240 > MySQL max 151`。
- 修复：`POOL = max(5, ceil(30/WORKERS))`，8 worker 时每 worker 4；或 workers 改 `min(ncpu,4)`。
- 验证：`SHOW VARIABLES LIKE 'max_connections'; SHOW STATUS LIKE 'Threads_connected'; ss -Htnp state established '( dport = :3306 )' | wc -l`；`ab -k -c100 -n5000 /api/resources` 时 `Threads_connected` 不顶满。

### P2-2 慢查询 — `backend/server.js:624`
- `WHERE title LIKE %xx%` 走不了索引。修复：`resources(title,description)` 加 `FULLTEXT`，查询改 `MATCH(title,description) AGAINST(? IN NATURAL LANGUAGE MODE)`，无命中回落 LIKE。
- 验证：`EXPLAIN` 看到 `fulltext`；`keyword` 查询 <200ms。

### P2-3 其他
- `GET /api/users:593` 无分页无鉴权：加 `requireAdmin + LIMIT 500`。
- bcrypt DoS：login/register 密码截断 72 字节，加长度 `3..72` 校验。
- 加 `morgan` access log + 慢 SQL 日志（>500ms warn）。

## 4. 执行顺序（给 agent）

1. P0-1 鉴权 → 跑登录/发帖/删帖回归。
2. P0-2 XSS → 跑 payload 验证。
3. P0-3 秘密清理 + 轮换 admin。
4. P1-1/P1-2/P1-5 → 跑越界/CORS/静态绕过验证。
5. P2-1/P2-2 → 跑 `ab` + `EXPLAIN`。
6. `grep` 全仓确认无秘密残留，`podman ps + curl /healthz + /api/health` 全绿。

## 5. 验收命令（只读）

```bash
podman exec ts-mysql mysql -uroot -p"$DBPW" -e "SHOW VARIABLES LIKE 'max_connections'; SHOW STATUS LIKE 'Threads_connected';"
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/api/health
curl -s -H "x-username: admin" -X DELETE http://127.0.0.1:8080/api/users/nobody | grep -q "401\|403" && echo AUTH_OK
grep -rn "dev-secret-change-me\|[已轮换-见启动说明]" --exclude-dir=node_modules --exclude-dir=.git . && echo SECRET_LEAK || echo SECRET_CLEAN
```




