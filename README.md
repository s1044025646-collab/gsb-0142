# IR Reverb Backend

本地运行的室内声学脉冲响应（IR）与混响评估后端。仅提供 HTTP API、CLI、合成 IR
生成器与自动化测试；不包含网页、音频剪辑或真实测量设备连接。范围限定为**全频带、
单通道**分析。所有数据保存在本项目的 SQLite 文件中，服务只绑定 `127.0.0.1` 自动端口。

## 依赖

- Node.js >= 22.6（使用内置 `node:sqlite`、`node:test` 与 TypeScript 类型擦除，无需构建步骤）
- 开发依赖：`typescript`、`@types/node`（仅用于 `npm run typecheck`）

```sh
npm install
```

## 常用命令

```sh
npm test                 # 运行全部自动化测试
npm run typecheck        # TypeScript 类型检查
npm run demo             # 可重复端到端演示（写入 data/demo.db 与衰减表 CSV）
npm run serve            # 启动 API（127.0.0.1 自动端口，Ctrl+C 停止；只管理本进程）
node src/cli.ts help     # CLI 全部命令
```

停止服务：在运行 `serve` 的终端按 `Ctrl+C`（只结束本项目进程）。清理演示数据：
删除 `data/` 目录即可。

## CLI 示例

```sh
node src/cli.ts add-point hall-a
node src/cli.ts synth 1 --type decay --t60 1.2 --sr 16000 --idempotency-key run-1
node src/cli.ts preview-onset 1
node src/cli.ts analyze 1 --onset 120 --noise-start 28000 --noise-end 32000
node src/cli.ts residuals 1
node src/cli.ts compare 1 2
node src/cli.ts export-decay 1 --step-ms 10 --out data/decay.csv
```

关键操作（建点、导入、分析）会打印操作前后的数据库状态计数。人工修改起点或噪声
窗口会创建**新的分析参数版本**（`paramVersion` 递增），原始采样永不修改；分析记录
创建即冻结（`frozen=1`）。

## HTTP API

错误统一为 `{"error":{"code","message"}}`，错误码：`VALIDATION_ERROR`(400)、
`INVALID_JSON`(400)、`DUPLICATE_ALIAS`(409)、`NOT_FOUND`(404)、
`PAYLOAD_TOO_LARGE`(413)、`INTERNAL_ERROR`(500)。列表接口支持 `?page=&pageSize=`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与计数 |
| POST | `/points` | 创建测点 `{alias}` |
| GET | `/points`, `/points/:id` | 分页列表 / 详情 |
| POST | `/points/:id/responses` | 导入响应 `{sampleRate, samples[], idempotencyKey?}`（幂等：同 key 返回原记录 200） |
| GET | `/points/:id/responses` | 分页列表 |
| GET | `/responses/:id/samples?offset=&limit=` | 分页读取采样 |
| POST | `/responses/:id/onset-preview` | 直达声起点预览（不写入） |
| POST | `/responses/:id/analyze` | 分析 `{onsetIndex?, noiseStart?, noiseEnd?, integrationEnd?}`，生成新参数版本 |
| GET | `/responses/:id/analyses` | 参数版本列表 |
| GET | `/analyses/:id` | 完整冻结报告 |
| GET | `/analyses/:id/residuals` | 拟合残差 |
| GET | `/analyses/:id/decay-table?stepMs=&format=csv` | 导出衰减表（JSON 或 CSV） |
| GET | `/compare?pointIds=1,2,...` | 测点对比（各取最新分析） |

## 声学定义

- **时间零点**：直达声起点采样（自动检测或人工指定）。所有时间与早/晚能量分界
  都相对该点；起点之前的静音不参与任何能量求和。
- **Schroeder 衰减曲线**：对噪声修正后的平方能量 `e[i] = max(x[i]^2 - noisePower, 0)`
  做反向积分 `E(t) = Σ_{i≥t} e[i]`，`L(t) = 10·log10(E(t)/E(0))`，单位 dB。
- **噪声处理策略（公开）**：`noisePower` 为噪声窗口（默认积分窗口最后 10%，可人工
  指定）内 `x^2` 的均值，从平方信号中减去并以 0 截断；峰噪比 < 20 dB 时标记
  `NOISE_FLOOR_HIGH`。
- **EDT / T20 / T30**：对 `L(t)` 分别在 `[0,-10]`、`[-5,-25]`、`[-5,-35]` dB 区间做
  最小二乘直线拟合，混响时间 = `-60 / 斜率`（由拟合斜率外推，**绝不**取录音总长）。
- **C50 / C80 / D50**：以起点后 50/80 ms 为界的早期/晚期能量比
  `10·log10(early/late)` 与 `100·early/(early+late)`（%）。
- **不可估计标记**：`INSUFFICIENT_DYNAMIC_RANGE`（衰减未达拟合下限）、
  `INSUFFICIENT_FIT_POINTS`、`FIT_UNRELIABLE`（R² < 0.9）、`NON_DECAYING_TREND`、
  `NON_MONOTONIC_TREND`、`NOISE_FLOOR_HIGH`、`TOO_SHORT_RECORDING`、
  `ZERO_ENERGY` / `ZERO_LATE_ENERGY` / `ZERO_EARLY_ENERGY`。零能量一律返回 `null`，
  绝不产生 Infinity/NaN。

## 测试与可复现性

夹具覆盖：解析指数衰减（理论衰减率核验）、前置静音、双阶段衰减、单脉冲、尾部噪声、
过短记录、全零；另核验手算 C50/C80/D50、幅度缩放不变性、采样率等价、50/80 ms 边界、
拒绝条件、参数版本复现、事务回滚与重启持久化。时间通过注入时钟固定，随机性通过
种子注入，重复提交（`idempotencyKey`）幂等。数据库迁移记录在 `schema_migrations`，
可重复执行。
