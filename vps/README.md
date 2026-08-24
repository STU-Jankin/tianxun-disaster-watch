# 天巡 VPS 后台与 Hermes 飞书通知

默认部署只在 VPS 本机运行灾害采集引擎和通知队列；如需 Web 控制台，再按本文“公网登录控制台”章节配置 Nginx、HTTPS 与登录账号。引擎始终监听
`127.0.0.1:3000`，Hermes Webhook 监听 `127.0.0.1:8644`，不得直接把这两个端口暴露到公网。

运行链路：

```text
全球灾害数据源 → 独立两分钟采集器 → 天巡聚合/生命周期判定 → SQLite 变更与去重队列
             → HMAC 本机 Webhook → Hermes deliver_only → 飞书
```

## 1. VPS 前置条件

- Ubuntu 22.04 x86_64
- Node.js 22.13 或更高版本、npm、`sqlite3`、`curl`、`openssl`
- 已安装 Hermes；飞书连接建议使用 WebSocket 模式，因此不需要公网回调端口
- 以普通用户完成 `hermes gateway setup`，在飞书对话中执行 `/set-home`

飞书/Hermes 至少需要配置：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu
FEISHU_CONNECTION_MODE=websocket
FEISHU_ALLOWED_USERS=ou_xxx
FEISHU_HOME_CHANNEL=oc_xxx
```

同时在 `~/.hermes/config.yaml` 中显式限制 Webhook 只监听回环地址（省略 `host` 会监听更多地址）：

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      host: 127.0.0.1
      port: 8644
      secret: "另行生成的全局随机密钥"
```

生产环境务必填写 `FEISHU_ALLOWED_USERS`，且不要把 `.env` 或应用密钥上传到项目目录。

## 2. 上传与安装

把整个项目上传到 VPS 的临时目录，例如 `/tmp/tianxun-release`，然后执行：

```bash
cd /tmp/tianxun-release
sudo apt-get update
sudo apt-get install -y sqlite3 curl openssl
sudo bash vps/scripts/install.sh
```

安装脚本会：

- 创建相互隔离、不可登录的 `tianxun-engine` 与 `tianxun-notifier` 系统用户；
- 将带时间戳的发行版安装到 `/opt/tianxun/releases/`；
- 构建生产包，原子切换 `/opt/tianxun/current`；
- 创建 `/etc/tianxun/*.env`，权限为 `0640 root:tianxun`；
- 启用后台引擎、独立两分钟采集定时器；通知定时器需在飞书验收后手工启用；
- 启用每日一次的 CelesTrak TLE 刷新定时器，失败时保留上次有效轨道；
- 不修改 UFW，不开放 3000/8644 端口。

安装器会生成 64 位十六进制 API 令牌，并同步写入引擎和通知器的受限环境文件，不会把令牌打印到终端。已有强令牌会保留，示例占位值不会被当作有效凭据。

## 3. 填写数据源和通知策略

```bash
sudoedit /etc/tianxun/engine.env
sudoedit /etc/tianxun/notifier.env
sudo systemctl restart tianxun-engine
```

把已申请的 FIRMS key 放入 `engine.env`。`notifier.env` 默认阈值为 65；红色/橙色事件即使分数略低也会进入通知。

首次成功采集只建立基线并发送一条汇总，不会把现有数百条事件逐条轰炸飞书。之后仅推送：

- 达阈值的新主事件；
- 严重等级升级或优先级越过阈值；
- 独立证据增加、定位质量改善、AOI 达到可规划条件；
- 台风中心移动超过 150 km；
- 连续三次采集失败的数据源及恢复通知。
- 权威撤销、事件身份隔离以及由此自动取消的卫星任务。

同一台风的日常报文只更新主事件，不重复推送；只有重要变化才通知。

## 4. 创建 Hermes 直投飞书路由

先确认飞书和 Webhook 均已通过 `hermes gateway setup` 配好，并安装开机服务：

```bash
sudo -E hermes gateway install --system
curl http://127.0.0.1:8644/health
```

然后以运行 Hermes 的用户创建路由：

```bash
bash /opt/tianxun/current/vps/scripts/configure-hermes.sh
```

脚本会生成强随机 HMAC 密钥并创建 `tianxun-alerts` 路由。把输出的
`HERMES_WEBHOOK_SECRET=...` 写入 `/etc/tianxun/notifier.env`。该路由使用
`deliver_only`：不唤醒模型、不消耗 token，直接向飞书 home channel 投递。
通知器默认使用 `HERMES_SIGNATURE_VERSION=auto`：优先发送 Generic V2
`X-Webhook-Signature-V2 = HMAC-SHA256(timestamp.body)`；如果已安装的旧版 Hermes
明确返回 `401 Invalid signature`，则仅对该请求兼容回退到 Generic V1
`X-Webhook-Signature = HMAC-SHA256(body)`。升级 Hermes 后可固定为 `v2`；兼容期间
仍发送稳定的 `X-Request-ID`，避免批次重复投递。

如果 Hermes 已使用用户级服务，应让 `tianxun-notifier.service` 的 `After=` 与实际
服务名保持一致；即使没有该依赖，通知器也会把失败投递留在 SQLite 中指数退避重试。

## 5. 验收

```bash
sudo systemctl start tianxun-notifier.service
sudo bash /opt/tianxun/current/vps/scripts/healthcheck.sh
sudo journalctl -u tianxun-engine -u tianxun-notifier --since '15 minutes ago' --no-pager
sudo systemctl list-timers tianxun-notifier.timer
sudo systemctl list-timers tianxun-ingest.timer
sudo systemctl list-timers tianxun-orbit-refresh.timer
sudo systemctl list-timers tianxun-backup.timer
```

第一次应在飞书收到“天巡灾害后台已建立运行基线”。再次立即执行通知服务，不应重复收到同一消息。

SQLite 检查：

```bash
sudo sqlite3 /var/lib/tianxun/notifier/notifier.sqlite \
  "select status, count(*) from notification_queue group by status;"
```

## 6. 备份与恢复

```bash
sudo bash /opt/tianxun/current/vps/scripts/backup.sh
```

默认备份到 `/var/backups/tianxun`，保留 14 天，并为每个备份生成 SHA-256。使用受控恢复脚本；它会验证路径、校验和与 SQLite 完整性，并停止相关写入服务：

```bash
sudo bash /opt/tianxun/current/vps/scripts/restore.sh operational /var/backups/tianxun/operational-YYYYMMDDTHHMMSSZ.sqlite
sudo bash /opt/tianxun/current/vps/scripts/restore.sh notifier /var/backups/tianxun/notifier-YYYYMMDDTHHMMSSZ.sqlite
```

## 资源预算（2 GB RAM VPS）

- 灾害引擎：高水位 650 MB，上限 850 MB；
- 通知器：五分钟运行一次，上限 180 MB；
- Hermes：使用 WebSocket + `deliver_only`，没有模型推理常驻开销；
- 建议保留现有 1 GB swap，并至少留出 8 GB 可用磁盘。

启用 Web 控制台时只允许通过 HTTPS Nginx 网关访问；不得直接开放 3000 端口。后台采集与 Hermes 继续走回环地址和独立服务凭据。

## 安全换钥

任何曾出现在聊天、截图、Shell 历史或工单里的 VPS 密码、FIRMS key、飞书密钥和 Webhook 密钥都应视为已经泄露并立即轮换。VPS 应改用 SSH key，禁用 root 密码登录；应用密钥只保存在 `/etc/tianxun/*.env`，不要写入仓库或 URL。轮换 `TIANXUN_API_TOKEN` 时必须同时更新 `engine.env` 与 `notifier.env` 后重启两个服务。

## 公网登录控制台

历史文件名 `vps/nginx/tianxun-public-readonly.conf` 为兼容既有部署保留，但配置已经改为登录保护模式，不再向匿名访问者注入代理角色。除 `/api/health/live` 和登录接口外，所有浏览器 API 都由应用逐请求校验服务端会话；后台采集器和通知器仍可使用各自的 Bearer Token，不受网页登录影响。

会话 Cookie 为 `HttpOnly + SameSite=Strict`，生产环境使用 `Secure` 和 `__Host-` 前缀。服务器只在 SQLite 保存随机会话令牌的 SHA-256 摘要；默认闲置 30 分钟失效、最长 8 小时，每个账号最多保留 5 个会话。退出会删除服务端会话并要求浏览器清除缓存和站点存储；修改用户名、角色或密码哈希后旧会话自动失效，恢复数据库备份时也会清空历史会话，防止撤销过的会话复活。

首次安装或需要轮换密码时执行：

```bash
sudo bash /opt/tianxun/current/vps/scripts/configure-login.sh
```

该脚本使用无回显输入，保存 `PBKDF2-HMAC-SHA256` 600,000 次迭代的加盐哈希，不保存明文密码。登录失败同时受到 Nginx（每 IP）和应用层频率限制。

生产模式会拒绝通过明文 HTTP 建立会话。上线前必须准备域名，在 Nginx 上配置有效 TLS 证书，并把 80 端口永久重定向到 HTTPS；完成后确认上游仍设置 `Host` 和 `X-Forwarded-Proto $scheme`。不要通过修改代码或伪造 `X-Forwarded-Proto` 来绕过 HTTPS 要求。

`/api/satellites`、灾情、任务、路线和道路核验数据都不再匿名公开。CelesTrak 轨道仍由服务器定时刷新；51832、56846、61231、64048、69100 的业务名称来自项目配置，58918 的“东方慧眼”身份保持待核验。
