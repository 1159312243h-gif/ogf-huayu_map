# 共享数据包

9.0 发布构建 `9.0-shared-data-v1`；实际部署结果以 GitHub Actions 和线上版本核验为准。入口为主菜单“数据”。上传的文件和资料公开共享，普通用户管理自己的包，管理员管理全部。与个人贴图、私人收藏和共享词条分开保存。

## 使用流程

1. 登录，打开“数据 → 上传共享数据包”。
2. 填写名称、类型、实际覆盖范围、统计日期、单位、时段／口径、来源和许可。先在地图选择对象后，可关联原始要素或真实行政边界。
3. 选择 UTF-8 CSV、JSON 或 GeoJSON。可下载该类型的 CSV 表头模板，或自定义列映射。
4. 校验与预览只在本机后台处理。确认公开共享后发布；服务器重新校验，原文件及标准化记录一起事务保存。
5. 大家在目录按类型、名称、范围和来源查询，打开后选择字段生成数值或类别专题图。可收起面板浏览、定位专题范围、隐藏专题图，或导出 SVG、PNG 和数据。

应用不设置文件大小、标准化结果大小、记录数、列数、顶点数、范围资料容量、账号包数量、账号容量、全站容量或发布频率配额。一个数据包可包含城市、省、国家乃至更大范围。实际传输、内存、执行时间及数据库容量仍受托管平台与设备能力约束，不能将取消应用配额称为无限物理容量；失败保留草稿和原有完整数据，不截断或发布半包。

## 格式与定位

CSV 首行为不重复的列名，支持 BOM、引号、引号内逗号及换行。JSON 支持对象数组、`{"records":[...]}`、GeoJSON `Feature` 与 `FeatureCollection`；每条属性支持文字、有限数字、布尔和空值。GeoJSON 保留点、线、面、多部件及孔洞，各面环必须闭合。不读取外部资源，不执行脚本；ZIP、Excel 和其他格式须先转换。

默认列名：

| 用途 | 自动识别 |
| --- | --- |
| 名称 | name、名称、地区、站名 |
| 经度／纬度 | longitude／latitude、lon／lat、lng／lat、经度／纬度 |
| 原始要素身份 | osm_type + osm_id（node、way、relation与正整数编号） |
| 人口 | population、人口、value、值 |
| GDP | gdp、GDP、value、值 |
| 地价 | land_price、地价、value、值 |
| 通行需求 | trips、demand、通行需求、value、值 |
| 车次 | frequency、车次、value、值 |

还可保留到发时间、线路、开行日、起终点和时段等任意标量列，在详情选择原始字段统计或制图。数值不要混写单位或千位逗号；单位和口径填写在资料中，不自动把“万元”和“亿元”等混算。

坐标使用 WGS84 经度、纬度，纬度限 ±85°。其他坐标系应先转换。文件内 `geometry` 优先，其次有效经纬度列。单条汇总记录缺少几何时可使用关联的原始要素几何；多条记录不能自动套用同一行政面。只有名称／编号、没有坐标／几何的记录仍保存，列为未定位，不猜测边界或入口。

## 统计与专题图口径

数值专题按当前字段的分位数设色，点还按绝对值平方根调节大小；同值对应一致配色，分位边界可能重复。主指标沿用数据包单位，其他字段默认不套用主指标单位，可填写本次专题的字段单位而不改动公共资料。类别专题列出最多12类，其余灰色。多边形保留孔洞，线沿上传的原始折线显示，倾斜和俯视对应相同位置。

零是有效数值，空值不当零。服务端统计包含没有位置的有效指标，地图仅画有位置的记录；分别列出缺指标和有指标但缺位置数量。算术和没有扣除父子地区、重复记录或交叠范围，不是正式行政人口、GDP总数或普查结果。当前按一份包计算，不暗中挑选或合并不同作者、年份和口径。

完整下载可选择原件或含来源资料的标准化 JSON；预览表只显示前50条、前10个属性列，其 CSV 也仅含显示部分。专题 SVG、1600×1000 PNG 为独立专题图，保留来源、日期、单位、许可和缺项说明，未附主地图底图。标准化 JSON 和 SVG 可加入现有下载清单。

## 后台读取接口

所有公开读取均 `Cache-Control: no-store`，使用同源路径：

| 接口 | 用途 |
| --- | --- |
| GET /api/datasets?q=关键词&kind=population&limit=20&after=游标 | 公开目录；limit最多50，nextCursor用于继续翻页 |
| GET /api/datasets/编号 | 数据包、作者、来源、范围、单位、日期、摘要及版本 |
| GET /api/datasets/编号/data | 完整标准化记录与资料，供计算任务复用 |
| GET /api/datasets/编号/download | 原件附件；按字节数与 SHA-256 核验 |
| GET /api/datasets/编号/analysis?field=value&mode=numeric | 主指标统计与专题 GeoJSON；field可选原始列，mode也可为category；unit可指定本次专题单位 |
| POST /api/datasets/validate | 已登录用户的服务端校验，不保存 |
| POST /api/datasets | 已登录用户发布完整包 |
| PATCH /api/datasets/编号 | 作者／管理员修改资料；需当前revision |
| DELETE /api/datasets/编号 | 作者／管理员删除；需当前revision |

发布 JSON 包含 `metadata`、`format`、`filename`、`content`、可选 `fields` 和 `shared:true`。`metadata` 为 `title`、`kind`、`description`、`scope:{kind,label,target?,geometry?}`、`source`、`sourceUrl`、`observedDate`（YYYY-MM-DD）、`unit`、`period`、`license`；范围kind为feature、region或large，关联target为`{type,id}`。fields可映射lng、lat、name、value、type、id到原列名。修改资料使用`{revision,metadata}`，修改文件、范围或分类另发新包。

标准化结果含 `schema:"huayu-shared-dataset-v1"`、`records`、`columns`、`primaryColumns`、`numericColumns` 和 `stats`。每条记录为 `{properties,geometry,target,name,value}`；geometry、target及value均可能为空。后台任务应明确选择包编号、版本、单位和统计时间，保留原作者及来源；不能把上传时间当统计日期或OGF抓取时间。

本期实际后台处理为标准化、字段统计和专题图生成。POI、人口、GDP、地价、OD及车次可作为后续任务读取的结构化输入，当前不自动改写既有交通模拟、真实运行时刻表、OGF、导航或三小时快照。公开共享也不自动验证统计真实性。

## 维护与验收

新增幂等迁移 `0004_shared_datasets.sql` 使用既有 D1，原件与标准化记录采用512 KiB分块，整批事务保存，账号删除级联清理。无需新R2或付费订阅。独立Pages Worker继续无导入部署，解析工厂由 `node scripts/sync-shared-dataset-core.mjs` 同步；`--check`只检查一致性，回归也核对工厂内容。

运行 `npm run test:shared-datasets`、`npm run verify`。测试覆盖解析、几何孔洞、零值与缺项、超过旧文件／条数／列数／顶点门槛的完整输入、字段映射、权限、源文件字节、分页、并发版本、分块失败回滚、取消账号／全站配额和账号删除。发布前仍运行仓库要求的更新器与数据检查；本地验收不代表已提交或已部署。
