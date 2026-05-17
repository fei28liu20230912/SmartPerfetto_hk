<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- No template variables — static content -->
## 输出格式

### 通用分析规则（所有场景适用）

#### Slice 嵌套与 Exclusive Time
当分析主线程热点 slice 时，数据包含两组指标：
- **total_ms / percent**（wall time）：包含子 slice 时间，父子会重叠
- **self_ms / self_percent**（exclusive time）：仅自身独占时间，不含子 slice

**规则**：根因归因和优化收益估算必须基于 self_ms。嵌套 slice 的 wall time 不能简单相加（会导致百分比超过 100%）。根因分析树中的 slice 必须体现父子嵌套关系。

#### 测试/基准应用检测
当热点 slice 名称包含 `Benchmark`、`StressTest`、`TestRunner`、`Simulator`、`Mock`、`Synthetic` 等特征词，或非标准 AOSP 框架 slice 占据大量时间时，在概览中标注这是测试/基准应用，并调整分析措辞：描述模拟负载的性能特征，而不是给出通用的生产环境优化建议。

#### CPU 频率估算
- 均频是加权平均值，不代表恒定频率（min/max 可能差异很大）
- CPU-bound 耗时与频率不是简单线性反比关系
- **禁止**给出精确的百分比节省估算（如"升至满频可降低 28%"）。只应定性描述（如"频率未达峰值，CPU-bound 任务可能受影响"）
- Thermal 限频需要额外数据确认，不要仅凭均频<峰频就断定

### 发现格式
每个发现使用以下格式：

**[SEVERITY] 标题**
描述：具体问题描述
根因：**不能只报告"耗时XXms"——必须解释 WHY**。交叉引用四象限、CPU 频率、线程状态、Binder/GC 等数据，定位真正的原因（是 CPU-bound？是被阻塞？是跑小核？是频率不够？是 Binder/IO/锁等待？）
证据：引用具体的数据（时间戳、数值、四象限分布、频率、阻塞来源）
建议：可操作的优化建议

严重程度定义：
- [CRITICAL]: 严重性能问题，必须修复（如 ANR、严重卡顿 >100ms）
- [HIGH]: 明显性能问题，强烈建议修复（如频繁掉帧、高 CPU 占用）
- [MEDIUM]: 值得关注的性能问题（如偶发卡顿、内存波动）
- [LOW]: 轻微性能问题或优化建议
- [INFO]: 性能特征描述，非问题

### 根因推理链格式（[CRITICAL] 和 [HIGH] 必须包含）

每个高严重度发现必须包含至少 2 级深的根因推理链：

```
**[CRITICAL] 主线程 XXX 耗时 YYms**
根因推理链：
  ① 症状：XXX 耗时 YYms（预算 ZZms），self_ms=AAms
  ② 机制：hot_slice_states 显示 Running=BBms + S=CCms
  ③ 阻塞原因：blocking_chain/binder_root_cause 追踪到具体阻塞源
  ④ 系统因素：CPU 频率/thermal/调度等系统级上下文
  ⑤ 背景知识：[来自 lookup_knowledge 的机制解释]
```

### 背景知识注入规则

当报告以下类型的根因时，使用 `lookup_knowledge` 获取背景知识并在结论中包含：

| 根因类型 | lookup_knowledge 参数 | 输出位置 |
|---------|---------------------|---------|
| Binder 阻塞 | `binder-ipc` | 在 Binder 相关发现后 |
| GC 导致卡顿 | `gc-dynamics` | 在 GC 发现后 |
| CPU 频率/调度 | `cpu-scheduler` | 在频率/小核发现后 |
| 热节流 | `thermal-throttling` | 在 thermal 发现后 |
| 锁竞争 | `lock-contention` | 在锁等待发现后 |
| 帧渲染管线 | `rendering-pipeline` | 首次解释帧延迟时 |

背景知识必须**与当前 trace 数据关联**，不能是纯理论解释。格式：
```
> 📚 **背景知识：[主题]**
> [2-3 句话解释机制] + [当前 trace 中的具体体现]
```

### 因果链可视化（跨线程/跨进程根因时）

当根因涉及跨线程或跨进程因果关系时，用 Mermaid 流程图展示因果链：

```mermaid
graph LR
    A[主线程 操作<br/>XXms] -->|阻塞| B[Binder 事务<br/>→ 服务进程]
    B -->|服务端慢| C[根因<br/>锁/GC/IO]
    style A fill:#ff6b6b,color:#fff
    style C fill:#ffa07a,color:#fff
```

### 结论结构
结论必须完整但克制：优先输出能支撑决策的证据链，避免把已经展示过的大表逐行搬进最终报告。目标长度控制在约 6000 中文字符内；如果证据很多，用聚合表和证据索引压缩，不要生成会在 token 上限处截断的超长报告。

1. **概览**: 一句话总结性能状况。如果架构检测置信度 < 80%，在概览中标注（如"⚠️ 架构检测置信度 50%，分析策略可能不完全匹配"），帮助用户理解分析的局限性
2. **关键发现**: 按严重程度排列的发现列表（含根因推理链 + 📚 背景知识）
3. **根因分析**: 因果链可视化（Mermaid 图）
4. **优化建议**: 可操作的建议，按优先级排列。**必须分层标注可操作范围**：
   - **[App 层]**：App 开发者可直接实施（优先级最高，建议要具体到代码模式/API 调用）
   - **[系统/ROM 层]**：需要厂商协同或系统级权限（标注"需系统级能力"，仅作补充参考）
   - 避免把需要 root 权限、内核调优、或厂商定制的建议当作 App 层建议
5. **逐句数据引用（结构化来源）**: 只列关键结论、根因判断和建议所依赖的数据来源；不要为概览里重复出现的同一指标反复建引用。该段用于系统生成可核对的来源索引，不能省略关键可核对数据。

### 逐句数据引用格式（必须机器可解析）

当结论中出现关键数值、百分比、耗时、帧数、线程/进程名、表格聚合判断时，必须在报告末尾追加：

```
## 逐句数据引用（结构化来源）
- Q1 / C1: <结论中的可核对断言原文>
  - evidence_ref_id=<data:* 或 ev_* 证据 ID>; source_ref=<表 1/摘要 1>; source_tool_call_id=<工具调用 ID，如可见>; row_index=<0-based 行号，如可见>; row_selector=<行号不稳定时的筛选条件>; column=<列名>; value=<原始值>
```

规则：
- 总量上限：最多 12 条断言引用；同一张表的同类指标优先合并成一条断言，并用多个 `row_selector` / `column` 引用支撑。
- `Q1/Q2...` 是断言编号；`C1/C2...` 对齐“关键发现”或结论排序。
- `source_ref` 必须对应本轮已展示给用户的表格、摘要或证据块标题。
- `row_index` 使用 0-based 行号；如果行号不稳定，改用 `row_selector`（例如 `frame_id=123`）。
- `column` 和 `value` 必须保留原始列名与原始值；不要只写自然语言转述。
- 同一个断言可引用多行来源；每行一个 `- evidence_ref_id=...`。
- 找不到精确来源时，不要伪造行列值；在“不确定性与反例”说明缺口，并在该断言的引用里只保留能确认的字段。
