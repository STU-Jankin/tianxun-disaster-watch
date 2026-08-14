# 天巡 · 全球自然灾害预警

面向自有卫星任务规划的全球自然灾害事件发现 MVP。系统聚合公开权威事件源，仅保留具备遥感观测价值的灾种，并按照无锡市、江苏省、中国、全球四级重点范围生成观测优先级。

本系统定位为“事件发现、证据聚合与人工复核后的任务候选生成”，不是无人值守的自动告警下发系统。FIRMS 热异常、GloFAS 洪水预测及代表性区域坐标会明确降级标注；只有来源几何可靠或经操作员确认的 AOI 才能进入仿真与导出流程。

## 当前能力

- 接入 USGS 地震、NASA EONET、GDACS、NOAA NHC、USGS HANS、Smithsonian GVP 与 NASA LHASA。
- 第一优先级的 NASA FIRMS、WMO SWIC/CAP、Copernicus GloFAS，以及第二优先级的 OCHA ReliefWeb 已有独立连接器；需要密钥或订阅地址的源会明确显示“待配置”，配置字段见 `.env.example`。
- 统一地震、火灾、洪水、气旋、火山、滑坡、干旱等事件模型。
- 将不同来源的同一物理事件按灾种时空阈值合并为主事件，并保留来源证据链、可信度和事件生命周期。
- 对有编号或名称的持续过程建立灾害实体键：同一台风、编号洪水、火山活动和季度干旱只显示一个主事件；同源连续通报作为“更新历史”，不同来源才计为独立证据。
- 标注精确点位、估算点位、区域代表点和未知位置；非精确坐标必须由操作员核对 AOI 后才能进入任务候选单。
- 标记直接可观测、灾后可观测和条件可观测事件。
- 自动生成观测目标和任务优先级；综合分由严重度、重点范围、遥感适用性和最高30分的时效权重构成。
- 支持“综合优先”和“最新发生”两种排序，时效得分采用7天半衰期，避免近期事件被旧事件长期压后。
- 按灾种划分黄金观测期、后续观测期和历史库；黄金期结束后进入复核阶段，不再直接撤销。
- 短时数据源不再报告某事件时，系统会从 D1 延续该主事件并标为“来源暂未复现”，直至观测期届满或权威撤销，避免把 Feed 滚动窗口误当成灾害结束。
- 支持全球地图、灾种筛选、地区搜索与四级重点范围。
- 事件详情按需反向解析中文地点，同时保留权威来源原文用于核对。
- 可将事件加入独立卫星任务侧栏；站点部署使用 Cloudflare D1，VPS 后台使用 SQLite，本机缓存仅作离线回退；候选项直接显示灾害发生时间，可编辑成像时间窗，并从完整载荷清单中多选。
- AOI支持点目标、圆形面、矩形面与线状走廊；GeoJSON按类型导出对应几何。
- 可向卫星仿真系统导出带WGS84精确坐标的 JSON、CSV 和 GeoJSON 任务包。
- 提供 `/api/visibility` 正式仿真适配接口；配置 `SATELLITE_VISIBILITY_API_URL` 后转发标准化任务和 AOI，未配置时明确返回“待配置”而不生成虚假窗口。
- 数据源异常时独立降级，并在全部源不可用时显示演示数据。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

访问 `http://localhost:3000`。

运行前将 `.env.example` 复制为 `.env.local`，填入获批的数据源和仿真服务配置。数据库使用 `.openai/hosting.json` 中的 `DB` 绑定；本地开发会自动初始化与 `drizzle/0000_operational_core.sql` 一致的表结构。

## 验证

```bash
npm run build
npm test
```

重点范围当前使用快速矩形边界进行第一阶段筛选。生产环境应替换成正式行政区矢量并加入跨界事件缓冲区。

## VPS 后台与飞书通知

`vps/scripts/install.sh` 只把采集引擎、SQLite 状态库和 Hermes 通知器部署到回环地址，不开放网页端口。安装后先在 `/etc/tianxun/engine.env` 与 `/etc/tianxun/notifier.env` 写入同一个随机 `TIANXUN_API_TOKEN`，配置 Hermes 与飞书，再手工运行一次 `systemctl start tianxun-notifier.service`。验证成功后才启用五分钟定时器：

```bash
systemctl enable --now tianxun-notifier.timer
```

安装器会同时启用每日 SQLite 在线备份，默认保留 14 天，位置为 `/var/backups/tianxun`；主机需预装 `sqlite3` 与 `curl`。`vps/scripts/healthcheck.sh` 用于核对引擎、Hermes 与通知定时器状态。
