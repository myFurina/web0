// 一次性：把本地 uploads/ 存量文件迁到对象存储（标准 S3 / R2），并回填 DB 里的 file_url/avatar
// 用法：配好 ../.env（含 S3_* 或 R2_* 与 DB_*）后，在 backend/ 下执行 npm run migrate:r2
// 幂等：已是 http(s) 的 URL 会跳过；迁移成功后本地文件保留（手动删）。
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(os.homedir(), '.config', 'techshare', '.env') });

function pick(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return '';
}

async function main() {
  const endpoint = pick('S3_ENDPOINT') ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  const bucket = pick('S3_BUCKET', 'R2_BUCKET');
  const ak = pick('S3_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID');
  const sk = pick('S3_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY');
  const base = pick('S3_PUBLIC_URL', 'R2_PUBLIC_URL').replace(/\/+$/, '');
  const missing = [];
  if (!endpoint) missing.push('S3_ENDPOINT（或 R2_ACCOUNT_ID）');
  if (!bucket) missing.push('S3_BUCKET（或 R2_BUCKET）');
  if (!ak) missing.push('S3_ACCESS_KEY_ID（或 R2_ACCESS_KEY_ID）');
  if (!sk) missing.push('S3_SECRET_ACCESS_KEY（或 R2_SECRET_ACCESS_KEY）');
  if (!base) console.log('提示：未配 S3_PUBLIC_URL，file_url 将存裸 key（下载走临时签名，不影响使用）');
  ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].forEach((k) => { if (!process.env[k]) missing.push(k); });
  if (missing.length) {
    console.error('缺少环境变量:', missing.join(', '));
    process.exit(1);
  }
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const mysql = require('mysql2/promise');
  const mimeOf = (f) =>
    ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
       '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.zip': 'application/zip' }[path.extname(f).toLowerCase()] || 'application/octet-stream');

  const s3 = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: ak, secretAccessKey: sk },
  });
  // 部分自建 S3 按 UA 识别客户端：如配了 S3_USER_AGENT 则同样覆盖
  if (process.env.S3_USER_AGENT && s3.middlewareStack) {
    s3.middlewareStack.add(
      (next) => async (args) => {
        if (args.request && args.request.headers) args.request.headers['user-agent'] = process.env.S3_USER_AGENT;
        return next(args);
      },
      { step: 'build', name: 'forceUserAgent', override: true }
    );
  }
  const pool = await mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, port: Number(process.env.DB_PORT || 3306),
  });

  const putFile = async (localPath, prefix) => {
    const key = `${prefix}/${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(localPath).replace(/[^a-zA-Z0-9.\-_\u4e00-\u9fa5]/g, '_')}`;
    const buf = await fsp.readFile(localPath);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: mimeOf(localPath) }));
    return base ? `${base}/${key}` : key;
  };

  let upRes = 0, upAv = 0;
  const [resources] = await pool.query('SELECT id, file_url FROM resources');
  for (const r of resources) {
    if (!r.file_url || /^https?:\/\//i.test(r.file_url)) continue;
    const lp = path.join(__dirname, '..', r.file_url);
    if (!fs.existsSync(lp)) { console.warn('跳过(本地无文件):', r.file_url); continue; }
    const url = await putFile(lp, 'resources');
    await pool.query('UPDATE resources SET file_url = ? WHERE id = ?', [url, r.id]);
    upRes++;
    console.log(`resources#${r.id} -> ${url}`);
  }
  const [users] = await pool.query('SELECT username, avatar FROM users WHERE avatar IS NOT NULL');
  for (const u of users) {
    if (!u.avatar || /^https?:\/\//i.test(u.avatar) || !u.avatar.includes('/uploads/')) continue;
    const lp = path.join(__dirname, '..', u.avatar);
    if (!fs.existsSync(lp)) { console.warn('跳过(本地无文件):', u.avatar); continue; }
    const url = await putFile(lp, 'avatars');
    await pool.query('UPDATE users SET avatar = ? WHERE username = ?', [url, u.username]);
    upAv++;
    console.log(`users@${u.username} -> ${url}`);
  }
  await pool.end();
  console.log(`完成：resources ${upRes} 个，avatars ${upAv} 个`);
}

main().catch((e) => { console.error('迁移失败:', e.message); process.exit(1); });
