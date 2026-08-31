# 中国 OSM 日更镜像接入

天巡应用支持两种 Overpass 运行档位：

- `public`：默认公共服务，单次筛查上限固定为 2,500 km²。
- `china_daily`：面向独立部署的中国 OSM 数据库，默认单次筛查上限为 50,000 km²，页面明确标记“日更、非实时”。

## 部署边界

不要把中国 Overpass 数据库部署在当前 2 GB / 40 GB 的应用 VPS。应使用单独的数据服务器，并由反向代理提供 `/api/interpreter`。应用 VPS 只保存经过裁剪的查询结果缓存，不保存全国 PBF 或 Overpass 主数据库。

中国初始快照和每日差分可使用 Geofabrik：

- https://download.geofabrik.de/asia/china.html
- https://download.geofabrik.de/technical.html

每天更新数据服务器后，应先完成健康查询，再原子切换到新数据库；更新失败时继续保留上一版，不允许用失败时间覆盖最后成功的数据时点。Overpass 响应中的 `osm3s.timestamp_osm_base` 会进入天巡结果，供页面显示真实数据基准时间。

## 应用侧配置

数据服务可用后，在应用运行环境中设置：

```dotenv
OVERPASS_PROFILE=china_daily
OVERPASS_API_URL=https://osm-china.example.com/api/interpreter
OVERPASS_MAX_AREA_KM2=50000
OVERPASS_CACHE_TTL_HOURS=26
OVERPASS_STALE_IF_ERROR_HOURS=168
OVERPASS_QUERY_TIMEOUT_SECONDS=45
```

若数据服务只通过受控内网或同机回环地址访问，才允许同时设置：

```dotenv
OVERPASS_ALLOW_PRIVATE_ENDPOINT=true
```

启用后需要验证：

1. 页面显示“中国日更镜像（非实时）”。
2. OSM 数据时点对应镜像最近一次成功更新，而不是本次查询时间。
3. 同一 AOI 再次查询显示“本地缓存命中”。
4. 暂停数据服务后，短期内显示“过期缓存降级”，且不会把缓存结果解释为实时道路状态。
5. 2,500 km² 以上 AOI 仅在 `china_daily` 档位下放行，仍不得执行全国建筑和道路一次性全量普查。
