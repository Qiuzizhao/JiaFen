# 课堂小组积分系统

一个用于课堂上记录小组加减分的小应用。支持班级管理、小组管理、一键加减分、实时排行榜、记分历史、撤销，以及多设备实时同步（任一设备加了分，其他设备自动更新）。

## 技术栈

- 后端：Python + Flask，SQLite 存储
- 前端：原生 HTML / CSS / JS 单页应用
- 实时：Server-Sent Events（SSE）
- 部署：Docker Compose + nginx 反向代理 + Cloudflare（Flexible SSL，无需自备证书）

## 功能

- 班级管理（增删改）
- 小组管理（增删改、颜色），小组固定顺序展示，支持长按拖拽手柄调整顺序
- 一键加减分：`+1 +2 +5 -1 -2 -5`，也可自定义分值
- 全班加减分：给本班每个小组同时加/减同一个分值（记分板顶部「全班」一行，同样支持 `+1 +2 +5 -1 -2 -5` 和自定义分值；记分记录合并为一条「全班 · N组」，撤销时整批回退）
- 撤销上一条误操作（若上一条是全班加减分，则整批一起撤销）
- 即时反馈：点击加减分后本地立刻更新分数，再后台提交，不等待网络往返
- 增量实时同步：其他设备的改动通过 SSE 直接推送变更内容，前端只更新变化的小组，不整页重新拉取
- 实时排行榜（含投屏模式，大字投给全班）
- 记分历史记录
- 数据导出 / 导入（学期备份）
- 单个管理员密码登录
- 移动端适配：响应式布局、触控优化、输入框防页面缩放、投屏可滚动
- 移动端「班级」弹窗：点击顶栏按钮弹出班级管理窗口，桌面端仍是侧栏

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

## 移动端体验

手机浏览器（建议横屏或竖屏均可）会自动切换为移动端布局：

- **顶部操作栏**：只显示「班级 / 投屏模式 / 退出」，隐藏「导出备份 / 导入备份」（数据备份请在桌面端操作）。
- **班级管理**：点击顶栏「班级」按钮，从顶部弹出班级管理窗口（新建班级、切换班级、改名/删除），点遮罩或 ✕ 关闭；桌面端仍是左侧边栏。
- **切换班级**：记分板上方有下拉框，可直接切换班级，无需打开弹窗。
- **输入防缩放**：移动端所有输入框字号 ≥ 16px，聚焦输入时不会触发 iOS 整页放大。
- **触控优化**：按钮、拖拽手柄、快速加减分都加大触控目标，去掉了点按延迟。
- **全班加减分**：记分板上方「全班」一行在手机上自动换行（六个快捷分值一排、自定义分值一行），不会横向溢出。
- **投屏模式**：手机上可上下滚动查看全部小组，卡片自动改双列布局。

## 部署到云服务器（nginx 反向代理 + Cloudflare）

前提：一台有公网 IP 的云服务器 + 一个在 Cloudflare 管理的域名，且服务器上已有 nginx（默认监听 80 端口）。

### 第 1 步：服务器装 Docker

Ubuntu / Debian：

```bash
curl -fsSL https://get.docker.com | sh
```

### 第 2 步：上传项目 + 配置

把本项目上传到服务器（如 `/srv/jiafen`），然后：

```bash
cp .env.example .env
```

编辑 `.env`，填好：

- `ADMIN_PASSWORD`：你的登录密码
- `SECRET_KEY`：一长串随机字符（可用 `openssl rand -hex 32` 生成）

### 第 3 步：启动应用

```bash
cd /srv/jiafen && docker compose up -d --build
```

应用会映射到服务器的 `127.0.0.1:5002`（只本机可访问，供 nginx 反代）。

### 第 4 步：配置 nginx 反代

在 `/etc/nginx/sites-enabled/jiafen` 写入下面内容（把 `jiafen.example.com` 换成你的域名）：

```nginx
server {
    listen 80;
    server_name jiafen.example.com;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:5002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_connect_timeout 15s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> `proxy_buffering off` 很关键：否则 Server-Sent Events 实时推送会被缓冲。

### 第 5 步：Cloudflare DNS

在 Cloudflare 里把子域名加一条 **A 记录**指向服务器公网 IP，并打开**代理（橙色云朵）**；SSL 模式设成 **Flexible**（Cloudflare 在边缘做 HTTPS，回源走 HTTP 到服务器 80）。

浏览器打开 `https://你的域名` 即可。

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
- 每个打开的页面/设备会占用 1 条 SSE 长连接，服务端线程池为 64（`application/app.py` 中 `threads=64`），因此大约支持 60 个页面同时在线；如果以后设备更多，调大这个数值即可。
- 前端采用「先本地生效、再后台提交」的乐观更新：点击即时响应，提交失败会回滚并提示；切回页面或窗口重新聚焦时若超过 20 秒没同步，会自动对账一次。
- 登录密码只用于保护你自己的数据，不要用简单弱密码。
- 多设备需登录同一个站点（同一个域名），即可共享同一份数据。
- 前端资源和首页已禁用缓存（`no-cache, no-store`），并带资源版本号；手机/浏览器如仍显示旧界面，可强制刷新（Ctrl+F5）。
- 导出/导入备份按钮只在桌面端显示，移动端请在桌面端或电脑浏览器操作。
