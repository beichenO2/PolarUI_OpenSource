# 网站模版 · 开源参考与引用

> **当前决策**：以 [LibreChat](https://github.com/danny-avila/LibreChat) 为 UI 套壳基底（MIT）。

---

## 主基底：LibreChat

| 项 | 链接 |
|----|------|
| 仓库 | https://github.com/danny-avila/LibreChat |
| 官网 | https://librechat.ai |
| 文档 | https://librechat.ai/docs |
| License | MIT |

### 采用理由

- ChatGPT 风格成熟（40k+ stars）
- 内置多用户 + Admin Panel
- 文件上传 / 多模态基础能力
- 自托管 Docker Compose 成熟

### 改造项（POLAR 层）

- 侧栏：LibreChat 单栏会话列表 → **情景 + 会话** 双层（admin 加用户 L0）
- 后端：OpenAI 直连 → **PolarUI workflow 代理**
- 记忆：LibreChat presets → **三层记忆 SSoT + 分层查看页**
- 部署：全局实例 → **每发行版独立文件夹**

### README 引用声明（必含）

见 [`WEB_TEMPLATE.md`](./WEB_TEMPLATE.md) §3.1。

---

## 辅助参考（不套壳）

| 项目 | 链接 | 借鉴点 |
|------|------|--------|
| OpenGPT | https://github.com/RaheesAhmed/OpenGPT | 侧栏折叠；[Demo](https://opengpt-beta.vercel.app) |
| LobeChat | https://github.com/lobehub/lobe-chat | 预览：https://chat-preview.lobehub.com |
| Mem0 | https://github.com/mem0ai/mem0 | 记忆抽取 prompt 结构 |

---

## 本地预览 LibreChat

```bash
git clone https://github.com/danny-avila/LibreChat.git
cd LibreChat && cp .env.example .env
docker compose up -d
# → http://localhost:3080
```

PolarUI 模版不从零写 UI，而是在 `~/Desktop/Web_related/_template/` 维护 LibreChat fork + `polar/` 改造目录。
