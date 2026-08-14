/**
 * 文件职责：实时推送 Hook，负责全局单例连接管理与实时消息分发。
 * 按运行环境自动选择通道：
 * - 独立管理端模式：使用 WebSocket（/ws）；
 * - 原生 Plugin Pages 模式：bridge 不支持 WebSocket，改用 bridge.subscribeSSE('events')。
 */

// 管理端全局只维护一个实时连接，避免多个组件重复建立相同连接。
let __globalWs = null;
// bridge.subscribeSSE 返回的订阅 ID；null 表示当前没有活跃订阅。
let __sseSubscriptionId = null;
// 订阅建立中标志，防止 ensureGlobalSse 被并发调用时重复订阅。
let __sseConnecting = false;
// 所有订阅实时数据的回调统一挂到一个监听集合中，由单连接分发。
let __wsListeners = new Set();
// 重连定时器与退避参数：插件重载期间避免高频重连打满日志。
let __reconnectTimer = null;
const WS_RECONNECT_BASE_DELAY_MS = 1000;
const WS_RECONNECT_MAX_DELAY_MS = 10000;
let __nextReconnectDelayMs = WS_RECONNECT_BASE_DELAY_MS;

function getBridge() {
    return window.AstrBotPluginPage || null;
}

function clearReconnectTimer() {
    if (!__reconnectTimer) return;
    clearTimeout(__reconnectTimer);
    __reconnectTimer = null;
}

function resetReconnectBackoff() {
    __nextReconnectDelayMs = WS_RECONNECT_BASE_DELAY_MS;
    clearReconnectTimer();
}

function dispatchData(data) {
    __wsListeners.forEach((listener) => {
        try {
            // 将后端 payload 原样广播给所有订阅者，由页面组件自行决定如何消费。
            listener(data);
        } catch (e) {
            // 单个监听器报错不应影响其他订阅者继续接收消息。
        }
    });
}

function handlePushMessage(msg) {
    // 仅处理后端定义的两类数据推送消息，其余消息类型忽略。
    if (msg && typeof msg === 'object' && (msg.type === 'full_update' || msg.type === 'update')) {
        dispatchData(msg.data || {});
    }
}

function scheduleReconnect() {
    // 没有任何订阅者时不需要重连，避免后台空转。
    if (__wsListeners.size === 0) return;
    // 已有重连任务时直接复用，防止重复排队。
    if (__reconnectTimer) return;

    const delay = __nextReconnectDelayMs;
    __nextReconnectDelayMs = Math.min(__nextReconnectDelayMs * 2, WS_RECONNECT_MAX_DELAY_MS);

    __reconnectTimer = setTimeout(() => {
        __reconnectTimer = null;
        ensureGlobalConnection();
    }, delay);
}

// ------------------------------------------------------------------
// SSE 通道（原生 Plugin Pages 模式）
// ------------------------------------------------------------------

function teardownSse() {
    const bridge = getBridge();
    if (bridge && __sseSubscriptionId !== null) {
        try {
            bridge.unsubscribeSSE(__sseSubscriptionId);
        } catch (e) {
            // 取消订阅失败不阻断清理流程。
        }
    }
    __sseSubscriptionId = null;
}

function ensureGlobalSse() {
    const bridge = getBridge();
    if (!bridge || __sseSubscriptionId !== null || __sseConnecting) return;
    __sseConnecting = true;

    bridge.subscribeSSE('events', {
        onOpen() {
            // 连接恢复后重置退避，后续若再次断开可以从短延迟开始。
            resetReconnectBackoff();
        },
        onMessage(event) {
            // bridge 会把 JSON 内容自动解析到 event.parsed，结构与 WebSocket 消息一致。
            handlePushMessage(event && event.parsed);
        },
        onError() {
            // 连接异常时先清理订阅，再走统一的退避重连路径。
            if (__sseSubscriptionId !== null) {
                teardownSse();
                scheduleReconnect();
            }
        },
    }).then((subscriptionId) => {
        __sseConnecting = false;
        __sseSubscriptionId = subscriptionId;
    }).catch(() => {
        // 订阅失败（如插件重载期间）同样交给退避重连处理。
        __sseConnecting = false;
        scheduleReconnect();
    });
}

// ------------------------------------------------------------------
// WebSocket 通道（独立管理端模式）
// ------------------------------------------------------------------

function ensureGlobalWs() {
    // 若连接已存在且仍处于“连接中 / 已连接”状态，则直接复用。
    if (__globalWs && (__globalWs.readyState === WebSocket.OPEN || __globalWs.readyState === WebSocket.CONNECTING)) {
        return;
    }

    // 与 HTTP 保持相同的 token 来源，统一从 AuthUtil 中读取。
    const token = window.AuthUtil.getToken();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 开启鉴权时通过 query 传 token；无鉴权或 no-auth 场景则不附加参数。
    const tokenQuery = token && token !== 'no-auth' ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws${tokenQuery}`);
    __globalWs = ws;

    ws.onopen = function () {
        // 连接恢复后重置退避，后续若再次断开可以从短延迟开始。
        if (__globalWs === ws) {
            resetReconnectBackoff();
        }
    };

    ws.onmessage = function (event) {
        try {
            handlePushMessage(JSON.parse(event.data));
        } catch (e) {
            // 非 JSON 消息或异常格式直接忽略，避免污染控制台与中断连接。
        }
    };

    ws.onerror = function () {
        // 出错后主动触发 close 流程，统一走 onclose 的回收与重连路径。
        try {
            ws.close();
        } catch (e) {
            // 某些浏览器状态下 close 可能抛错，这里吞掉即可。
        }
    };

    ws.onclose = function () {
        // 仅处理当前活动连接的关闭事件，避免旧连接回调干扰新的连接状态。
        if (__globalWs !== ws) {
            return;
        }
        __globalWs = null;
        // 连接关闭后自动尝试重连，覆盖插件重载等短暂不可用场景。
        scheduleReconnect();
    };
}

function ensureGlobalConnection() {
    if (getBridge()) {
        ensureGlobalSse();
    } else {
        ensureGlobalWs();
    }
}

function useWebSocket(onData) {
    React.useEffect(() => {
        if (typeof onData === 'function') {
            __wsListeners.add(onData);
        }

        // 只要有任意一个订阅者存在，就确保全局连接已建立。
        ensureGlobalConnection();

        return () => {
            if (typeof onData === 'function') {
                __wsListeners.delete(onData);
            }
            // 最后一个订阅者离开时主动关闭连接，减少空闲资源占用。
            if (__wsListeners.size === 0) {
                clearReconnectTimer();
                __nextReconnectDelayMs = WS_RECONNECT_BASE_DELAY_MS;
                teardownSse();
                if (__globalWs) {
                    try {
                        __globalWs.close();
                    } catch (e) {
                        // 某些浏览器状态下 close 可能抛错，这里吞掉即可。
                    }
                }
                __globalWs = null;
            }
        };
    }, [onData]);
}

// 页面卸载时清理 SSE 订阅，避免 Dashboard 侧残留连接（原生模式）。
window.addEventListener('beforeunload', () => {
    teardownSse();
});

// 暴露为全局 Hook，供入口应用与各页面脚本直接调用。
window.useWebSocket = useWebSocket;
