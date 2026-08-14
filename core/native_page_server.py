"""AstrBot 原生 Plugin Pages 适配模块。

当宿主 AstrBot 支持 context.register_web_api() 与 astrbot.api.web 时，
把管理端 API 挂载到 Dashboard（无需独立端口，鉴权由 Dashboard 承担），
前端页面由 pages/admin/ 目录提供；不支持时 available 为 False，
由生命周期层回退到独立 uvicorn Web 管理端。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from astrbot.api import logger

# 路由必须以插件名作为前缀，Dashboard 按该前缀转发 Page bridge 请求。
PLUGIN_NAME = "astrbot_plugin_proactive_chat"

try:
    # astrbot.api.web 提供与框架解耦的请求/响应 helper，仅新版 AstrBot 可用。
    from astrbot.api.web import (
        error_response,
        json_response,
        request,
        stream_response,
    )

    ASTRBOT_WEB_AVAILABLE = True
except ImportError:
    ASTRBOT_WEB_AVAILABLE = False


class NativePageServer:
    """原生 Plugin Pages 后端适配器，业务逻辑全部复用 WebAdminServer。"""

    def __init__(self, plugin: Any):
        self.plugin = plugin
        # 能力检测通过并完成路由注册后才置为 True。
        self.available = False

        context = getattr(plugin, "context", None)
        if context is None or not hasattr(context, "register_web_api"):
            logger.info(
                "[主动消息] 当前 AstrBot 版本不支持原生 Plugin Pages，"
                "Web 管理端将使用独立端口模式喵。"
            )
            return

        if not ASTRBOT_WEB_AVAILABLE:
            logger.info(
                "[主动消息] astrbot.api.web 不可用，无法接入原生 Plugin Pages，"
                "Web 管理端将使用独立端口模式喵。"
            )
            return

        if not getattr(plugin, "web_admin_server", None):
            # 业务处理方法都挂在 WebAdminServer 上，缺失时原生端无实现可复用。
            logger.warning(
                "[主动消息] Web 管理端组件不可用，原生 Plugin Pages 已禁用喵。"
            )
            return

        try:
            self._register_apis(context)
            self.available = True
            logger.info(
                "[主动消息] 已接入 AstrBot 原生 Plugin Pages 喵，"
                "管理入口: WebUI -> 插件 -> 插件详情页，无需独立端口。"
            )
        except Exception as e:
            self.available = False
            logger.error(f"[主动消息] 注册原生 Plugin Pages API 失败喵: {e}")

    # ------------------------------------------------------------------
    # 工具方法
    # ------------------------------------------------------------------

    @property
    def _web_admin(self) -> Any:
        return self.plugin.web_admin_server

    def _reply(self, result: tuple[dict[str, Any], int]) -> Any:
        """将统一的 (载荷, 状态码) 结果转换为 Dashboard 响应对象。"""
        payload, status_code = result
        if status_code != 200:
            # 错误载荷的提示信息统一放在 error / message 字段中。
            message = payload.get("error") or payload.get("message") or "请求失败"
            return error_response(str(message), status_code=status_code)
        return json_response(payload)

    # ------------------------------------------------------------------
    # 路由注册
    # ------------------------------------------------------------------

    def _register_apis(self, context: Any) -> None:
        register = context.register_web_api
        prefix = f"/{PLUGIN_NAME}"

        # 状态与元信息
        register(f"{prefix}/auth-info", self.api_auth_info, ["GET"], "原生模式鉴权信息")
        register(f"{prefix}/status", self.api_status, ["GET"], "插件运行状态")
        register(f"{prefix}/config", self.api_get_config, ["GET"], "读取全局配置")
        register(f"{prefix}/config", self.api_save_config, ["POST"], "保存全局配置")
        register(f"{prefix}/config-schema", self.api_config_schema, ["GET"], "配置表单 Schema")

        # 会话差异配置
        register(
            f"{prefix}/session-config/sessions",
            self.api_session_list,
            ["GET"],
            "会话配置列表",
        )
        register(
            f"{prefix}/session-config/<path:umo>",
            self.api_session_get,
            ["GET"],
            "读取会话配置",
        )
        register(
            f"{prefix}/session-config/<path:umo>",
            self.api_session_save,
            ["POST"],
            "保存会话配置",
        )
        # bridge 不支持 DELETE，重置覆写改用 POST 子路径表达。
        register(
            f"{prefix}/session-config/<path:umo>/reset",
            self.api_session_reset,
            ["POST"],
            "重置会话覆写",
        )

        # 任务管理
        register(f"{prefix}/jobs", self.api_jobs, ["GET"], "任务列表")
        register(
            f"{prefix}/jobs/<path:umo>/reschedule",
            self.api_job_reschedule,
            ["POST"],
            "重新调度任务",
        )
        register(
            f"{prefix}/jobs/<path:umo>/trigger",
            self.api_job_trigger,
            ["POST"],
            "立即触发任务",
        )
        # bridge 不支持 DELETE，取消任务改用 POST 子路径表达。
        register(
            f"{prefix}/jobs/<path:umo>/delete",
            self.api_job_delete,
            ["POST"],
            "取消任务",
        )

        # 通知系统
        register(f"{prefix}/notifications", self.api_notifications, ["GET"], "通知列表")
        register(
            f"{prefix}/notifications/read",
            self.api_notification_read,
            ["POST"],
            "通知标记已读",
        )
        register(
            f"{prefix}/notifications/read-all",
            self.api_notification_read_all,
            ["POST"],
            "通知全部已读",
        )
        register(
            f"{prefix}/notifications/refresh",
            self.api_notification_refresh,
            ["POST"],
            "刷新通知",
        )

        # 文档与其它
        register(
            f"{prefix}/markdown-files", self.api_markdown_list, ["GET"], "文档列表"
        )
        register(
            f"{prefix}/markdown-files/<path:file_path>",
            self.api_markdown_file,
            ["GET"],
            "读取文档",
        )
        register(
            f"{prefix}/open-directory", self.api_open_directory, ["POST"], "打开目录"
        )

        # 实时推送：bridge 仅支持 SSE，替代独立模式下的 WebSocket。
        register(f"{prefix}/events", self.api_events, ["GET"], "实时事件流")

    # ------------------------------------------------------------------
    # API handler（薄包装，业务逻辑全部委托 WebAdminServer 共享方法）
    # ------------------------------------------------------------------

    async def api_auth_info(self):
        # 原生模式下鉴权由 Dashboard 承担，前端无需登录流程。
        return json_response({"native_mode": True, "auth_required": False})

    async def api_status(self):
        return json_response(self._web_admin._build_status_payload())

    async def api_get_config(self):
        return self._reply(await self._web_admin._h_get_config())

    async def api_save_config(self):
        payload = await request.json(default={})
        return self._reply(await self._web_admin._h_update_config(payload))

    async def api_config_schema(self):
        return self._reply(await self._web_admin._h_get_config_schema())

    async def api_session_list(self):
        return self._reply(await self._web_admin._h_list_session_configs())

    async def api_session_get(self, umo: str):
        return self._reply(await self._web_admin._h_get_session_config(umo))

    async def api_session_save(self, umo: str):
        payload = await request.json(default={})
        return self._reply(await self._web_admin._h_update_session_config(umo, payload))

    async def api_session_reset(self, umo: str):
        return self._reply(await self._web_admin._h_reset_session_config(umo))

    async def api_jobs(self):
        return json_response({"jobs": self._web_admin._collect_jobs()})

    async def api_job_reschedule(self, umo: str):
        return self._reply(await self._web_admin._h_reschedule_job(umo))

    async def api_job_trigger(self, umo: str):
        return self._reply(await self._web_admin._h_trigger_job(umo))

    async def api_job_delete(self, umo: str):
        return self._reply(await self._web_admin._h_cancel_job(umo))

    async def api_notifications(self):
        return json_response(await self._web_admin._build_notification_payload())

    async def api_notification_read(self):
        payload = await request.json(default={})
        return self._reply(await self._web_admin._h_mark_notification_read(payload))

    async def api_notification_read_all(self):
        return self._reply(await self._web_admin._h_mark_all_notifications_read())

    async def api_notification_refresh(self):
        return self._reply(await self._web_admin._h_refresh_notifications())

    async def api_markdown_list(self):
        return json_response({"items": self._web_admin._list_markdown_documents()})

    async def api_markdown_file(self, file_path: str):
        return self._reply(await self._web_admin._h_get_markdown_file(file_path))

    async def api_open_directory(self):
        payload = await request.json(default={})
        return self._reply(await self._web_admin._h_open_directory(payload))

    # ------------------------------------------------------------------
    # SSE 实时推送
    # ------------------------------------------------------------------

    async def api_events(self):
        """以 SSE 形式推送与 WebSocket 相同结构的实时更新。"""
        web_admin = self._web_admin
        # maxsize 防止慢客户端导致内存无限增长；广播侧队列满时会直接丢弃该连接。
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        web_admin.register_sse_queue(queue)

        async def stream():
            try:
                # 与 WebSocket 行为一致：连接建立后先推送一次全量快照。
                snapshot = {
                    "type": "full_update",
                    "data": {
                        "status": web_admin._build_status_payload(),
                        "jobs": web_admin._collect_jobs(),
                        "sessions": web_admin._list_known_session_summaries(),
                        "notifications": await web_admin._build_notification_payload(),
                    },
                }
                yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n"

                while True:
                    payload = await queue.get()
                    if payload is None:
                        # 哨兵消息表示插件正在终止，主动结束流。
                        break
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            finally:
                # 无论客户端断开还是插件终止，都必须回收队列引用。
                web_admin.unregister_sse_queue(queue)

        return stream_response(stream())

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def stop(self) -> None:
        """插件终止时通知所有 SSE 客户端结束。"""
        web_admin = getattr(self.plugin, "web_admin_server", None)
        if web_admin:
            web_admin.stop_all_sse()
