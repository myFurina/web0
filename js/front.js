const API_BASE_URL = '/api';
const PAGE_SIZE = 12;

window.onload = async () => {
    const username = localStorage.getItem('username');
    const resourceList = document.getElementById('resource-list');
    const commentList = document.getElementById('commentList');

    // 1. 统一渲染用户信息（支持不同页面的 ID）
    const userDisplay = document.getElementById('userInfoDisplay') || document.getElementById('userInfo');
    if (userDisplay && username) userDisplay.innerText = `👤 ${username}`;

    // 2. 首页逻辑：分页加载资源
    if (resourceList) {
        let page = 1;
        let done = false;
        let loading = false;

        const esc = (v) => (window.escapeHtml ? window.escapeHtml(v) : String(v == null ? '' : v));
        const render = (items, append) => {
            const html = items.map(item => `
                <div class="resource-card">
                    <div class="card-header">
                        <span class="category-tag">${esc(item.category || '')}</span>
                        <span class="post-time">${esc(item.upload_time || '')}</span>
                    </div>
                    <h3>${esc(item.title)}</h3>
                    <div class="card-footer">
                        <span class="uploader">👤 ${esc(item.uploader || '')}</span>
                        <a href="/api/resources/download/${Number(item.id) || 0}" class="view-link">下载查看 →</a>
                    </div>
                </div>
            `).join('');
            resourceList.innerHTML = append ? resourceList.innerHTML + html : html;
        };

        const ensureMoreBtn = () => {
            let btn = document.getElementById('resourceMoreBtn');
            if (done) { if (btn) btn.remove(); return; }
            if (!btn) {
                btn = document.createElement('button');
                btn.id = 'resourceMoreBtn';
                btn.textContent = '加载更多';
                btn.style.cssText = 'display:block;margin:20px auto;padding:10px 28px;cursor:pointer;';
                btn.onclick = loadMore;
                resourceList.after(btn);
            }
        };

        async function loadMore() {
            if (loading || done) return;
            loading = true;
            try {
                // 优先统一封装（含鉴权头），降级原生 fetch
                const res = window.API
                    ? await window.API.get(`${API_BASE_URL}/resources`, { page, limit: PAGE_SIZE })
                    : await fetch(`${API_BASE_URL}/resources?page=${page}&limit=${PAGE_SIZE}`).then(r => r.json());
                const data = res.data || [];
                render(data, page > 1);
                if (data.length < PAGE_SIZE) done = true;
                else page++;
                ensureMoreBtn();
            } catch (_) {
                resourceList.innerHTML = '<div class="loading" style="color:#ef4444;">❌ 加载失败</div>';
            } finally {
                loading = false;
            }
        }

        loadMore();
    }

    // 3. 社区逻辑：分页加载评论
    if (commentList) {
        let page = 1;
        let done = false;

        const render = (items, append) => {
            const html = items.map(item => `
                <div class="comment-item">
                    <div class="avatar">${esc(item.username ? item.username[0].toUpperCase() : '?')}</div>
                    <div class="comment-info">
                        <div>
                            <span class="comment-user">${esc(item.username)}</span>
                            <span class="comment-time">${esc(new Date(item.create_time).toLocaleString())}</span>
                        </div>
                        <div class="comment-content">${esc(item.content)}</div>
                    </div>
                </div>
            `).join('');
            if (!append && (!items || items.length === 0)) {
                commentList.innerHTML = '<div class="loading">暂无动态，快来抢沙发吧！</div>';
                return;
            }
            commentList.innerHTML = append ? commentList.innerHTML + html : html;
        };

        const loadComments = async (reset) => {
            if (reset) { page = 1; done = false; }
            if (done) return;
            try {
                const json = window.API
                    ? await window.API.get(`${API_BASE_URL}/comments`, { page, limit: PAGE_SIZE })
                    : await fetch(`${API_BASE_URL}/comments?page=${page}&limit=${PAGE_SIZE}`).then(r => r.json());
                const comments = json.data || [];
                render(comments, page > 1);
                if (comments.length < PAGE_SIZE) done = true;
                else page++;
            } catch (err) {
                commentList.innerHTML = '<div class="loading" style="color:#ef4444;">❌ 加载失败</div>';
            }
        };

        loadComments(true);

        // 将提交逻辑绑定到全局，供 HTML 的 onclick 调用
        window.submitComment = async () => {
            const content = document.getElementById('commentContent').value.trim();
            if (!content) return alert('内容不能为空');

            const res = window.API
                ? await window.API.send('POST', `${API_BASE_URL}/comments`, { username, content })
                : await fetch(`${API_BASE_URL}/comments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, content })
                }).then(r => r.json());

            if (res.code === 200) {
                document.getElementById('commentContent').value = '';
                loadComments(true);
            }
        };
    }

    // 4. 发布页逻辑：share.html 自带上传流程（含 R2 直传），这里不再重复绑定，
    //    仅做兜底——如果某页面有 shareForm 却无自己的 onsubmit，才用传统方式提交。
    const shareForm = document.getElementById('shareForm');
    if (shareForm && !shareForm.onsubmit) {
        const uploaderInput = document.getElementById('uploader');
        if (uploaderInput) uploaderInput.value = username;
        shareForm.onsubmit = () => {
            alert('请使用页面自带的发布流程上传文件');
            return false;
        };
    } else if (shareForm) {
        const uploaderInput = document.getElementById('uploader');
        if (uploaderInput && !uploaderInput.value) uploaderInput.value = username;
    }
};
