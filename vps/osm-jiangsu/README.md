# 江苏 OSM 本地索引试点

该试点用于替代江苏范围内暴露度计算对公共 Overpass 的逐块扫描。它不是完整 Overpass，也不接受任意 Overpass QL；只提供天巡当前需要的建筑、道路和关键设施筛查接口。

## 统计口径

- 数据：Geofabrik 江苏日更 GeoPackage，WGS 84，ODbL 1.0。
- 建筑与道路：按要素包围盒中心落入约 `0.01°`（江苏约 1 km）网格预汇总。同一要素只进入一个网格，适合快速暴露度筛查，但不是 AOI 边界逐要素精确求交。
- 关键设施：医疗、消防/公安、避难、教育、供排水和数据中可识别的电力设施；保留可定位代表点，最多向地图返回 300 个。
- 覆盖：只有 AOI 完整落在 Geofabrik `jiangsu.poly` 内才使用本地结果；跨出覆盖边界会自动回退现有全球 OSM 流程，不能把覆盖外缺失解释为零。
- 更新：每天检查 Geofabrik 数据时点；更新失败保留上一版索引，页面显示最后成功的数据时点而不是查询时间。

## VPS 安装

先正常部署天巡工程，再执行：

```bash
sudo bash /opt/tianxun/current/vps/scripts/install-osm-jiangsu.sh
```

脚本会下载约 167 MB 的江苏 GeoPackage，临时解压、构建较小的只读 SQLite 索引，随后删除原始临时文件。访问令牌随机生成并写入受限环境文件，不会打印到终端。

服务：

- 本机健康检查：`http://127.0.0.1:8791/health`
- 本机查询：`http://127.0.0.1:8791/v1/exposure`
- HTTPS 反向代理：`/osm-jiangsu/v1/exposure`（仍要求 Bearer 令牌）
- 每日更新：`tianxun-osm-jiangsu-refresh.timer`

## 验证

```bash
systemctl status tianxun-osm-jiangsu.service --no-pager
systemctl list-timers tianxun-osm-jiangsu-refresh.timer --no-pager
curl --fail http://127.0.0.1:8791/health
```

在天巡中选择无锡或江苏境内事件并重新计算暴露度，页面应显示“江苏本地日更索引（非实时）”，且不再出现 OSM 分块续算按钮。中国其他省份和全球事件继续沿用原有公共 Overpass 限流与缓存规则。
