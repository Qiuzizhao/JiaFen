# 课堂小组积分系统

一个用于课堂上记录小组加减分的小应用。支持班级管理、小组管理、一键加减分、实时排行榜、记分历史、撤销，以及多设备实时同步（任一设备加了分，其他设备自动更新）。

## 技术栈

- 后端：Python + Flask，SQLite 存储
- 前端：原生 HTML / CSS / JS 单页应用
- 实时：Server-Sent Events（SSE）
- 部署：Docker Compose + Cloudflare Tunnel（无需 Caddy/证书）

## 功能

- 班级管理（增删改）
- 小组管理（增删改、颜色），小组固定顺序展示，支持长按拖拽手柄调整顺序
- 一键加减分：`+1 +2 +5 -1 -2 -5`，也可自定义分值
- 撤销上一条误操作
- 实时排行榜（含投屏模式，大字投给全班）
- 记分历史记录
- 数据导出 / 导入（学期备份）
- 单个管理员密码登录

## 本地运行（不需要 Docker）

```bash
pip install -r requirements.txt
python application/app.py
```

然后浏览器打开 `http://localhost:5000`，默认密码 `jiafen123`（建议用环境变量修改）。

可以设置登录密码：

```bash
set ADMIN_PASSWORD=你的密码
set SECRET_KEY=一长串随机字符
python application/app.py
```

数据保存在 `application/data/jiafen.db`，删除该文件即清空数据。

## 部署到云服务器（Cloudflare Tunnel）

前提：你有一台云服务器 + 一个在 Cloudflare 管理的域名。

### 第 1 步：服务器装 Docker

Ubuntu / Debian：

```bash
curl -fsSL https://get.docker.com | sh
```

### 第 2 步：上传项目

把本项目上传到服务器（如 `/srv/jiafen`），可以用 `git clone` 或 `scp`。

### 第 3 步：配置 Cloudflare Tunnel

1. 登录 Cloudflare 后台 → **Networks** → **Tunnels** → **Create a tunnel**
2. 选 Cloudflare Tunnel，起个名字，创建
3. 记录下生成的 Token（`TUNNEL_TOKEN`）
4. 添加 **Public Hostname**：
   - 域名：`你的域名`（如 `jiafen.example.com`）
   - 服务：`HTTP` → `app:5000`
5. **保存**，这样 Cloudflare 就会把这个域名路由到服务器的 `app` 容器

> 使用 Tunnel 后，服务器**不需要**开放 80/443 端口，也不用做 DNS A 记录。

### 第 4 步：填配置并启动

```bash
cp .env.example .env
```

编辑 `.env`，填入：

- `ADMIN_PASSWORD`：你的登录密码
- `SECRET_KEY`：一长串随机字符（可用 `openssl rand -hex 32` 生成）
- `TUNNEL_TOKEN`：上一步拿到的 Cloudflare Tunnel Token

然后启动：

```bash
docker compose up -d
```

看到两个容器运行（`jiafen` 和 `jiafen-tunnel`）就成功了。

### 第 5 步：访问

浏览器打开 `https://你的域名`，用 `.env` 里设置的管理密码登录即可。

## 常用命令

```bash
# 查看状态
docker compose ps
# 查看日志
docker compose logs -f app
# 停止
docker compose down
# 更新后重新构建并启动
docker compose up -d --build
```

## 数据备份

- 界面上「导出备份」可下载 JSON 文件。
- 也可直接拷贝服务器上的 `application/data/jiafen.db` 文件。

## 注意事项

- 实时同步依赖 Server-Sent Events，因此请保持应用为**单进程**运行（默认即是）。
- 登录密码只用于保护你自己的数据，不要用简单弱密码。
- 多设备需登录同一个站点（同一个域名），即可共享同一份数据。
