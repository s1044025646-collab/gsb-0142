# 室内声学脉冲响应与混响评估后端

Windows 本地可运行的**全频带**室内声学分析后端。TypeScript + Node.js +
内置 SQLite（`node:sqlite`，无需原生编译）。仅提供 REST API、CLI、
合成脉冲响应生成器与自动化测试；**不包含**网页界面、音频剪辑，也不连接
真实测量设备。

输入为单通道采样数组（JSON `number[]`）及采样率；管理测点别名、原始响应、
直达声起点、噪声窗口、积分终点、分析参数版本与冻结报告。

## 依赖

- Node.js `>= 22.5`（开发与验证使用 Node `v25.5.0`，用到内置
  `node:sqlite` 与 type-stripping）。
- 仅开发依赖：`typescript`、`@types/node`（见 `package.json`，`npm install` 安装）。
- 运行时无第三方数据库/HTTP 框架依赖。

## 安装

```powershell
npm install
npm run build
```

## 运行测试

```powershell
npm test
```

测试先把 `src/` 与 `test/` 编译到 `dist-test/`，再用 Node 内置测试运行器执行。
覆盖：解析指数衰减、前置静音、双阶段衰减、单脉冲、尾部噪声、过短记录、
全零；理论衰减率与手算能量核验；幅度整体缩放不变性、采样率等价、
50/80 ms 边界、各类拒绝条件、参数版本复现、分页、幂等导入、事务回滚、
以及关闭重开后的持久化和 HTTP 端到端流程（共 26 个用例）。

## 启动 / 停止 API

```powershell
# 编译后启动（仅绑定 127.0.0.1，端口 0 = 系统自动分配）
npm run build
npm start
```

启动后实际端口写入 `tmp/server.port`，控制台也会打印
`http://127.0.0.1:<port>`。数据文件固定在项目内 `data/acoustic.sqlite`。

```powershell
# 只停止本项目的服务（按 tmp/server.port 找到监听进程）
npm run stop
```

启动与停止脚本只管理本项目进程；所有数据与临时文件都在 `data/`、`tmp/` 内。

## 可重复的端到端演示

```powershell
npm run demo      # 等价于 powershell -ExecutionPolicy Bypass -File scripts/demo.ps1
```

演示会重建 `data/acoustic.sqlite`，用固定种子生成两个测点（T60=0.5 s 与
0.8 s），完成建点→导入→起点预览→设窗→分析→残差→比较→导出衰减表→
冻结→重复提交幂等的全流程。重复运行结果一致。

## CLI

```powershell
node dist/cli/index.js <command> [args...]
# 或 npm run cli -- <command> ...

point-add <alias> [note]
point-list [page] [pageSize]
synth-import <alias> <sampleRate> <t60Seconds> [preSilenceS] [seed] [idempotencyKey]
import <alias> <jsonFile> [idempotencyKey]   # json: {"sampleRate":1000,"samples":[...]}
onset-preview <responseId> [thresholdDb]
set-window <responseId> <onset> <noiseStart> <noiseEnd> <integrationEnd> [reason]
windows <responseId>
analyze <responseId> [windowId] [paramVersion]
residuals <analysisId>
compare <analysisIdA> <analysisIdB>
export-decay <analysisId> <outCsv>
show <analysisId>
freeze <analysisId>
versions
```

`set-window` 与 `synth-import/import` 会打印操作前后的计数或状态。
人工修改起点/噪声窗口会**新增一行窗口并产生新分析**，原始采样永不覆盖。

## REST API

所有响应为 JSON。成功：`{ "data": ... }`；失败：
`{ "error": { "code": "...", "message": "..." } }`，HTTP 状态码与错误码对应。
列表接口支持 `?page=&pageSize=` 分页并返回 `page/pageSize/total/totalPages`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/param-versions` | 最新及全部参数版本 |
| GET | `/api/param-versions/:v` | 读取某版本参数（未知返回 `PARAM_VERSION_UNKNOWN`） |
| POST | `/api/points` | 建测点 `{alias,note?}` |
| GET | `/api/points` | 测点分页 |
| GET | `/api/points/:id` | 单个测点 |
| POST | `/api/points/:id/responses` | 导入 `{sampleRate,samples,idempotencyKey?}` |
| GET | `/api/points/:id/responses` | 响应分页 |
| GET | `/api/responses/:id` | 响应元数据 |
| GET | `/api/responses/:id/onset-preview?thresholdDb=` | 起点建议 |
| POST | `/api/responses/:id/windows` | 新增/修订窗口 |
| GET | `/api/responses/:id/windows` | 窗口历史 |
| POST | `/api/responses/:id/analyses` | 分析 `{windowId?,paramVersion?}` |
| GET | `/api/responses/:id/analyses` | 报告分页 |
| GET | `/api/analyses/:id` | 单个报告 |
| POST | `/api/analyses/:id/freeze` | 冻结报告 |

典型错误码：`INVALID_ALIAS`、`ALIAS_EXISTS(409)`、`INVALID_SAMPLE_RATE`、
`NON_FINITE_SAMPLE`、`EMPTY_SAMPLES`、`INVALID_BODY`、`INVALID_JSON`、
`INVALID_NOISE_WINDOW`、`INVALID_ONSET`、`INVALID_INTEGRATION_END`、
`WINDOW_NOT_SET(409)`、`WINDOW_MISMATCH`、`PARAM_VERSION_UNKNOWN`、
`INVALID_PAGINATION`、`PAYLOAD_TOO_LARGE(413)`、`NOT_FOUND(404)`。

同一 `idempotencyKey` 重复导入返回既有响应（`duplicated:true`）；
同一 `(响应,窗口,参数版本)` 重复分析返回同一报告行，保证复现。

## 计算定义（全频带）

- **时间零点**：直达声起点 `onset`。起点之前的样本**不计入**早/晚能量，
  仅用于噪声估计；空噪声窗 `[noiseStart,noiseEnd)` 允许为空。
- **平方能量**：每样本能量 `x^2`。噪声策略 `subtract` 取噪声窗均方功率并
  逐样本减去（钳到 ≥0）。
- **Schroeder 衰减曲线**：对校正后平方能量做**反向积分**
  `E(t) = ∫_t^end p(τ)dτ`，再以 `10 log10(E(t)/E(0))` 得分贝曲线。
- **混响时间（EDT/T20/T30）**：在固定分贝区间对曲线做最小二乘直线拟合，
  斜率 `m`（dB/s）外推 60 dB：`T = -60/m`。
  - EDT：`[0,-10] dB`；T20：`[-5,-25] dB`；T30：`[-5,-35] dB`。
  因此录音总长度**不会**被当作混响时间。
- **清晰度/明晰度/语言清晰度**（时间零点=起点，边界样本归入晚期）：
  - `C50 = 10 log10(E[0,50ms) / E[50ms,end])` (dB)
  - `C80 = 10 log10(E[0,80ms) / E[80ms,end])` (dB)
  - `D50 = E[0,50ms) / E[0,end]`（0..1）
- **尾部截断**：积分终点 `integrationEnd` 之后样本不计；`noise_crossing`
  策略另在能量持续低于 `2×噪声功率` 处截断展示曲线。
- **不可估计条件**（对应结果 `null` 与 `flags`，绝不产生伪无穷值）：
  动态范围不足（`INSUFFICIENT_DYNAMIC_RANGE`）、衰减非单调
  （`NON_MONOTONIC`）、噪声底过高（`NOISE_FLOOR_TOO_HIGH`）、
  拟合样本过少、斜率非负、拟合 RMSE 超阈（`FIT_UNRELIABLE`）、
  记录过短、全零能量、以及单脉冲下晚期能量为 0 时 C50/C80 无定义
  （`ENERGY_RATIO_UNDEFINED`，此时 D50 仍为 1）。

参数集中在 `src/core/params.ts`，版本 `1.0.0`，不可变并带版本号；
迁移脚本可重复执行（启动时按 `schema_meta.version` 幂等迁移）。

## 目录

```
src/core      acoustics(Schroeder/拟合/指标) generator onset params service
src/db        schema 迁移、编解码、仓储、分页、事务
src/server    原生 http 应用与入口（127.0.0.1 + 自动端口）
src/cli       命令行
test          声学夹具、仓储/事务/持久化、HTTP 端到端
scripts       demo.ps1 / stop.ps1
data          SQLite 数据（项目内）
tmp           端口文件与导出（项目内）
```
