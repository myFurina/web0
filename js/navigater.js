// 获取所有带下拉菜单的导航项
const dropdownItems = document.querySelectorAll('.has-dropdown');

// 为每个下拉项添加点击事件（适配移动端/非hover场景）
dropdownItems.forEach(item => {
    // 点击导航项切换下拉菜单显示/隐藏
    item.addEventListener('click', function(e) {
        // 关键修复：只阻止“下拉触发按钮”的默认跳转，不阻止子项
        // 判断点击的是不是下拉菜单的触发链接（如“分类 ▾”）
        const triggerLink = this.querySelector('a[href="javascript:;"]');
        if (e.target === triggerLink || e.target.closest('a[href="javascript:;"]')) {
            e.preventDefault(); // 仅阻止触发按钮的默认行为

            // 关闭其他已打开的下拉菜单
            dropdownItems.forEach(elem => {
                if (elem !== this) {
                    elem.classList.remove('active');
                }
            });

            // 切换当前下拉菜单的激活态
            this.classList.toggle('active');
        }
        // 点击子项（如分类1）时，不执行e.preventDefault()，允许正常跳转
    });
});

// 点击页面空白处关闭所有下拉菜单
document.addEventListener('click', function(e) {
    if (!e.target.closest('.has-dropdown')) {
        dropdownItems.forEach(item => {
            item.classList.remove('active');
        });
    }
});