// 存量违禁词扫描：只列出、不删除（删不删人工定）。
// 用法（backend/ 下）：node scan-sensitive.js
// 词表与 server.js 保持一致：内置 + SENSITIVE_WORDS 环境变量（逗号分隔）追加。
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(require('os').homedir(), '.config', 'techshare', '.env') });

const WORDS = ['法轮功', '赌博', '博彩', '六合彩', 'av女优', '裸聊', '刷单', '兼职打字员', '代开发票', '办证',
  ...(process.env.SENSITIVE_WORDS || '').split(',').map((s) => s.trim()).filter(Boolean)];

async function main() {
  const mysql = require('mysql2/promise');
  const pool = await mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, port: Number(process.env.DB_PORT || 3306),
  });
  const hits = [];
  const check = (table, id, who, fields) => {
    for (const [name, text] of Object.entries(fields)) {
      const t = String(text || '').toLowerCase();
      for (const w of WORDS) {
        if (w && t.includes(w.toLowerCase())) {
          hits.push({ table, id, who, field: name, word: w });
          break;
        }
      }
    }
  };
  // 分批读（MEDIUMTEXT 全文一次全载会爆内存，每批 1000）
  async function pages(sql, params, fn) {
    let offset = 0;
    for (;;) {
      const [rows] = await pool.query(`${sql} LIMIT 1000 OFFSET ${offset}`, params);
      if (!rows.length) break;
      for (const r of rows) fn(r);
      if (rows.length < 1000) break;
      offset += 1000;
    }
  }
  await pages('SELECT id, username, title, content FROM posts ORDER BY id', [], (p) => check('posts', p.id, p.username, { title: p.title, content: p.content }));
  await pages('SELECT id, username, content FROM comments ORDER BY id', [], (c) => check('comments', c.id, c.username, { content: c.content }));
  await pages('SELECT id, username, content FROM post_comments ORDER BY id', [], (c) => check('post_comments', c.id, c.username, { content: c.content }));
  await pages('SELECT id, uploader, title, description FROM resources ORDER BY id', [], (r) => check('resources', r.id, r.uploader, { title: r.title, description: r.description }));
  await pages('SELECT username, signature FROM users ORDER BY id', [], (u) => check('users', u.username, u.username, { signature: u.signature }));
  await pool.end();
  console.log(`词表 ${WORDS.length} 个，命中 ${hits.length} 条：`);
  for (const h of hits.slice(0, 100)) console.log(`  [${h.table}#${h.id} @${h.who}] ${h.field} ← "${h.word}"`);
  if (hits.length > 100) console.log(`  ...等共 ${hits.length} 条`);
}

main().catch((e) => { console.error('扫描失败:', e.message); process.exit(1); });
