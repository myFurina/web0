// 孤儿对象清扫：删掉“传了但没登记”的直传文件（配额只认 DB 行，孤儿会绕过配额）。
// 逻辑：列桶 resources/ + avatars/ 前缀，对 DB 的 file_url/avatar 取 key 集合；
//      超过 --older-than 小时（默认 24）且不在集合中的 key 即删。
// 用法（backend/ 下）：
//   node sweep-orphans.js --dry          只列出，不删（先看）
//   node sweep-orphans.js                实删
//   node sweep-orphans.js --older-than 72
// 定时：crontab -e 加一行每天凌晨跑：
//   0 3 * * * cd /path/to/test/backend && /usr/bin/node sweep-orphans.js >> /var/log/sweep-orphans.log 2>&1
// 注意：只认 S3/R2 存储模式；本地 uploads/ 模式直接退出（删本地文件风险高，手动处理）。
const path = require('path');
const os = require('os');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(os.homedir(), '.config', 'techshare', '.env') });

const DRY = process.argv.includes('--dry');
const olderIdx = process.argv.indexOf('--older-than');
const OLDER_HOURS = olderIdx > -1 ? Math.max(1, Number(process.argv[olderIdx + 1]) || 24) : 24;

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
  if (!endpoint || !bucket || !ak || !sk) {
    console.error('存储未配置（S3_* 或 R2_* 缺失），退出');
    process.exit(2);
  }
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const mysql = require('mysql2/promise');
  const s3 = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: ak, secretAccessKey: sk },
  });
  const pool = await mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, port: Number(process.env.DB_PORT || 3306),
  });

  // DB 里的合法 key 集合（裸 key 直接收；公网 URL 剥掉 publicBase 前缀）
  const base = pick('S3_PUBLIC_URL', 'R2_PUBLIC_URL').replace(/\/+$/, '');
  const keyOf = (u) => {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return base && u.startsWith(base + '/') ? u.slice(base.length + 1) : null;
    return /^(resources|avatars)\//.test(u) ? u : null;
  };
  const legit = new Set();
  const [res] = await pool.query('SELECT file_url FROM resources');
  const [users] = await pool.query('SELECT avatar FROM users WHERE avatar IS NOT NULL');
  for (const r of [...res, ...users]) {
    const k = keyOf(r.file_url || r.avatar);
    if (k) legit.add(k);
  }

  // 列桶（分页），只看两前缀
  const cutoff = Date.now() - OLDER_HOURS * 3600 * 1000;
  const orphans = [];
  for (const prefix of ['resources/', 'avatars/']) {
    let token;
    do {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of out.Contents || []) {
        if (!legit.has(o.Key) && new Date(o.LastModified).getTime() < cutoff) orphans.push(o.Key);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  console.log(`合法key: ${legit.size} 个，孤儿(超${OLDER_HOURS}h无主): ${orphans.length} 个${DRY ? '【试运行，不删】' : ''}`);
  for (const k of orphans.slice(0, 50)) console.log('  ' + (DRY ? '将删 ' : '删除 ') + k);
  if (orphans.length > 50) console.log(`  ...等共 ${orphans.length} 个`);

  if (!DRY && orphans.length) {
    // 批量删，每批 1000（S3 上限）
    for (let i = 0; i < orphans.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: orphans.slice(i, i + 1000).map((Key) => ({ Key })) },
      }));
    }
    console.log(`已删除 ${orphans.length} 个孤儿对象`);
  }
  await pool.end();
}

main().catch((e) => { console.error('清扫失败:', e.message); process.exit(1); });
