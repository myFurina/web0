# TechShare · 技术资源共享与交流平台

一个面向学生/技术社区的**技术资源共享 + 论坛交流** Web 应用。用户可上传、下载技术资料，参与论坛讨论，管理员可后台管理资源与用户。

## 技术栈

- **前端**：原生 HTML / CSS / JavaScript（无框架，9 个页面）
- **后端**：Node.js + Express 5
- **数据库**：MySQL（用户、资源、帖子）
- **缓存 / 限流**：Redis（会话限流、验证码）
- **对象存储**：S3 兼容存储（Cloudflare R2 / MinIO / 自建 S3）
- **鉴权**：JWT（HS256）+ bcrypt 密码哈希
- **部署**：Docker / Pod Compose + Nginx 反向代理

## 功能模块

| 模块 | 说明 |
|------|------|
| 用户系统 | 注册、登录、验证码、个人资料、修改密码 |
| 技术资源库 | 资源上传/下载、分类、文件大小与分类标签 |
| 论坛 | 发帖、点赞、最新/最热排序 |
| 管理后台 | 资源管理、用户管理、重置密码、删除 |

## 目录结构

```
.
├── index.html / login.html / register.html   # 前端页面
├── share.html / source.html / forum.html     # 资源发布/资源大厅/论坛
├── mine.html / admin.html / talk.html        # 个人中心/管理后台/吐槽区
├── css/  js/                                 # 前端静态资源
├── backend/
│   ├── server.js                             # Express 主服务
│   ├── schema.sql                            # 数据库建表
│   ├── .env.example                          # 环境变量样例（**不含真实密钥**）
│   └── migrate-uploads-r2.js / sweep-orphans.js / scan-sensitive.js
├── compose.yaml                              # MySQL/Redis/App 编排
├── nginx.conf                                # 反向代理模板（__S3_*__ 占位）
├── start.sh / stop.sh                        # 一键启动/停止
└── Containerfile                             # 镜像构建
```

## 快速开始

> 不需要 Node 环境，用 Docker / Podman 一键起。

1. 复制环境变量样例并**务必修改必改项**：
   ```bash
   cd backend
   cp .env.example .env
   # 编辑 .env，至少改：DB_PASSWORD、JWT_SECRET
   ```

2. 启动：
   ```bash
   ./start.sh
   ```

3. 初始化数据库并提权管理员：
   ```bash
   mysql -h mysql -uroot -p"$DB_PASSWORD" < backend/schema.sql
   # 先在页面注册一个普通用户，再用 SQL 提权为 admin：
   # UPDATE users SET role='admin' WHERE username='你的用户名';
   ```

## 安全说明

- **所有密钥均通过环境变量注入**，仓库内不提交任何真实密码、Access Key、JWT 密钥。
- `JWT_SECRET` 缺失或使用默认值时后端直接拒绝启动。
- Nginx 中的 S3 配置为 `__S3_*__` 占位符，由 `start.sh` 在启动时从 `.env` 替换。
- 详见 `AUDIT.md`。

## License

[MIT](./LICENSE)
