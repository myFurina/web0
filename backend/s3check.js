// S3 连通性诊断：ListBuckets + Put + Get + Delete，只打印状态码，不打印任何密钥
// 用法（在 backend/ 下）：node s3check.js
// 读 ../.env 的 S3_*（没有则读 R2_*）；全部 200/OK = 存储可用
const path = require('path');
const os = require('os');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(os.homedir(), '.config', 'techshare', '.env') });

async function main() {
  let SDK;
  try {
    SDK = require('@aws-sdk/client-s3');
  } catch (_) {
    console.log('SKIP: 未安装 @aws-sdk/client-s3');
    process.exit(2);
  }
  const endpoint = (process.env.S3_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');
  const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || '';
  const ak = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
  const sk = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';
  if (!endpoint || !bucket || !ak || !sk) {
    console.log('SKIP: 存储未配置（endpoint/bucket/AK/SK 缺失）');
    process.exit(2);
  }
  console.log('endpoint:', endpoint);
  console.log('bucket:', bucket);
  console.log('pathStyle:', process.env.S3_FORCE_PATH_STYLE === 'true');
  console.log('userAgent:', process.env.S3_USER_AGENT ? '(已设置)' : '(未设置)');

  const c = new SDK.S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: ak, secretAccessKey: sk },
  });
  const ua = process.env.S3_USER_AGENT;
  if (ua && c.middlewareStack) {
    c.middlewareStack.add((next) => async (args) => {
      if (args.request && args.request.headers) args.request.headers['user-agent'] = ua;
      return next(args);
    }, { step: 'build' });
  }
  const st = (e) => (e.$metadata && e.$metadata.httpStatusCode) || '?';
  try {
    const r = await c.send(new SDK.ListBucketsCommand({}));
    console.log('ListBuckets:', 200, JSON.stringify((r.Buckets || []).map((b) => b.Name)));
  } catch (e) { console.log('ListBuckets:', st(e), e.name); }
  const key = 'smoke/' + Date.now() + '.txt';
  try {
    await c.send(new SDK.PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from('smoke-ok'), ContentType: 'text/plain' }));
    console.log('Put:', 200, key);
  } catch (e) { console.log('Put:', st(e), e.name); return; }
  try {
    const g = await c.send(new SDK.GetObjectCommand({ Bucket: bucket, Key: key }));
    console.log('Get:', 200, 'body=' + (await g.Body.transformToString()));
  } catch (e) { console.log('Get:', st(e), e.name); }
  try {
    await c.send(new SDK.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    console.log('Delete:', 200);
  } catch (e) { console.log('Delete:', st(e), e.name); }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
