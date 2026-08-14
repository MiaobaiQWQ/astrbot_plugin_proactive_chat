/**
 * 文件职责：HTTP 工具模块，负责统一请求封装、鉴权头注入与错误处理。
 * 按运行环境自动选择请求通道：
 * - 原生 Plugin Pages 模式（存在 window.AstrBotPluginPage bridge）：经 bridge.apiGet/apiPost 转发；
 * - 独立管理端模式（回退）：走原生 fetch + Bearer Token。
 */

(function () {
    function getBridge() {
        // 页面运行在 AstrBot WebUI 内时会自动注入 bridge SDK；独立模式下恒为 null。
        return window.AstrBotPluginPage || null;
    }

    function toBridgeEndpoint(url) {
        // bridge 的 endpoint 是插件内相对路径，需去掉 /api/ 前缀与开头的 /。
        let endpoint = String(url).replace(/^\/?api\//, '').replace(/^\//, '');
        // 业务层为兼容独立模式已对路径段做过 encodeURIComponent，而 WebUI 宿主拼接
        // /api/v1/plugins/extensions/... 时会对各段再次编码，导致服务端收到双重编码
        // （如 %3A 变 %253A）匹配失败；这里先解码一次还原为原始值再交给 bridge。
        try {
            endpoint = decodeURIComponent(endpoint);
        } catch (e) {
            // 解码失败说明路径本身含非法转义，保持原样交由宿主处理。
        }
        return endpoint;
    }

    function buildHeaders(extra) {
        // 所有请求默认发送 JSON；如调用方有额外头信息，再在此基础上合并。
        return window.AuthUtil.withAuthHeaders(
            Object.assign({ 'Content-Type': 'application/json' }, extra || {})
        );
    }

    async function request(url, options) {
        // 复制 options，避免上层传入对象在内部被意外修改。
        const opts = Object.assign({}, options || {});
        // 在统一入口补齐认证头与默认内容类型，减少各业务文件重复代码。
        opts.headers = buildHeaders(opts.headers || {});

        const response = await fetch(url, opts);
        let payload = null;
        try {
            // 后端大多数接口都返回 JSON；若解析失败则容忍并回退为 null。
            payload = await response.json();
        } catch (e) {
            payload = null;
        }

        if (!response.ok) {
            // 优先透传后端明确返回的 error 字段，提升前端报错可读性。
            const message = payload && payload.error ? payload.error : '请求失败';
            throw new Error(message);
        }

        return payload;
    }

    window.HttpUtil = {
        // 当前是否运行在原生 Plugin Pages 内，供其它模块做模式分支。
        isNativePage: function () {
            return !!getBridge();
        },
        get: function (url) {
            const bridge = getBridge();
            if (bridge) {
                // bridge 失败时 reject 为 Error，与 fetch 模式的 throw 语义一致。
                return bridge.apiGet(toBridgeEndpoint(url));
            }
            return request(url, { method: 'GET' });
        },
        post: function (url, body) {
            const bridge = getBridge();
            if (bridge) {
                return bridge.apiPost(toBridgeEndpoint(url), body || {});
            }
            // POST 请求统一将 body 序列化为 JSON；空 body 则发送空对象保持接口风格一致。
            return request(url, {
                method: 'POST',
                body: JSON.stringify(body || {}),
            });
        },
        del: function (url) {
            const bridge = getBridge();
            if (bridge) {
                // bridge 不支持 DELETE：重置会话覆写走 /reset 子路径，其余删除语义走 /delete 子路径。
                const endpoint = toBridgeEndpoint(url);
                const suffix = endpoint.indexOf('session-config/') === 0 ? '/reset' : '/delete';
                return bridge.apiPost(endpoint + suffix, {});
            }
            return request(url, { method: 'DELETE' });
        }
    };
})();
