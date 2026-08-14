/**
 * 文件职责：认证工具模块，负责 token 的读写清理与鉴权请求头拼装。
 */

(function () {
    // 单独定义 token key，避免在多个位置硬编码同一个 localStorage 键名。
    const TOKEN_KEY = 'proactive_admin_token';

    function hasBridge() {
        // 原生 Plugin Pages 模式下鉴权由 Dashboard 承担，插件自身不再维护令牌。
        return !!window.AstrBotPluginPage;
    }

    // ------------------------------------------------------------------
    // 安全存储适配：原生 Plugin Pages 的 iframe 沙箱不含 allow-same-origin，
    // 直接访问 window.localStorage 会抛 SecurityError；此时降级为内存存储，
    // 保证主题偏好、配置草稿、滚动位置等功能仍可正常工作（仅当前会话内有效）。
    // ------------------------------------------------------------------
    const memoryStore = new Map();
    let nativeStorage = null;
    try {
        const probe = window.localStorage;
        probe.setItem('__proactive_probe__', '1');
        probe.removeItem('__proactive_probe__');
        nativeStorage = probe;
    } catch (e) {
        nativeStorage = null;
    }

    window.SafeStorage = {
        getItem: function (key) {
            if (nativeStorage) {
                try { return nativeStorage.getItem(key); } catch (e) { return null; }
            }
            return memoryStore.has(key) ? memoryStore.get(key) : null;
        },
        setItem: function (key, value) {
            if (nativeStorage) {
                try { nativeStorage.setItem(key, String(value)); } catch (e) { /* 写入失败不阻断业务 */ }
                return;
            }
            memoryStore.set(key, String(value));
        },
        removeItem: function (key) {
            if (nativeStorage) {
                try { nativeStorage.removeItem(key); } catch (e) { /* 删除失败不阻断业务 */ }
                return;
            }
            memoryStore.delete(key);
        },
    };

    window.AuthUtil = {
        getToken: function () {
            if (hasBridge()) {
                // bridge 模式统一返回 no-auth 哨兵值，避免携带旧令牌或触发登录流程。
                return 'no-auth';
            }
            // 统一从安全存储读取访问令牌；读取失败时返回 null 让上层自行兜底。
            return window.SafeStorage.getItem(TOKEN_KEY);
        },
        setToken: function (token) {
            if (hasBridge()) {
                // 原生模式无需持久化令牌；SafeStorage 在无存储环境下也会自动降级。
                return;
            }
            // 登录成功后将 token 持久化，供后续页面刷新和 WebSocket 连接复用。
            window.SafeStorage.setItem(TOKEN_KEY, token);
        },
        clearToken: function () {
            // token 失效或用户主动退出时清空本地凭据。
            window.SafeStorage.removeItem(TOKEN_KEY);
        },
        withAuthHeaders: function (headers) {
            const token = window.AuthUtil.getToken();
            // 始终先复制一份 headers，避免调用方对象被原地修改。
            const base = Object.assign({}, headers || {});
            if (token && token !== 'no-auth') {
                // 仅在真实鉴权场景下注入 Authorization；no-auth 是前后端协商用哨兵值。
                base.Authorization = 'Bearer ' + token;
            }
            return base;
        }
    };
})();

