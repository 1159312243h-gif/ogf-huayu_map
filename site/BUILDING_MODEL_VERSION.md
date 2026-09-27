# 华域建筑模型 v9

状态：本地实验，未上传 Cloudflare  
日期：2026-09-27

## 数据流

```text
地图可见范围
  -> 匹配视图层级的 z11-z14 建筑数据网格
  -> /api/buildings/{z}/{x}/{y}.json
  -> Cloudflare Pages Worker 两分钟边缘缓存
  -> 当前 OGF Overpass building way / relation
  -> 客户端按 OGF 对象 ID 合并
  -> 华域 GeoJSON fill-extrusion
```

- 外层地图 `z11+` 显示建筑；对应 MapLibre 内部 `z10+`，即当前界面约 `5 km` 比例尺。
- 建筑分片随视图逐级使用 `z11-z14`；远景使用大分片控制请求数量，近景继续使用 `z14` 精细分片。
- 客户端最多同时读取 3 个分片，内存保留最近 72 个分片。
- 平移只补充新分片，远距离跳转会取消已离开视野的未完成请求；缩小仅暂停新请求，不清空已有分片缓存。
- 高度优先使用 `height` / `min_height`，其次使用建筑层数，最后回退 3.2 米。
- 华域标准和华域深夜禁用 Vector 建筑层；官方 Vector 完全不启用本模块。

## 能力边界

v4 提供全域按需覆盖：地图移动到 OGF 中任意区域时，都能用同一分片规则读取建筑。它没有预生成全国建筑。首次访问一个从未缓存的分片仍取决于 Overpass 响应速度；访问过的分片可直接命中边缘缓存。

若要求全国任意地点首次打开即稳定秒出，应每日从完整 OGF 数据生成 MVT/PMTiles，并保留当前接口作为短期实时补充或失败回退。

## 本地验证

- 新沪 `z14`：16/16 分片，142 个去重建筑。
- 津川 `z14`：16/16 分片，2,796 个去重建筑。
- 津川近景：单分片 1,553 个建筑，透视显示正常。
- 华域标准、华域深夜均加载同源分片。
- 切换官方 Vector 后，华域建筑数据状态全部移除。
- 浏览器未出现建筑模块脚本错误；现有缺失 Sprite 警告与本次修改无关。

## 空中花园屋面覆盖 v5

- 仅处理带 `height` 的花园、公园、草坪、花坛等架空绿化面；地面花园保持原样。
- 保留 OGF 的标签高度为 `taggedHeight`，实际顶面增加 `0.25 m` 的稳定屋面间隔，避免与建筑屋顶共面闪烁。
- 架空绿化面改为完全不透明，并固定排列在华域实时建筑之后、城墙和注记之前。
- 津川“空中花园”实例验证：标签高度 `30 m`，渲染顶面 `30.25 m`，底面 `29.9 m`；标准与深夜透视视角均完整显示。
- 建筑分片回归保持 3 路并发、Vector 隔离和原有模型 v4 元数据，页面错误日志为空。

本补丁修改前的完整基线包为：

`work/ogf-atlas-package-v4.0.1-huayu-elevated-green-v5-baseline-full`

完成包为：

`work/ogf-atlas-package-v4.0.1-huayu-elevated-green-v5-full`

## 建筑内核保留 v6

- 建筑关系的 `outer` 成员继续由上级 multipolygon 统一建模，避免同一外墙重复挤出。
- 自身带 `building=*` 且仅作为 `inner` 的 way 保留为独立建筑；无建筑标签的 `inner` 仍作为真实庭院或中庭空洞。
- 澜海集团总部实例恢复 `way 43271497` 的 119 米核心塔楼，同时保留关系 `572732` 至 `572737` 的六层退台及各自内环。
- 同角度与官方 Vector 对照后，错误贯穿空洞消失；空中花园、周边建筑与原有昼夜样式保持不变。

本补丁修改前的完整基线包为：

`work/ogf-atlas-package-v4.0.1-huayu-building-model-v6-baseline-full`

完成包为：

`work/ogf-atlas-package-v4.0.1-huayu-building-model-v6-full`

## 复合多边形与组合建筑 v7

- 标准 multipolygon 继续按关系拼接外环和内环；开放的分段外环仍可正确合并。
- 对“无内环，且所有外成员都是自身带建筑标签的闭合 way”的组合关系，不再把关系整体挤出为默认高度，而是按各成员的 `height`、`min_height` 和层数独立建模。
- 津川银行总行与津州农商银行总行恢复为 5 个独立体量，验证高度分别为 `50 / 120 / 160 / 50 / 123 m`；关系本身只作为组合与名称来源，不重复生成三维体。
- 实时 Worker 与直连回退查询同时加入 `building:part=*` 的 way 和 relation；客户端接受建筑部件并保留其独立高度与架空基准。
- Worker 缓存模式提升为 `huayu-building-v2`，避免旧分片缓存掩盖新增建筑部件。
- v6 的 119 米 inner 核心塔楼、六层退台内环和 v5 空中花园均通过回归。

本补丁修改前的完整基线包为：

`work/ogf-atlas-package-v4.0.1-huayu-building-model-v7-baseline-full`

完成包为：

`work/ogf-atlas-package-v4.0.1-huayu-building-model-v7-full`

## 空中花园俯视覆盖 v8

- 架空绿化图层不再随视角俯仰隐藏，在完全俯视与透视视角下均保持可见。
- 图层继续排列在华域实时建筑之后、城墙和注记之前；津川实例仍使用标签高度 `30 m`、渲染顶面 `30.25 m`、底面 `29.9 m` 和完全不透明填充。
- 地面花园、建筑几何、桥梁、导航、交通、搜索和官方 Vector 均未修改。

本补丁修改前的完整基线包为：

`work/ogf-atlas-package-v4.0.1-huayu-elevated-green-v8-baseline-full`

完成包为：

`work/ogf-atlas-package-v4.0.1-huayu-elevated-green-v8-full`

## 5 公里比例尺建筑模型 v9

- 建筑显示门槛由外层地图 `z14` 提前到 `z11`，在当前界面标尺显示约 `5 km` 时开始绘制。
- 数据分片按视图层级从 `z11` 逐级切换到 `z14`，避免远景继续枚举数百个 `z14` 小分片；近景精度与实时 OGF 数据源不变。
- Worker 接受 `z11-z14` 建筑分片并使用 `huayu-building-v3` 缓存模式；客户端仍限制为三路并发和 72 个分片缓存。
- 复合多边形、组合建筑高度、空中花园、桥梁、导航、交通、搜索和官方 Vector 均未修改。

本补丁修改前的完整基线包为：

`work/ogf-atlas-package-v4.0.1-huayu-building-model-v9-baseline-full`

完成包为：

`work/ogf-atlas-package-v4.0.1-huayu-building-model-v9-full`

## 修改边界与回退

桥梁、导航、交通、搜索及其数据文件未修改。建筑模型 v4 修改前的完整包为：

`work/ogf-atlas-package-v4.0.1-huayu-building-model-v4-baseline-full`

可使用 `work/restore-ogf-atlas-version.ps1 -VersionDirectory work/ogf-atlas-package-v4.0.1-huayu-building-model-v4-baseline-full` 回退。
