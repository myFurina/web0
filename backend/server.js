// TechShare Server（高并发版）
// 保持原有路由与 {code,msg,data} 返回格式不变，增量：
// - mysql2/promise 连接池；bcrypt 全异步；列表分页（data 仍是数组，分页信息放 pagination 字段，前端无感）
// - cluster 多 worker（CLUSTER=1 开启）；compression/helmet/cors/限流；/healthz 健康检查；优雅关闭
// - 文件两轨：标准 S3（含 R2）SDK 直写 → 回落 Node 中转本地 uploads/；未配时上传接口 501，不崩服务
// - JWT 鉴权：只认 Authorization: Bearer <token>（x-username 回落默认关闭）
// - 静态收窄：禁掉 /backend、/node_modules、点文件、.git、all_code.txt 等敏感路径

const cluster = require('cluster');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const bcrypt = require('bcryptjs'); // 纯 JS，无原生编译，5.x 哈希($2b$)直接兼容
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(os.homedir(), '.config', 'techshare', '.env') });

// ---------- 对象存储（标准 S3 / R2，走 AWS SDK） ----------
// 新变量 S3_* 优先；老 R2_* 自动兼容（线上零改动）。
let S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, getSignedUrl, createPresignedPost;
try {
  ({ S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } =
    require('@aws-sdk/client-s3'));
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  ({ createPresignedPost } = require('@aws-sdk/s3-presigned-post'));
} catch (_) {
  // 没装 @aws-sdk/* 时自动降级为本地存储
}

const Store = {
  get endpoint() {
    let ep = '';
    if (process.env.S3_ENDPOINT) ep = process.env.S3_ENDPOINT;
    else if (process.env.R2_ACCOUNT_ID)
      ep = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    ep = String(ep).trim().replace(/\/+$/, '');
    if (ep && !/^[a-z][a-z0-9+.-]*:\/\//i.test(ep)) ep = 'https://' + ep; // 控制台抄的值可能没带 scheme
    return ep;
  },
  get bucket() {
    return process.env.S3_BUCKET || process.env.R2_BUCKET || '';
  },
  get publicBase() {
    return (process.env.S3_PUBLIC_URL || process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  },
  get configured() {
    const ak = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
    const sk = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
    return !!(S3Client && this.endpoint && this.bucket && ak && sk);
  },
  client() {
    const ak = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
    const sk = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
    const c = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: this.endpoint,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: { accessKeyId: ak, secretAccessKey: sk },
    });
    // 精确覆盖 UA（SDK 默认 UA 是 aws-sdk-js/...，追加怕对方做精确匹配）
    const ua = process.env.S3_USER_AGENT;
    if (ua && c.middlewareStack) {
      c.middlewareStack.add(
        (next) => async (args) => {
          if (args.request && args.request.headers) args.request.headers['user-agent'] = ua;
          return next(args);
        },
        { step: 'build', name: 'forceUserAgent', override: true }
      );
    }
    return c;
  },
  key(prefix, filename) {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = Math.round(Math.random() * 1e9);
    return `${prefix}/${ymd}/${Date.now()}-${rand}-${filename}`;
  },
  publicUrl(key) {
    return this.publicBase ? `${this.publicBase}/${key}` : null;
  },
  keyFromPublicUrl(url) {
    try {
      const base = this.publicBase;
      if (base && url.startsWith(base + '/')) return url.slice(base.length + 1);
    } catch (_) {}
    return null;
  },
};

// ---------- cluster ----------
if (process.env.CLUSTER === '1' && cluster.isPrimary) {
  // worker 数：默认 min(核数,8)，CLUSTER_WORKERS 可覆盖；读多写少场景 worker 即吞吐
  const workers = Math.max(1, Math.min(os.cpus().length, Number(process.env.CLUSTER_WORKERS || 8)));
  console.log(`[cluster] primary ${process.pid}, fork ${workers} workers`);
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (w, code) => {
    console.error(`[cluster] worker ${w.process.pid} exited(${code}), refork`);
    cluster.fork();
  });
} else {
  start().catch((e) => {
    console.error('[fatal] 启动失败:', e.message);
    process.exit(1);
  });
}

async function start() {
  // P0-3: JWT_SECRET 缺失直接退出，杜绝默认密钥伪造
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me') {
    console.error('[fatal] 缺少 JWT_SECRET（禁止使用默认值），请在 .env 配置后启动');
    process.exit(1);
  }
  const JWT_SECRET = process.env.JWT_SECRET;
  const app = express();
  app.set('trust proxy', 1); // 跑在 Nginx 后面，限流取真实 IP
  app.disable('x-powered-by');

  // ---------- 基础中间件 ----------
  app.use(helmet({
    crossOriginResourcePolicy: false,
    // P1-5: 基础安全头（静态直传场景保持可用）
    frameguard: { action: 'sameorigin' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  })); // 关 CORP，兼容同源静态+图片
  // compression 只压静态/大响应：API 小 JSON 压缩纯浪费 CPU，跳过 /api 和 /healthz
  app.use(compression({ filter: (req, res) => {
    if (req.path === '/healthz' || req.path.startsWith('/api/')) return false;
    return compression.filter(req, res);
  } }));
  // P1-2: CORS 默认收窄，不再反射任意源
  const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:8080').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // curl/同源无 Origin 放行
        if (corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('CORS forbidden'), false);
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.use(express.json({ limit: '1mb' }));

  // ---------- 限流（阈值走环境变量：压测时调高，生产按正常用户行为调） ----------
  // cluster 多 worker 时内存计数会 ×N，必须用 Redis 共享计数（已有 Redis，直接复用；连不上自动回退内存）
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  let makeStore = null;
  if (process.env.REDIS_URL) {
    try {
      const { RedisStore } = require('rate-limit-redis');
      const { createClient } = require('redis');
      const lc = createClient({ url: process.env.REDIS_URL });
      lc.on('error', () => {});
      lc.connect().catch(() => {});
      // 每个 limiter 独立 prefix，否则 api/auth/upload 的计数会串
      makeStore = (prefix) => new RedisStore({ sendCommand: (...args) => lc.sendCommand(args), prefix });
    } catch (_) {
      makeStore = null;
    }
  }
  const limitOpts = (max, prefix) => ({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Redis 挂了放行（fail-open 保可用， alternatives 是全站 500；恢复后自动续限）
    passOnStoreError: true,
    // 按 Nginx 传来的真实客户端 IP 限流。注意不能用默认 req.ip：
    // trust proxy 在 cluster/多跳下拿到的经常是 Nginx 自身 IP，会导致全站共用一个桶。
    // X-Real-IP 由 Nginx 强制覆盖（proxy_set_header），外部伪造不进来，3000 端口也不对外。
    keyGenerator: (req) => req.headers['x-real-ip'] || req.ip,
    ...(makeStore ? { store: makeStore(prefix) } : {}),
  });
  const apiLimiter = rateLimit(limitOpts(num(process.env.LIMIT_API_PER_MIN, 1000), 'rl-api:'));
  const authLimiter = rateLimit({ ...limitOpts(num(process.env.LIMIT_AUTH_PER_15MIN, 60), 'rl-auth:'), windowMs: 15 * 60 * 1000 });
  const uploadLimiter = rateLimit({ ...limitOpts(num(process.env.LIMIT_UPLOAD_PER_HOUR, 120), 'rl-upl:'), windowMs: 60 * 60 * 1000 });
  // 点赞切换会全局刷新帖子缓存，单独收紧防刷（默认 30 次/分钟）
  const likeLimiter = rateLimit({ ...limitOpts(num(process.env.LIMIT_LIKE_PER_MIN, 30), 'rl-like:') });
  // 头像更换删旧图堆不起来，防的是操作费/带宽消耗：默认 10 次/小时
  const avatarLimiter = rateLimit({ ...limitOpts(num(process.env.LIMIT_AVATAR_PER_HOUR, 10), 'rl-avt:'), windowMs: 60 * 60 * 1000 });
  // 注册单独收紧：默认 10 次/小时/IP（防批量注册刷存储成本；分布式 IP 靠验证码+配额兜底）
  const registerLimiter = rateLimit({ ...limitOpts(num(process.env.LIMIT_REGISTER_PER_HOUR, 10), 'rl-reg:'), windowMs: 60 * 60 * 1000 });
  app.use('/api/', apiLimiter);
  // API 响应禁缓存：带用户数据的 JSON 绝不能进共享代理缓存
  app.use('/api/', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 轻量 access log（无 morgan 依赖；健康检查太多太吵，跳过）
  app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path === '/api/health') return next();
    const t = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t;
      if (ms > 500 || res.statusCode >= 500) console.log(`[slow] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  // 登录防爆破：账号+IP 组合计数 10 次/15 分钟。
  // 纯账号维度会被人故意输错来锁别人号；加 IP 后攻击者只能锁住“自己这个 IP 看受害者”，受害者本人（不同 IP）不受影响。
  // incr: 'get' 只读 | true 累加 | 'reset' 清零
  const loginFailMem = new Map();
  const loginFailAcctMem = new Map(); // 账号维度全局计数（防分布式 IP 轮换爆破）
  const LOGIN_FAIL_IP_MAX = 10; // 单 IP 看单账号
  const LOGIN_FAIL_ACCT_MAX = 30; // 全 IP 合计看单账号（高于 IP 维，正常用户几乎触不到）
  const clientIp = (req) => String(req.headers['x-real-ip'] || req.ip || '?').slice(0, 64);
  async function loginFail(req, username, incr) {
    const key = `fl:${clientIp(req)}:${username}`;
    const r = await redis().catch(() => null);
    if (r) {
      try {
        if (incr === true) {
          const n = await r.incr(key);
          if (n === 1) await r.expire(key, 900);
          return n;
        }
        if (incr === 'reset') await r.del(key);
        else {
          const v = await r.get(key);
          return Number(v) || 0;
        }
        return 0;
      } catch (_) {}
    }
    const now = Date.now();
    const hit = loginFailMem.get(key);
    if (incr === 'reset') {
      loginFailMem.delete(key);
      return 0;
    }
    if (incr !== true) return !hit || hit.reset < now ? 0 : hit.n;
    if (!hit || hit.reset < now) {
      loginFailMem.set(key, { n: 1, reset: now + 900000 });
      return 1;
    }
    hit.n++;
    return hit.n;
  }
  // 内存降级 Map 也要扫过期（Redis 模式靠 expire，此定时器只管两个内存 Map）
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of loginFailMem) if (v.reset < now) loginFailMem.delete(k);
    for (const [k, v] of loginFailAcctMem) if (v.reset < now) loginFailAcctMem.delete(k);
  }, 300000).unref();

  // 账号维度全局失败计数（key 不含 IP；存在用户与不存在用户都计数，避免成为新的存在性预言机）
  async function loginFailGlobal(username, incr) {
    const key = `facc:${username}`;
    const r = await redis().catch(() => null);
    if (r) {
      try {
        if (incr === true) {
          const n = await r.incr(key);
          if (n === 1) await r.expire(key, 900);
          return n;
        }
        if (incr === 'reset') await r.del(key);
        else {
          const v = await r.get(key);
          return Number(v) || 0;
        }
        return 0;
      } catch (_) {}
    }
    const now = Date.now();
    const hit = loginFailAcctMem.get(key);
    if (incr === 'reset') {
      loginFailAcctMem.delete(key);
      return 0;
    }
    if (incr !== true) return !hit || hit.reset < now ? 0 : hit.n;
    if (!hit || hit.reset < now) {
      loginFailAcctMem.set(key, { n: 1, reset: now + 900000 });
      return 1;
    }
    hit.n++;
    return hit.n;
  }

  // 登录时间侧信道缓解：用户不存在时也跑一次同成本 bcrypt.compare，把“不存在”与“密码错”的耗时对齐。
  // 启动时现算一条同 cost 的真哈希（bcryptjs 遇到非法哈希会快返，对齐失效，所以必须用合法哈希）。
  const DUMMY_HASH = await bcrypt.hash('timing-mitigation-dummy-password', 10);

  // ---------- 健康检查（不限流，靠前） ----------
  app.get('/healthz', (_req, res) => res.json({ code: 200, msg: 'ok' }));

  // ---------- 数据库连接池 ----------
  // P2-1: 按 worker 数均分连接，避免 8×30=240 顶满 MySQL(默认151)
  const workersN = Math.max(1, Math.min(os.cpus().length, Number(process.env.CLUSTER_WORKERS || 8)));
  const poolLimit = process.env.DB_POOL_LIMIT
    ? Number(process.env.DB_POOL_LIMIT)
    : Math.max(4, Math.ceil(30 / workersN));
  const pool = mysql.createPool({
    connectionLimit: poolLimit,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    queueLimit: 200,
    connectTimeout: 10000,
  });

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ code: 200, msg: 'ok', db: 'up' });
    } catch (e) {
      res.status(500).json({ code: 500, msg: 'db down' });
    }
  });

  // ---------- 静态托管（先拦截敏感路径，再放行） ----------
  const BLOCKED = [/^\/backend(\/|$)/, /^\/node_modules(\/|$)/, /^\/\.git(\/|$)/, /all_code\.txt$/, /\.env(\.|$)/];
  app.use((req, res, next) => {
    if (BLOCKED.some((re) => re.test(req.path))) return res.status(404).end();
    next();
  });
  const webRoot = path.join(__dirname, '../');
  // P1-3: /uploads 专属静态（含沙箱头）必须在 webRoot 通配之前，否则被无头版本截胡
  const uploadDir = path.join(__dirname, '../uploads');
  const resourceUploadDir = path.join(__dirname, '../uploads/resources');
  await fsp.mkdir(uploadDir, { recursive: true });
  await fsp.mkdir(resourceUploadDir, { recursive: true });
  // P1-4: uploads 防嗅探 + 沙箱（即使有人传 polyglot 也不执行）
  app.use('/uploads', express.static(uploadDir, {
    dotfiles: 'deny',
    setHeaders: (res, fp) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');
      if (/\.(html|svg)$/i.test(fp)) res.setHeader('Content-Type', 'application/octet-stream');
    },
  }));
  app.use(express.static(webRoot, { dotfiles: 'deny', index: false }));

  // ---------- 上传（内存模式：R2 直写或落盘由运行时决定） ----------
  const uploadAvatar = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowedTypes = /jpeg|jpg|png|gif|webp/;
      if (allowedTypes.test(path.extname(file.originalname).toLowerCase())) return cb(null, true);
      cb(new Error('只支持图片格式'));
    },
  });
  const uploadResource = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const reason = checkUploadExt(file.originalname, 'resources');
      if (reason) return cb(new Error(reason));
      cb(null, true);
    },
  });

  // ---------- 存储读写（标准 S3 SDK；rclone/数据胶囊链路已下线） ----------
  // buffer -> S3 或本地盘，返回可访问 URL
  async function storeFile({ prefix, originalname, buffer, mimetype, localDir, localUrlPrefix }) {
    const safeName = originalname.replace(/[^a-zA-Z0-9.\-_\u4e00-\u9fa5]/g, '_');
    if (Store.configured) {
      const key = Store.key(prefix, safeName);
      await Store.client().send(
        new PutObjectCommand({ Bucket: Store.bucket, Key: key, Body: buffer, ContentType: mimetype })
      );
      return Store.publicUrl(key) || key;
    }
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const filename = prefix === 'avatars' ? `avatar-${uniqueSuffix}${path.extname(safeName)}` : `${uniqueSuffix}_${safeName}`;
    await fsp.writeFile(path.join(localDir, filename), buffer);
    return `${localUrlPrefix}/${filename}`;
  }

  async function removeFile(fileUrl) {
    if (!fileUrl) return;
    const s3key = /^https?:\/\//i.test(fileUrl)
      ? Store.keyFromPublicUrl(fileUrl)
      : isS3Key(fileUrl)
        ? fileUrl
        : null;
    if (s3key && Store.configured) {
      try {
        await Store.client().send(new DeleteObjectCommand({ Bucket: Store.bucket, Key: s3key }));
      } catch (_) {}
      return;
    }
    if (typeof fileUrl === 'string' && fileUrl.startsWith('/uploads/')) {
      const p = safeJoinUploads(fileUrl);
      if (!p) return;
      try {
        await fsp.unlink(p);
      } catch (_) {}
    }
  }

  const isRemoteUrl = (u) => /^https?:\/\//i.test(u || '');
  // 裸 key（无 publicBase 时存的就是这个）：形如 resources/20260101/... 或 avatars/...
  const isS3Key = (u) => !!(
    Store.configured && u && !/^https?:\/\//i.test(u) && !u.includes('/uploads/') &&
    /^(resources|avatars)\//.test(u)
  );

  // 私有桶：现场签 GET 临时链接（1 小时），302 给前端/<img>。
  async function signGetUrl(key) {
    return getSignedUrl(Store.client(), new GetObjectCommand({ Bucket: Store.bucket, Key: key }), {
      expiresIn: 1800, // 下载签名 30 分钟：与头像 302 缓存(25分钟)对齐，泄露窗口减半
    });
  }

  // ---------- 鉴权（只认 JWT） ----------
  // 票据两处来：Authorization 头（老会话/非浏览器兼容）或 HttpOnly Cookie sid（新登录，防 XSS 偷票）
  const parseCookies = (req) => {
    const out = {};
    try {
      for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      }
    } catch (_) {}
    return out;
  };
  const authOptional = (req, _res, next) => {
    const h = req.headers.authorization || '';
    const raw = h.startsWith('Bearer ') ? h.slice(7) : parseCookies(req).sid;
    if (raw) {
      try {
        const payload = jwt.verify(raw, JWT_SECRET, { algorithms: ['HS256'] });
        req.username = payload.username;
        req.role = payload.role;
        req.authed = true;
        req.tokenPayload = payload;
      } catch (_) {}
    }
    next();
  };
  app.use('/api/', authOptional);
  // P1-1: 改密/重置/删号即刻失效旧票——验库（存在 + token_version 一致），一次索引查询
  const requireAuth = async (req, res, next) => {
    if (!req.authed || !req.username || !req.tokenPayload) return res.status(401).json({ code: 401, msg: '未登录' });
    try {
      const [rows] = await pool.query('SELECT token_version FROM users WHERE username = ?', [req.username]);
      if (!rows.length || (rows[0].token_version || 0) !== (req.tokenPayload.tv || 0)) {
        return res.status(401).json({ code: 401, msg: '登录已失效，请重新登录' });
      }
      next();
    } catch (_) {
      return res.status(401).json({ code: 401, msg: '未登录' });
    }
  };

  const checkAdmin = async (username) => {
    if (!username) return false;
    try {
      const [rows] = await pool.query('SELECT role FROM users WHERE username = ?', [username]);
      return rows.length > 0 && rows[0].role === 'admin';
    } catch (_) {
      return false;
    }
  };
  const requireAdmin = async (req, res, next) => {
    // 管理判定一律查库（payload 的 role 可能在降级后过期，不可信）
    if (!req.authed || !req.username) return res.status(401).json({ code: 401, msg: '未登录' });
    if (await checkAdmin(req.username)) return next();
    return res.status(403).json({ code: 403, msg: '无权操作' });
  };

  const signToken = (user) => {
    const exp = /^\d+[smhd]$/.test(process.env.JWT_EXPIRES_IN || '') ? process.env.JWT_EXPIRES_IN : '24h';
    return jwt.sign({ username: user.username, role: user.role, tv: user.token_version || 0 }, JWT_SECRET, { expiresIn: exp });
  };
  // Cookie 有效期与 JWT 对齐（解析 JWT_EXPIRES_IN，非法回落 24h）
  const cookieMaxAge = (() => {
    const m = /^(\d+)([smhd])$/.exec(process.env.JWT_EXPIRES_IN || '');
    if (!m) return 86400;
    const k = { s: 1, m: 60, h: 3600, d: 86400 };
    return Number(m[1]) * k[m[2]];
  })();
  const issueSession = (res, user) => {
    const token = signToken(user);
    // HttpOnly 防 XSS 偷票；同源站点 SameSite=Lax 即够；Secure 留给 HTTPS 时代（localhost 下置 Secure 会被部分浏览器拒收）
    const parts = [`sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${cookieMaxAge}`];
    if (process.env.COOKIE_SECURE === 'true') parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
    return token;
  };

  // P1-1: fileUrl 白名单 + 越界兜底
  const isValidFileUrl = (u) => {
    if (!u || typeof u !== 'string' || u.length > 2048) return false;
    if (/^https?:\/\//i.test(u)) {
      const base = Store.publicBase;
      return !!(base && u.startsWith(base + '/'));
    }
    if (u.startsWith('/uploads/')) return /^\/uploads\/[a-zA-Z0-9._/-]+$/.test(u) && !u.includes('..');
    if (/^(resources|avatars)\//.test(u)) return /^(resources|avatars)\/[a-zA-Z0-9._/-]+$/.test(u) && !u.includes('..');
    return false;
  };
  const safeJoinUploads = (fileUrl) => {
    const p = path.resolve(path.join(__dirname, '..', '.' + fileUrl));
    const root = path.resolve(path.join(__dirname, '..', 'uploads'));
    if (!p.startsWith(root + path.sep) && p !== root) return null;
    return p;
  };
  // P0-2/P2: 入库长度上限（防超长刷库 + XSS 载荷放大）
  const clampStr = (v, max) => String(v == null ? '' : v).slice(0, max);
  // 密码复杂度：6-72 位且至少含一个字母和一个数字（123456/abc123 这类弱密码直接拒）
  const isStrongPassword = (p) => {
    const s = String(p == null ? '' : p);
    return s.length >= 6 && s.length <= 72 && /[a-zA-Z]/.test(s) && /[0-9]/.test(s);
  };
  const WEAK_PW_MSG = '密码需6-72位，且包含字母和数字';
  // P1-4: 图片 magic 校验（扩展名可随便改，头字节改不了；非图片类型不查，靠黑名单+sandbox）
  const imageMagicOk = (buf, ext) => {
    if (!buf || buf.length < 12) return false;
    if (ext === '.png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (ext === '.jpg' || ext === '.jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (ext === '.gif') return buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a';
    if (ext === '.webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    return true;
  };
  const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  // 解压炸弹兜底：解析图片像素尺寸，超 8000px 任一边直接拒（浏览器解码会卡死）
  // PNG/GIF/WEBP 头固定偏移；JPEG 扫 SOF0/2 标记。解析失败按通过（不误杀，magic 已验过真伪）
  const MAX_PX = 8000;
  const imageSizeOk = (buf, ext) => {
    try {
      if (ext === '.png') {
        const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
        return w <= MAX_PX && h <= MAX_PX;
      }
      if (ext === '.gif') {
        const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
        return w <= MAX_PX && h <= MAX_PX;
      }
      if (ext === '.webp' && buf.length > 30) {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8 ') {
          const w = buf.readUInt16LE(26) & 0x3fff, h = buf.readUInt16LE(28) & 0x3fff;
          return w <= MAX_PX && h <= MAX_PX;
        }
        if (fourcc === 'VP8L' && buf[20] === 0x2f) {
          // 无损：宽高-1 各 14bit 打包在 offset 21 起的 4 字节里
          const v = buf.readUInt32LE(21);
          const w = (v & 0x3fff) + 1, h = ((v >> 14) & 0x3fff) + 1;
          return w <= MAX_PX && h <= MAX_PX;
        }
        if (fourcc === 'VP8X' && buf.length > 30) {
          // 扩展：canvas 宽/高-1 各 3 字节小端，offset 24/27 起
          const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
          const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
          return w <= MAX_PX && h <= MAX_PX;
        }
        return true; // 未知 fourcc，按通过（magic 已验过真伪）
      }
      if (ext === '.jpg' || ext === '.jpeg') {
        let i = 2;
        while (i + 8 < buf.length) {
          if (buf[i] !== 0xff) break;
          const marker = buf[i + 1];
          const len = buf.readUInt16BE(i + 2);
          if (marker >= 0xc0 && marker <= 0xc3) {
            const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
            return w <= MAX_PX && h <= MAX_PX;
          }
          if (marker === 0xd9 || marker === 0xda) break;
          i += 2 + len;
        }
        return true;
      }
      return true;
    } catch (_) {
      return true;
    }
  };
  // 扩展名管制（multipart / presign / policy 三口统一，防直传绕过 multer 黑名单）
  const BLOCKED_EXT = new Set(['.html', '.htm', '.svg', '.xml', '.js', '.mjs', '.php', '.phtml', '.sh', '.exe', '.bat', '.cmd', '.msi', '.dll']);
  const AVATAR_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  // 返回 null = 放行；返回字符串 = 拒绝原因
  const checkUploadExt = (filename, prefix) => {
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (!ext) return '文件缺少扩展名';
    if (BLOCKED_EXT.has(ext)) return '该文件格式不允许上传（可执行/网页脚本类）';
    if (prefix === 'avatars' && !AVATAR_EXT.has(ext)) return '头像只支持 png/jpg/gif/webp';
    return null;
  };
  // fileUrl(完整公网URL/裸key) → 裸 key；解不出返回 null（供登记 HeadObject / 配额用）
  const s3KeyOf = (fileUrl) => {
    if (!fileUrl || typeof fileUrl !== 'string') return null;
    if (/^https?:\/\//i.test(fileUrl)) return Store.keyFromPublicUrl(fileUrl);
    if (/^(resources|avatars)\//.test(fileUrl) && !fileUrl.includes('..')) return fileUrl;
    return null;
  };
  // 登记时实测对象大小（防 fileSize 谎报：HeadObject 为准）。
  // 存储已配置但 HeadObject 失败 → 返回 null（调用方直接拒绝登记，不信任客户端上报）；
  // 未配存储（本地模式，无直传）→ 沿用上报值兼容。
  async function probeObjectSize(key, fallbackSize) {
    if (!Store.configured || !HeadObjectCommand) return Number(fallbackSize) || 0;
    if (!key) return null;
    try {
      const r = await Store.client().send(new HeadObjectCommand({ Bucket: Store.bucket, Key: key }));
      const n = Number(r.ContentLength);
      if (!Number.isFinite(n) || n < 0) return null;
      return n;
    } catch (_) {
      return null;
    }
  }
  const MAX_DIRECT_BYTES = 50 * 1024 * 1024; // 直传/中转统一上限 50MB
  // 存储配额：累计制（删文件即释放），默认每人 512MB；头像只受频率限制（换头像自动删旧图，堆不起来）
  const QUOTA_BYTES = Math.max(0, Number(process.env.QUOTA_BYTES ?? 512 * 1024 * 1024) || 0);
  async function userUsage(username) {
    try {
      const [[r]] = await pool.query('SELECT COALESCE(SUM(file_size),0) AS s FROM resources WHERE uploader = ?', [username]);
      return Number(r.s) || 0;
    } catch (_) {
      return 0;
    }
  }
  async function quotaCheck(username, addBytes) {
    if (!QUOTA_BYTES) return null; // 0 = 不限
    const used = await userUsage(username);
    if (used + (Number(addBytes) || 0) > QUOTA_BYTES) {
      return { used, quota: QUOTA_BYTES };
    }
    return null;
  }

  // ---------- Redis 列表缓存（读穿 + 按表版本失效） ----------
  // key = q:{表}:{版本}:{sql+参数+分页哈希}；写操作 INCR 版本号（O(1)，比 SCAN 清 key 稳）。
  // Redis 挂了/没配 → 自动直查 DB，绝不 500。TTL 默认 45s（CACHE_TTL_SEC）。
  const CACHE_TTL = Math.max(5, Number(process.env.CACHE_TTL_SEC || 45));
  let redisClient = null;
  let redisDown = false;
  async function redis() {
    if (redisClient) return redisClient;
    if (redisDown || !process.env.REDIS_URL) return null;
    try {
      const { createClient } = require('redis');
      redisClient = createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', () => {});
      await redisClient.connect();
      return redisClient;
    } catch (_) {
      redisDown = true;
      return null;
    }
  }
  async function cachedList(table, req, sql, params) {
    const { page, limit, offset } = paging(req);
    const h = crypto
      .createHash('sha256')
      .update(sql + JSON.stringify(params) + page + '/' + limit)
      .digest('hex')
      .slice(0, 16);
    const r = await redis();
    if (r) {
      try {
        const gen = (await r.get(`gen:${table}`)) || '0';
        const hit = await r.get(`q:${table}:${gen}:${h}`);
        if (hit) return { rows: JSON.parse(hit), pagination: { page, limit } };
      } catch (_) {}
    }
    const [rows] = await pool.query(`${sql} LIMIT ${limit} OFFSET ${offset}`, params);
    if (r) {
      try {
        const gen = (await r.get(`gen:${table}`)) || '0';
        await r.setEx(`q:${table}:${gen}:${h}`, CACHE_TTL, JSON.stringify(rows));
      } catch (_) {}
    }
    return { rows, pagination: { page, limit } };
  }
  async function bustCache(table) {
    try {
      const r = await redis();
      if (r) await r.incr(`gen:${table}`);
    } catch (_) {}
  }

  // 分页：data 仍是数组，分页信息放 pagination，老前端无感
  const paging = (req) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    return { page, limit, offset: (page - 1) * limit };
  };

  // ==========================================
  // 5. 用户模块 (认证与资料管理)
  // ==========================================
  app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ code: 400, msg: '用户名或密码错误' });
    if (String(username).length > 64 || String(password).length > 72 || String(password).length < 3) {
      return res.status(400).json({ code: 400, msg: '用户名或密码错误' });
    }
    if ((await loginFail(req, String(username), 'get')) >= LOGIN_FAIL_IP_MAX) {
      return res.status(429).json({ code: 429, msg: '尝试过多，请 15 分钟后再试' });
    }
    if ((await loginFailGlobal(String(username), 'get')) >= LOGIN_FAIL_ACCT_MAX) {
      return res.status(429).json({ code: 429, msg: '尝试过多，请 15 分钟后再试' });
    }
    try {
      const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
      if (rows.length === 0) {
        // 时间对齐：不存在也跑一次同成本比较，再统一 401（防用户名枚举侧信道）
        await bcrypt.compare(String(password), DUMMY_HASH);
        await loginFail(req, String(username), true);
        await loginFailGlobal(String(username), true);
        return res.status(401).json({ code: 401, msg: '用户名或密码错误' });
      }
      const user = rows[0];
      if (!(await bcrypt.compare(String(password), user.password))) {
        await loginFail(req, String(username), true);
        await loginFailGlobal(String(username), true);
        return res.status(401).json({ code: 401, msg: '用户名或密码错误' });
      }
      await loginFail(req, String(username), 'reset');
      await loginFailGlobal(String(username), 'reset');
      const token = issueSession(res, user);
      res.json({ code: 200, msg: '登录成功', role: user.role, username: user.username, token });
    } catch (_) {
      res.status(500).json({ code: 500, msg: '服务器错误' });
    }
  });

  // 登出：清 HttpOnly Cookie + 版本号+1（该用户所有端 token 即刻失效，防旧票残留）
  app.post('/api/logout', requireAuth, async (req, res) => {
    try {
      await pool.query('UPDATE users SET token_version = token_version + 1 WHERE username = ?', [req.username]);
    } catch (_) {}
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ code: 200, msg: '已退出' });
  });

  // 验证码文本暂存：优先 Redis（多 worker 共享），Redis 不可用时降级本进程内存（跨进程需点刷新）
  const memCap = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of memCap) if (v.exp < now) memCap.delete(k);
  }, 60000).unref();

  // 注册验证码：SVG 自建，无外部依赖；文本 5 分钟过期，一次性使用
  app.get('/api/captcha', apiLimiter, async (_req, res) => {
    try {
      const svgCaptcha = require('svg-captcha');
      const c = svgCaptcha.create({ size: 5, noise: 3, width: 150, height: 44, color: true, ignoreChars: '0o1ilI' });
      const id = crypto.randomUUID();
      const r = await redis();
      if (r) await r.setEx(`cap:${id}`, 300, c.text);
      else memCap.set(`cap:${id}`, { text: c.text, exp: Date.now() + 300000 });
      res.json({ code: 200, data: { id, svg: c.data } });
    } catch (_) {
      res.status(500).json({ code: 500, msg: '验证码生成失败' });
    }
  });

  app.post('/api/register', registerLimiter, async (req, res) => {
    const { username, password, captchaId, captchaText } = req.body || {};
    if (!username || !password) return res.status(400).json({ code: 400, msg: '用户名和密码不能为空' });
    // 验证码：必填，一次性，忽略大小写（防脚本批量注册）
    if (!captchaId || !captchaText) return res.status(400).json({ code: 400, msg: '请填写验证码' });
    try {
      const r = await redis();
      const key = `cap:${String(captchaId).slice(0, 64)}`;
      let want = null;
      if (r) {
        want = await r.get(key);
        await r.del(key).catch(() => {});
      } else {
        const hit = memCap.get(key);
        want = hit && hit.exp > Date.now() ? hit.text : null;
        memCap.delete(key);
      }
      if (!want || String(captchaText).trim().toLowerCase() !== String(want).toLowerCase()) {
        return res.status(400).json({ code: 400, msg: '验证码错误，请重试' });
      }
    } catch (_) {
      return res.status(400).json({ code: 400, msg: '验证码错误，请重试' });
    }
    const u = String(username).trim(), p = String(password);
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/.test(u)) {
      return res.status(400).json({ code: 400, msg: '用户名需3-20位字母/数字/下划线/中文' });
    }
    if (!isStrongPassword(p)) return res.status(400).json({ code: 400, msg: WEAK_PW_MSG });
    try {
      const hashedPassword = await bcrypt.hash(p, 10);
      await pool.query('INSERT INTO users (username, password, role) VALUES (?, ?, "user")', [u, hashedPassword]);
      res.json({ code: 200, msg: '注册成功' });
    } catch (_) {
      res.json({ code: 400, msg: '注册失败，请稍后重试' });
    }
  });

  // 内容安全：敏感词过滤（默认内置 + SENSITIVE_WORDS 环境变量追加，逗号分隔）
  const SENSITIVE_DEFAULT = ['法轮功', '赌博', '博彩', '六合彩', 'av女优', '裸聊', '刷单', '兼职打字员', '代开发票', '办证'];
  const SENSITIVE_WORDS = [...SENSITIVE_DEFAULT, ...(process.env.SENSITIVE_WORDS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  const containsSensitive = (...texts) => {
    const joined = texts.map((t) => String(t || '').toLowerCase()).join('\n');
    return SENSITIVE_WORDS.some((w) => w && joined.includes(String(w).toLowerCase()));
  };
  const rejectSensitive = (res) => res.status(400).json({ code: 400, msg: '内容包含违规信息，请修改后重试' });

  // P1-3: 给前端管理守卫用的自检接口
  app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT username, role FROM users WHERE username = ?', [req.username]);
      if (!rows.length) return res.status(401).json({ code: 401, msg: '未登录' });
      res.json({ code: 200, data: rows[0] });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  // 我的用量：给上传页展示（已用/总额），删文件即释放
  app.get('/api/user/quota', requireAuth, async (req, res) => {
    const used = await userUsage(req.username);
    res.json({ code: 200, data: { used, quota: QUOTA_BYTES } });
  });

  app.get('/api/user/profile', async (req, res) => {
    const { username } = req.query;
    if (!username || String(username).length > 64) return res.status(400).json({ code: 400, msg: '参数错误' });
    try {
      const [rows] = await pool.query('SELECT username, email, signature, avatar FROM users WHERE username = ?', [username]);
      // 用户名本身公开（帖子/评论处处可见），不存在也回同形空数据，不做 200/404 区分
      if (rows.length === 0) return res.json({ code: 200, data: null });
      const u = rows[0];
      // email 仅本人或管理员可见；公开只回用户名/签名/头像
      const self = req.username && req.username === u.username;
      const admin = req.username && (await checkAdmin(req.username));
      if (self || admin) return res.json({ code: 200, data: u });
      const { email, ...pub } = u;
      res.json({ code: 200, data: pub });
    } catch (_) {
      res.status(404).json({ code: 404, msg: '用户不存在' });
    }
  });

  // 普通用户改密：验旧密码，新密码走复杂度校验；成功后前端清 token 重登
  app.put('/api/user/password', requireAuth, authLimiter, async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ code: 400, msg: '旧密码和新密码不能为空' });
    const np = String(newPassword);
    if (!isStrongPassword(np)) return res.status(400).json({ code: 400, msg: WEAK_PW_MSG });
    if (String(oldPassword) === np) return res.status(400).json({ code: 400, msg: '新密码不能与旧密码相同' });
    try {
      const [rows] = await pool.query('SELECT password FROM users WHERE username = ?', [req.username]);
      if (!rows.length) return res.status(401).json({ code: 401, msg: '未登录' });
      if (!(await bcrypt.compare(String(oldPassword), rows[0].password))) {
        return res.status(400).json({ code: 400, msg: '旧密码错误' });
      }
      await pool.query('UPDATE users SET password = ?, token_version = token_version + 1 WHERE username = ?', [await bcrypt.hash(np, 10), req.username]);
      res.json({ code: 200, msg: '修改成功，请重新登录' });
    } catch (_) {
      res.status(500).json({ code: 500, msg: '修改失败' });
    }
  });

  // 用户名创建后不可改（posts/resources/comments 均以 username 关联，改名会产生孤儿数据）
  app.put('/api/user/profile', requireAuth, async (req, res) => {
    const { oldUsername, email, signature } = req.body || {};
    const target = String(oldUsername || req.username);
    // 非本人且非管理员禁止改他人资料
    if (target !== req.username && !(await checkAdmin(req.username))) {
      return res.status(403).json({ code: 403, msg: '无权操作' });
    }
    const em = clampStr(email, 128), sg = clampStr(signature, 255);
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ code: 400, msg: '邮箱格式不正确' });
    if (containsSensitive(sg)) return rejectSensitive(res);
    try {
      await pool.query('UPDATE users SET email = ?, signature = ? WHERE username = ?', [em, sg, target]);
      res.json({ code: 200, msg: '更新成功' });
    } catch (_) {
      res.status(500).json({ code: 500, msg: '更新失败' });
    }
  });

  app.post('/api/user/avatar', requireAuth, avatarLimiter, uploadAvatar.single('avatar'), async (req, res) => {
    const username = req.username;
    if (!username || !req.file) return res.status(400).json({ code: 400, msg: '参数错误' });
    const aExt = path.extname(req.file.originalname).toLowerCase();
    if (!imageMagicOk(req.file.buffer, aExt)) return res.status(400).json({ code: 400, msg: '文件头与图片格式不符' });
    if (!imageSizeOk(req.file.buffer, aExt)) return res.status(400).json({ code: 400, msg: '图片尺寸过大' });
    try {
      const [rows] = await pool.query('SELECT avatar FROM users WHERE username = ?', [username]);
      if (rows.length === 0) return res.status(500).json({ code: 500 });
      const newAvatarUrl = await storeFile({
        prefix: 'avatars',
        originalname: req.file.originalname,
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        localDir: uploadDir,
        localUrlPrefix: '/uploads',
      });
      await pool.query('UPDATE users SET avatar = ? WHERE username = ?', [newAvatarUrl, username]);
      await removeFile(rows[0].avatar);
      res.json({ code: 200, msg: '上传成功', data: { avatar: newAvatarUrl } });
    } catch (e) {
      res.status(400).json({ code: 400, msg: e.message || '上传失败' });
    }
  });

  // 头像直链（给 <img> 用，跟随 302 即可显示）：
  // 公网 URL 直接跳；私有桶裸 key 现场签临时链接；本地 /uploads 路径直接跳本地地址。
  // 缓存：文件名含时间戳+随机数永不复用，稳定内容 immutable；只有临时签名 302 用短缓存。
  const IMMUTABLE_AVATAR = 'public, max-age=31536000, immutable';
  app.get('/api/user/avatar', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).end();
    try {
      const [rows] = await pool.query('SELECT avatar FROM users WHERE username = ?', [username]);
      const av = rows.length ? rows[0].avatar : null;
      if (!av || !isValidFileUrl(av)) return res.status(404).end();
      if (isRemoteUrl(av)) {
        res.set('Cache-Control', IMMUTABLE_AVATAR);
        return res.redirect(302, av);
      }
      if (isS3Key(av)) {
        try {
          res.set('Cache-Control', 'private, max-age=1500'); // 签名 30 分钟过期，缓存 25 分钟留余量
          return res.redirect(302, await signGetUrl(av));
        } catch (_) {
          return res.status(404).end();
        }
      }
      res.set('Cache-Control', IMMUTABLE_AVATAR);
      return res.redirect(302, av); // /uploads/... 本地路径
    } catch (_) {
      res.status(404).end();
    }
  });

  app.get('/api/users', requireAdmin, async (req, res) => {
    try {
      const { page, limit, offset } = paging(req);
      const [rows] = await pool.query('SELECT id, username, role FROM users ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
      res.json({ code: 200, data: rows, pagination: { page, limit } });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.delete('/api/users/:username', requireAdmin, async (req, res) => {
    const { username } = req.params;
    if (username === 'admin') return res.status(403).json({ code: 403, msg: '禁删管理员' });
    // 先取头像，删行后清存储/磁盘，防孤儿文件
    let uRows;
    try {
      [uRows] = await pool.query('SELECT avatar FROM users WHERE username = ?', [username]);
    } catch (_) {
      return res.status(500).json({ code: 500 });
    }
    if (!uRows.length) return res.status(404).json({ code: 404, msg: '用户不存在' });
    const conn = await pool.getConnection();
    try {
      // DB 多删包事务：中途失败整体回滚，不留半删；文件删除在提交后做（不可回滚放最后）
      await conn.beginTransaction();
      const [resRows] = await conn.query('SELECT id, file_url FROM resources WHERE uploader = ?', [username]);
      for (const r of resRows) await conn.query('DELETE FROM resources WHERE id = ?', [r.id]);
      await conn.query('DELETE FROM posts WHERE username = ?', [username]);
      await conn.query('DELETE FROM comments WHERE username = ?', [username]);
      await conn.query('DELETE FROM users WHERE username = ?', [username]);
      await conn.commit();
      for (const r of resRows) await removeFile(r.file_url);
      await removeFile(uRows[0].avatar);
      await bustCache('resources');
      await bustCache('posts');
      await bustCache('postc');
      await bustCache('comments');
      console.log(`[audit] ${req.username} deleted user ${username} (cascade)`);
      res.json({ code: 200, msg: '用户已注销，其内容一并清理' });
    } catch (_) {
      try { await conn.rollback(); } catch (_) {}
      res.status(500).json({ code: 500 });
    } finally {
      conn.release();
    }
  });

  // 管理员协助重置密码：用户登录态忘密时由管理员核实身份后重置（不验旧密码）。
  // admin 账号禁走此口（仍走进库流程），操作记审计日志（只记用户名）。
  app.put('/api/admin/users/:username/password', requireAdmin, async (req, res) => {
    const { username } = req.params;
    const { newPassword } = req.body || {};
    if (!username || username === 'admin') return res.status(403).json({ code: 403, msg: '该账号不允许经此重置' });
    if (!newPassword || !isStrongPassword(newPassword)) {
      return res.status(400).json({ code: 400, msg: WEAK_PW_MSG });
    }
    try {
      const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
      if (!rows.length) return res.status(404).json({ code: 404, msg: '用户不存在' });
      await pool.query('UPDATE users SET password = ?, token_version = token_version + 1 WHERE username = ?', [await bcrypt.hash(String(newPassword), 10), username]);
      console.log(`[audit] admin ${req.username} reset password for ${username}`);
      res.json({ code: 200, msg: '重置成功，请告知用户登录后立即改密' });
    } catch (_) {
      res.status(500).json({ code: 500, msg: '重置失败' });
    }
  });

  // ==========================================
  // 6. 资源模块 (上传、下载、删除)
  // ==========================================
  app.get('/api/resources', async (req, res) => {
    const keyword = clampStr(req.query.keyword || '', 50).trim();
    try {
      if (!keyword) {
        const { rows, pagination } = await cachedList('resources', req, 'SELECT * FROM resources ORDER BY id DESC', []);
        return res.json({ code: 200, data: rows, pagination });
      }
      // 先走 FULLTEXT（英文/长词快），中文、短词、停用词无命中时回落 LIKE。
      // 同用 'resources' 缓存表（gen 共享，sql 不同哈希隔离），写后失效一致。
      let hit = await cachedList(
        'resources', req,
        'SELECT * FROM resources WHERE MATCH(title, description) AGAINST(? IN NATURAL LANGUAGE MODE)',
        [keyword]
      );
      if (!hit.rows.length) {
        hit = await cachedList(
          'resources', req,
          'SELECT * FROM resources WHERE title LIKE ? ORDER BY id DESC',
          [`%${keyword}%`]
        );
      }
      res.json({ code: 200, data: hit.rows, pagination: hit.pagination });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.post('/api/resources/upload', requireAuth, uploadLimiter, (req, res) => {
    uploadResource.single('file')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ code: 400, msg: '文件大小不能超过50MB' });
        return res.status(400).json({ code: 400, msg: err.message || '上传失败' });
      }
      const { title, category, description } = req.body || {};
      const uploader = req.username;
      if (!req.file) return res.status(400).json({ code: 400, msg: '请上传文件' });
      if (!title || String(title).length > 200) return res.status(400).json({ code: 400, msg: '资源标题不能为空且不超200字' });
      if (containsSensitive(title, description)) return rejectSensitive(res);
      const rExt = path.extname(req.file.originalname).toLowerCase();
      if (IMG_EXT.has(rExt) && !imageMagicOk(req.file.buffer, rExt)) {
        return res.status(400).json({ code: 400, msg: '文件头与图片格式不符' });
      }
      if (IMG_EXT.has(rExt) && !imageSizeOk(req.file.buffer, rExt)) {
        return res.status(400).json({ code: 400, msg: '图片尺寸过大' });
      }
      const over = await quotaCheck(uploader, req.file.size);
      if (over) return res.status(403).json({ code: 403, msg: '存储配额已满，请删除旧资源后重试' });
      try {
        const fileUrl = await storeFile({
          prefix: 'resources',
          originalname: req.file.originalname,
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          localDir: resourceUploadDir,
          localUrlPrefix: '/uploads/resources',
        });
        const uploadTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const sql =
          'INSERT INTO resources (title, category, file_url, file_size, file_type, description, uploader, upload_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
        const [result] = await pool.query(sql, [
          clampStr(title, 200), clampStr(category, 64), fileUrl, req.file.size, clampStr(req.file.mimetype, 128), clampStr(description, 5000), uploader, uploadTime,
        ]);
        await bustCache('resources');
        res.json({ code: 200, msg: '发布成功', id: result.insertId });
      } catch (e) {
        res.status(500).json({ code: 500, msg: e.message || '保存失败' });
      }
    });
  });

  // 大文件直传（PUT 预签名）：仅标准 S3/R2 可用
  app.post('/api/upload/presign', requireAuth, uploadLimiter, async (req, res) => {
    if (!Store.configured) return res.status(501).json({ code: 501, msg: '对象存储未配置，请用普通上传' });
    const { filename, mimetype, prefix } = req.body || {};
    if (!filename) return res.status(400).json({ code: 400, msg: '缺少 filename' });
    const extReason = checkUploadExt(filename, prefix === 'avatars' ? 'avatars' : 'resources');
    if (extReason) return res.status(400).json({ code: 400, msg: extReason });
    // 直传签名前只知道“要传”，不知道多大：已用满配额直接拦，具体大小在登记时再卡
    if (await quotaCheck(req.username, 0)) {
      return res.status(403).json({ code: 403, msg: '存储配额已满，请删除旧资源后重试' });
    }
    try {
      const safeName = String(filename).replace(/[^a-zA-Z0-9.\-_\u4e00-\u9fa5]/g, '_');
      const key = Store.key(prefix === 'avatars' ? 'avatars' : 'resources', `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`);
      const url = await getSignedUrl(
        Store.client(),
        new PutObjectCommand({ Bucket: Store.bucket, Key: key, ContentType: mimetype || 'application/octet-stream' }),
        { expiresIn: 300 } // 上传签名 5 分钟：前端拿到即传，泄露窗口最小化
      );
      res.json({ code: 200, data: { uploadUrl: url, key, publicUrl: Store.publicUrl(key) } });
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message || '签名失败' });
    }
  });

  // 预签名 POST（policy）：签名只覆盖策略文档（key 前缀/大小/类型），不含 Host，
  // 因此可经 Nginx /s3up/ 代理转发。前端把返回的 fields + file 一起 POST 到同源 /s3up/<key>。
  app.post('/api/upload/policy', requireAuth, uploadLimiter, async (req, res) => {
    if (!Store.configured) return res.status(501).json({ code: 501, msg: '对象存储未配置，请用普通上传' });
    if (!createPresignedPost)
      return res.status(501).json({ code: 501, msg: '服务端未安装 s3-presigned-post，请用普通上传' });
    const { filename, mimetype, prefix } = req.body || {};
    if (!filename) return res.status(400).json({ code: 400, msg: '缺少 filename' });
    const extReason2 = checkUploadExt(filename, prefix === 'avatars' ? 'avatars' : 'resources');
    if (extReason2) return res.status(400).json({ code: 400, msg: extReason2 });
    if (await quotaCheck(req.username, 0)) {
      return res.status(403).json({ code: 403, msg: '存储配额已满，请删除旧资源后重试' });
    }
    try {
      const safeName = String(filename).replace(/[^a-zA-Z0-9.\-_\u4e00-\u9fa5]/g, '_');
      const key = Store.key(prefix === 'avatars' ? 'avatars' : 'resources', safeName);
      const { url, fields } = await createPresignedPost(Store.client(), {
        Bucket: Store.bucket,
        Key: key,
        Conditions: [
          ['content-length-range', 1, 50 * 1024 * 1024],
          ['starts-with', '$Content-Type', ''],
        ],
        Fields: { 'Content-Type': mimetype || 'application/octet-stream' },
        Expires: 300, // 上传签名 5 分钟
      });
      res.json({
        code: 200,
        data: {
          key,
          fields, // 含 policy/signature，按原样随 file 一起 POST
          proxyPath: `/s3up/${key}`, // 同源代理地址（Nginx 转 S3）
          directUrl: url, // 直连 S3 地址
          publicUrl: Store.publicUrl(key),
        },
      });
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message || '签名失败' });
    }
  });

  // 直传后登记资源元数据（文件已在 R2，前端把 publicUrl 传回来）
  app.post('/api/resources/register', requireAuth, uploadLimiter, async (req, res) => {
    const { title, category, description, fileUrl, fileSize, fileType } = req.body || {};
    const uploader = req.username;
    if (!title || String(title).length > 200) return res.status(400).json({ code: 400, msg: '资源标题不能为空且不超200字' });
    if (containsSensitive(title, description)) return rejectSensitive(res);
    if (!fileUrl || !isValidFileUrl(fileUrl)) return res.status(400).json({ code: 400, msg: 'fileUrl 非法' });
    // 直传文件已在存储里：HeadObject 实测大小（防谎报），再卡配额；裸 key/公网 URL 都能解。
    // HeadObject 失败（对象不存在/未完成上传）→ 直接拒绝，不信任客户端上报的 fileSize。
    const realKey = s3KeyOf(fileUrl);
    const realSize = await probeObjectSize(realKey, fileSize);
    if (realSize == null) return res.status(400).json({ code: 400, msg: '对象不存在或尚未完成上传，请先上传文件' });
    if (realSize <= 0 || realSize > MAX_DIRECT_BYTES) {
      return res.status(400).json({ code: 400, msg: '文件大小异常（须 1B~50MB）' });
    }
    const over = await quotaCheck(uploader, realSize);
    if (over) return res.status(403).json({ code: 403, msg: '存储配额已满，请删除旧资源后重试' });
    try {
      const uploadTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const [result] = await pool.query(
        'INSERT INTO resources (title, category, file_url, file_size, file_type, description, uploader, upload_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [clampStr(title, 200), clampStr(category, 64), fileUrl, realSize, clampStr(fileType, 128), clampStr(description, 5000), uploader, uploadTime]
      );
      await bustCache('resources');
      res.json({ code: 200, msg: '发布成功', id: result.insertId });
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message || '保存失败' });
    }
  });

  // 资源下载：公网 URL 直接 302（零 Node 流量）；裸 key 走临时签名；本地文件走 res.download
  app.get('/api/resources/download/:id', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT file_url, title, file_type FROM resources WHERE id = ?', [req.params.id]);
      if (rows.length === 0 || !rows[0].file_url) return res.status(404).json({ msg: '文件不存在' });
      const fileUrl = rows[0].file_url;
      if (!isValidFileUrl(fileUrl)) return res.status(404).json({ msg: '文件不存在' });
      if (isRemoteUrl(fileUrl)) return res.redirect(302, fileUrl);
      if (isS3Key(fileUrl)) {
        try {
          return res.redirect(302, await signGetUrl(fileUrl));
        } catch (_) {
          return res.status(404).json({ msg: '文件不存在' });
        }
      }
      const filePath = safeJoinUploads(fileUrl);
      if (!filePath) return res.status(403).json({ msg: '非法路径' });
      const downloadFileName = `${rows[0].title}${path.extname(fileUrl)}`;
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`);
      res.download(filePath, downloadFileName);
    } catch (_) {
      res.status(404).json({ msg: '文件不存在' });
    }
  });

  app.delete('/api/resources/:id', requireAuth, async (req, res) => {
    const operator = req.username;
    const isAdmin = await checkAdmin(operator);
    try {
      const [rows] = await pool.query('SELECT file_url, uploader FROM resources WHERE id = ?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ msg: '未找到' });
      if (isAdmin || rows[0].uploader === operator) {
        await removeFile(rows[0].file_url);
        await pool.query('DELETE FROM resources WHERE id = ?', [req.params.id]);
        await bustCache('resources');
        console.log(`[audit] ${operator} deleted resource ${req.params.id}`);
        res.json({ code: 200, msg: '删除成功' });
      } else {
        res.status(403).json({ code: 403, msg: '权限不足' });
      }
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  // ==========================================
  // 7. 社区功能 (吐槽与论坛)
  // ==========================================
  app.get('/api/comments', async (req, res) => {
    try {
      const { rows, pagination } = await cachedList(
        'comments',
        req,
        'SELECT c.*, u.avatar FROM comments c LEFT JOIN users u ON c.username = u.username ORDER BY c.create_time DESC',
        []
      );
      res.json({ code: 200, data: rows, pagination });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.post('/api/comments', requireAuth, async (req, res) => {
    const { content } = req.body || {};
    const username = req.username;
    if (!content || String(content).length > 2000) return res.status(400).json({ code: 400, msg: '评论内容不能为空且不超2000字' });
    if (containsSensitive(content)) return rejectSensitive(res);
    try {
      await pool.query('INSERT INTO comments (username, content) VALUES (?, ?)', [username, clampStr(content, 2000)]);
      await bustCache('comments');
      res.json({ code: 200, msg: '发布成功' });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.delete('/api/comments/:id', requireAdmin, async (req, res) => {
    try {
      await pool.query('DELETE FROM comments WHERE id = ?', [req.params.id]);
      await bustCache('comments');
      console.log(`[audit] ${req.username} deleted comment ${req.params.id}`);
      res.json({ code: 200, msg: '已删除' });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  // 帖子列表排序：sort=new（默认，时间倒序）| hot（点赞倒序，赞同再按 id 倒序）
  // 附带 liked：当前登录用户是否赞过（匿名 uniform 传 ''，恒为 0；用户名进 params 参与缓存哈希，用户间不串）
  const postsListSQL = (sort) => sort === 'hot'
    ? 'SELECT p.*, u.avatar, COALESCE(l.c, 0) AS likes, (pl.username IS NOT NULL) AS liked FROM posts p LEFT JOIN users u ON p.username = u.username LEFT JOIN (SELECT post_id, COUNT(*) AS c FROM post_likes GROUP BY post_id) l ON l.post_id = p.id LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.username = ? ORDER BY likes DESC, p.id DESC'
    : 'SELECT p.*, u.avatar, COALESCE(l.c, 0) AS likes, (pl.username IS NOT NULL) AS liked FROM posts p LEFT JOIN users u ON p.username = u.username LEFT JOIN (SELECT post_id, COUNT(*) AS c FROM post_likes GROUP BY post_id) l ON l.post_id = p.id LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.username = ? ORDER BY p.create_time DESC';

  app.get('/api/posts', async (req, res) => {
    const sort = req.query.sort === 'hot' ? 'hot' : 'new';
    try {
      const { rows, pagination } = await cachedList('posts', req, postsListSQL(sort), [req.username || '']);
      res.json({ code: 200, data: rows, pagination });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.get('/api/posts/user', async (req, res) => {
    const { username } = req.query;
    const sort = req.query.sort === 'hot' ? 'hot' : 'new';
    if (!username || String(username).length > 64) return res.status(400).json({ code: 400, msg: '参数错误' });
    try {
      const order = sort === 'hot' ? 'likes DESC, p.id DESC' : 'p.create_time DESC';
      const { rows, pagination } = await cachedList(
        'posts',
        req,
        `SELECT p.*, COALESCE(l.c, 0) AS likes, (pl.username IS NOT NULL) AS liked FROM posts p LEFT JOIN (SELECT post_id, COUNT(*) AS c FROM post_likes GROUP BY post_id) l ON l.post_id = p.id LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.username = ? WHERE p.username = ? ORDER BY ${order}`,
        [req.username || '', username]
      );
      const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM posts WHERE username = ?', [username]);
      res.json({ code: 200, data: rows, pagination: { ...pagination, total: Number(total) || 0 } });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.post('/api/posts', requireAuth, async (req, res) => {
    const { title, content } = req.body || {};
    const username = req.username;
    if (!title || !content || String(title).length > 200 || String(content).length > 10000) {
      return res.status(400).json({ code: 400, msg: '标题和内容不能为空且不超限' });
    }
    if (containsSensitive(title, content)) return rejectSensitive(res);
    try {
      await pool.query('INSERT INTO posts (title, content, username) VALUES (?, ?, ?)', [clampStr(title, 200), clampStr(content, 10000), username]);
      await bustCache('posts');
      res.json({ code: 200 });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.delete('/api/posts/:id', requireAuth, async (req, res) => {
    const operator = req.username;
    const isAdmin = await checkAdmin(operator);
    try {
      const [rows] = await pool.query('SELECT username FROM posts WHERE id = ?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ msg: '不存在' });
      if (isAdmin || rows[0].username === operator) {
        await pool.query('DELETE FROM posts WHERE id = ?', [req.params.id]);
        await bustCache('posts');
        await bustCache('postc');
        console.log(`[audit] ${operator} deleted post ${req.params.id}`);
        res.json({ code: 200, msg: '删除成功' });
      } else {
        res.status(403).json({ code: 403, msg: '权限不足' });
      }
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.get('/api/posts/:id', async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT p.*, u.avatar, COALESCE(l.c, 0) AS likes FROM posts p
         LEFT JOIN users u ON p.username = u.username
         LEFT JOIN (SELECT post_id, COUNT(*) AS c FROM post_likes GROUP BY post_id) l ON l.post_id = p.id
         WHERE p.id = ?`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ msg: '未找到' });
      const post = rows[0];
      post.likes = Number(post.likes) || 0;
      if (req.authed && req.username) {
        const [liked] = await pool.query('SELECT 1 FROM post_likes WHERE post_id = ? AND username = ?', [req.params.id, req.username]);
        post.liked = liked.length > 0;
      }
      res.json({ code: 200, data: post });
    } catch (_) {
      res.status(404).json({ msg: '未找到' });
    }
  });

  // 点赞切换：INSERT 冲突即视为已赞转取消（原子收敛，并发双击不 500，结果与串行两次一致）
  app.post('/api/posts/:id/like', requireAuth, likeLimiter, async (req, res) => {
    try {
      const [exists] = await pool.query('SELECT id FROM posts WHERE id = ?', [req.params.id]);
      if (!exists.length) return res.status(404).json({ code: 404, msg: '帖子不存在' });
      let liked;
      try {
        await pool.query('INSERT INTO post_likes (post_id, username) VALUES (?, ?)', [req.params.id, req.username]);
        liked = true;
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') {
          await pool.query('DELETE FROM post_likes WHERE post_id = ? AND username = ?', [req.params.id, req.username]);
          liked = false;
        } else throw e;
      }
      const [cnt] = await pool.query('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?', [req.params.id]);
      await bustCache('posts');
      res.json({ code: 200, liked, likes: Number(cnt[0].c) || 0 });
    } catch (_) {
      res.status(500).json({ code: 500, msg: '操作失败' });
    }
  });

  app.get('/api/posts/:id/comments', async (req, res) => {
    try {
      const { rows, pagination } = await cachedList(
        'postc',
        req,
        'SELECT pc.*, u.avatar FROM post_comments pc LEFT JOIN users u ON pc.username = u.username WHERE pc.post_id = ? ORDER BY pc.create_time ASC',
        [req.params.id]
      );
      res.json({ code: 200, data: rows, pagination });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  app.post('/api/posts/:id/comments', requireAuth, async (req, res) => {
    const { content } = req.body || {};
    const username = req.username;
    if (!content || String(content).length > 2000) return res.status(400).json({ code: 400, msg: '回复内容不能为空且不超2000字' });
    if (containsSensitive(content)) return rejectSensitive(res);
    try {
      await pool.query('INSERT INTO post_comments (post_id, username, content) VALUES (?, ?, ?)', [
        req.params.id, username, clampStr(content, 2000),
      ]);
      await bustCache('postc');
      res.json({ code: 200 });
    } catch (_) {
      res.status(500).json({ code: 500 });
    }
  });

  // ==========================================
  // 8. 默认入口与启动
  // ==========================================
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
  });

  const PORT = Number(process.env.PORT || 3000);
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`TechShare worker ${process.pid} listening on http://0.0.0.0:${PORT} (store=${Store.configured ? 'on' : 'off'})`);
  });

  const shutdown = async () => {
    console.log(`[worker ${process.pid}] shutting down`);
    server.close(async () => {
      try {
        await pool.end();
      } catch (_) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
