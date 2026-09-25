// TechShare 前端统一 API 封装
// - 自动携带 Authorization: Bearer <token>（login 后写入）
// - uploadResource：优先 R2 预签名直传（不占 Node 带宽），失败/未配置自动回落传统 multipart 上传
window.API = (() => {
  const base = '';

  function authHeaders(extra) {
    const h = Object.assign({}, extra);
    try {
      const t = localStorage.getItem('token');
      if (t) h['Authorization'] = 'Bearer ' + t;
    } catch (_) {}
    return h;
  }

  function qs(params) {
    if (!params) return '';
    const s = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') s.append(k, params[k]);
    });
    const q = s.toString();
    return q ? '?' + q : '';
  }

  // 读响应：非 2xx 或非 JSON（如 Nginx 502 HTML 页）抛结构化错误，调用方可区分展示
  async function readJson(res) {
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      err.retryable = res.status === 502 || res.status === 503 || res.status === 504;
      try {
        if (ct.includes('json')) err.data = await res.json();
      } catch (_) {}
      throw err;
    }
    if (!ct.includes('json')) {
      const err = new Error('响应不是 JSON（可能是网关错误页）');
      err.status = res.status;
      err.retryable = res.status >= 500;
      throw err;
    }
    return res.json();
  }

  // 简单延迟
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function get(path, params) {
    let lastErr;
    // GET 幂等：网关类错误自动重试 1 次（覆盖 DNS 切换等瞬态故障）
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(base + path + qs(params), { headers: authHeaders() });
        return await readJson(res);
      } catch (e) {
        lastErr = e;
        if (!e.retryable && e.status) break;
        if (i === 0) await sleep(400);
      }
    }
    throw lastErr;
  }

  async function send(method, path, body) {
    const doFetch = () =>
      fetch(base + path, {
        method,
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: body ? JSON.stringify(body) : undefined,
      }).then(readJson);
    try {
      return await doFetch();
    } catch (e) {
      // 登录 POST 重试是安全的（只读校验，无副作用）；其他写操作不自动重试，防重复提交
      const safeRetry = method === 'GET' || path === '/api/login';
      if (safeRetry && (e.retryable || !e.status)) {
        await sleep(400);
        return await doFetch();
      }
      throw e;
    }
  }

  // 带进度的 XHR（FormData 表单或 R2 PUT 直传都走这里，fetch 看不到上传进度）
  function xhrSend(opts) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(opts.method, opts.url);
      Object.keys(opts.headers || {}).forEach((k) => xhr.setRequestHeader(k, opts.headers[k]));
      if (xhr.upload && opts.onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) opts.onProgress(Math.round((e.loaded / e.total) * 100));
        });
      }
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(opts.body);
    });
  }

  // 预签名 POST 经同源 /s3up/ 代理直传 S3（Nginx 改写 UA，字节不进 Node）。
  // 要求 key 按段编码（key 含中文/日期斜杠），policy 表单字段原样提交。
  async function uploadViaPolicy(meta, file, onProgress) {
    const pol = await send('POST', '/api/upload/policy', {
      filename: file.name,
      mimetype: file.type || 'application/octet-stream',
      prefix: 'resources',
    });
    if (!pol || pol.code !== 200 || !pol.data || !pol.data.fields || !pol.data.key) {
      throw new Error((pol && pol.msg) || '预签名失败');
    }
    const fd = new FormData();
    Object.keys(pol.data.fields).forEach((k) => fd.append(k, pol.data.fields[k]));
    fd.append('file', file);
    const proxyPath = '/s3up/' + String(pol.data.key).split('/').map(encodeURIComponent).join('/');
    const r = await xhrSend({ method: 'POST', url: base + proxyPath, body: fd, headers: {}, onProgress });
    if (r.status !== 200 && r.status !== 204) throw new Error('S3 直传失败: HTTP ' + r.status + ' ' + (r.text || '').slice(0, 200));
    return await send('POST', '/api/resources/register', {
      title: meta.title,
      category: meta.category,
      description: meta.description || '',
      uploader: meta.uploader,
      fileUrl: pol.data.publicUrl || pol.data.key, // 私有桶无 publicUrl 时用裸 key，下载走临时签名
      fileSize: file.size,
      fileType: file.type || '',
    });
  }

  // 资源发布：0) policy 经 Nginx 代理直传 S3 → 1) 预签名 PUT 直连 R2 → 2) 传统 multipart 经 Node
  async function uploadResource(meta, file, onProgress) {
    // 0) 预签名 POST（标准 S3/R2，经 Nginx 同源代理）
    try {
      return await uploadViaPolicy(meta, file, onProgress);
    } catch (_) {
      // policy 不可用（未配存储/不支持）→ 继续下一级
    }
    try {
      const pre = await send('POST', '/api/upload/presign', {
        filename: file.name,
        mimetype: file.type || 'application/octet-stream',
      });
      if (pre && pre.code === 200 && pre.data && pre.data.uploadUrl) {
        await xhrSend({
          method: 'PUT',
          url: pre.data.uploadUrl,
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          onProgress,
        });
        return await send('POST', '/api/resources/register', {
          title: meta.title,
          category: meta.category,
          description: meta.description || '',
          uploader: meta.uploader,
          fileUrl: pre.data.publicUrl,
          fileSize: file.size,
          fileType: file.type || '',
        });
      }
    } catch (_) {
      // 直传失败（R2 未配/CORS/断网）→ 回落传统上传
    }
    // 2) 回落：传统 multipart 经 Node 中转（本地盘或 R2 由后端决定）
    const fd = new FormData();
    fd.append('title', meta.title);
    fd.append('category', meta.category);
    fd.append('description', meta.description || '');
    fd.append('uploader', meta.uploader);
    fd.append('file', file);
    const r = await xhrSend({
      method: 'POST',
      url: base + '/api/resources/upload',
      body: fd,
      headers: authHeaders(),
      onProgress,
    });
    try {
      return JSON.parse(r.text);
    } catch (_) {
      return { code: r.status === 200 ? 200 : 500, msg: '上传失败' };
    }
  }

  return { base, authHeaders, get, send, xhrSend, uploadResource };
})();
