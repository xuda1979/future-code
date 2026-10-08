# Future-Code 技术报告

**版本：** 2.0  
**日期：** 2026 年 10 月  
**定位：** 面向长期软件研发与科研任务的可验证智能体运行时

## 摘要

Future-Code 面向持续数小时、数天甚至更长的复杂研发任务。其核心思想可以概括为：

> **模型提供智能内核，智能体系统提供运行协议；模型可以更换，目标、证据和验收规则必须持久。**

系统把认知、执行权和证据分成三个平面。外部大模型负责推理、写代码、提出工具调用、任务分解和科研假设；主权执行内核负责决定哪些动作允许执行、哪些状态必须持久、如何分配并发和预算、何时恢复、何时接受结果；Evidence Fabric 保存可追溯证据，并由独立验证器决定任务是否真正通过。

这使 Future-Code 的目标不再是“让一个 Agent 多思考几轮”，而是构建一个可恢复、可验证、可扩展、可度量的研发操作系统。

## 1. 为什么普通 Agent Loop 不够

典型 Agent 结构是“模型 -> 工具 -> 模型 -> 工具 -> 最终回答”。它适合短任务，但在长期研发中会暴露结构性问题：

- 对话中保存的状态会丢失或被压缩；
- 一个模型可能重复已经失败的方案；
- API 故障会导致无限重试或整条任务链停住；
- 远程训练任务超时后，系统不知道任务是否已经运行；
- 多个子智能体可能同时修改冲突文件；
- 子任务单独通过并不意味着整个项目可以集成；
- 模型可以“认为完成了”，但缺少独立验收证据。

Future-Code 的设计原则是：

> **认知可以是概率性的，执行权必须是确定的；策略可以自适应，验收条件不能被自适应算法悄悄修改。**

## 2. 三平面架构

### 2.1 认知平面

外部 LLM 负责开放式智能：计划、推理、代码、假设、恢复建议和解释。不同角色可以配置不同模型，系统不要求一个中央“大总管模型”包办所有决策。

### 2.2 主权控制平面

Sovereign Kernel 持有不可由模型直接修改的状态：

- 目标与冻结验收契约；
- 任务 DAG；
- read/write scope；
- 预算和超时；
- worker lease 与 fencing generation；
- 动态裂变权限和上限；
- Provider 故障状态；
- 远程任务稳定身份；
- 独立 verifier；
- 最终集成规则。

模型只能提交 Proposal，宿主系统执行 admit / reject / defer。

### 2.3 证据平面

Evidence Fabric 保存带来源的 observation、artifact、verifier result、claim、conflict、adjudication、episode 和 replay receipt。

因此，“聊天记忆”不再等于“系统事实”。

## 3. 简单任务必须快，长期任务必须稳

对所有任务使用同一执行策略，是 Future-Code 过去出现“简单任务也很慢”的重要原因之一。

简单任务的主要成本来自：推理过深、重复 API 调用、冷启动、代理层 pacing、重试放大和过重验证。当前交互路径已经沿着以下方向修正：

- 不再默认所有请求使用 max effort；
- 前台交互默认不使用无限持续重试；
- 小模型/辅助模型配置不会被主模型无条件覆盖；
- 不需要限流的新路由不再继承旧 GLM 5.2 的固定 0.8 秒间隔；
- streaming 失败后不再进入第二整轮 buffered retry。

长期任务需要相反的能力：中断后继续、Provider 恢复、远程任务 reconcile、独立验证、证据持久化。

因此：

> **任务 horizon 决定延迟策略；任务 horizon 不能改变正确性标准。**

## 4. Durable DAG 与多智能体协作

长期任务由宿主持久化为 DAG，而不是只存在于模型内部的文字计划。

每个任务可以包含依赖、读写范围、验收条件、上下文预算和资源估计。Ready 任务通过 lease 分配给 worker。Lease generation 可以阻止已经失去所有权的 stale worker 在恢复后继续提交。

当任务执行中发现新的独立子问题时，Future-Code 可以动态 spawn 子任务，但采用追加式 spawn edge，不修改已经冻结的父任务规格，并限制最大深度、子任务数和 delegation authority。

这样，多智能体的价值来自真实可调度的独立工作，而不是“多开几个聊天窗口”。

## 5. Worktree、独立验证与最终集成

每个任务可以在独立 Git worktree 中工作，并受到 write scope 约束。模型生成的修改先经过任务级独立验证。

但任务 PASS 不等于项目 PASS。最终 integration 会按依赖顺序重建已接受 patch、检查冲突、验证 protected verifier 没有被修改，并运行冻结的 integration checks。

这解决了大规模并行开发中的核心问题：局部正确不能自动推出整体可合并。

## 6. Evidence Fabric：让证据成为系统状态

Future-Code 不把聊天记录当作项目知识的唯一载体。

Evidence Fabric 保存：

- 持久化目标和依赖关系；
- 带 provenance 的机器、验证和实验结果；
- 强证据冲突；
- content-addressed artifact；
- 结构化执行经验；
- 基于可观测状态计算的调度先验。

如果两个高强度证据互相冲突，系统创建 OPEN conflict，并要求产生可机器判定的 discriminator，例如最小复现、反例、差分测试或区分性实验。

失败假设本身也是高价值资产，不能在上下文压缩后被重新尝试。

## 7. Provider 故障恢复

外部模型 API 的错误不应该自动变成“研发任务失败”。

Future-Code 为共享 Provider 路由维护 HEALTHY / OPEN / HALF_OPEN 状态机：

- transient failure 触发 cooldown；
- cooldown 期间不继续占用新的模型请求和 worker 容量；
- worker 可以释放任务槽并推进其他工作；
- 只允许受控 probe 测试恢复；
- outage epoch 防止旧请求的晚到成功错误清除新的故障；
- 未知 token/费用保持 UNKNOWN。

这样可以避免 retry storm，并把“服务商暂时不可用”和“研发任务本身失败”分离。

## 8. 远程算力与昂贵实验

训练、仿真、benchmark 等远程任务必须使用稳定 job identity。

提交动作和状态观察分离。控制进程超时后，系统先按 job key reconcile，而不是盲目 resubmit。这样可以避免长期科研中最昂贵的一类错误：因为本地失联而重复启动几小时甚至几天的远程训练。

## 9. 自我反思与 Intervention Memory

“让 Agent 自我反思”本身并不能保证进步。无约束反思容易变成更多文本。

Future-Code 的目标是把反思绑定到可测事件：停滞、连续失败、质量门禁失败、阶段结束和恢复。

系统把 intervention、上下文、样本数、不确定性和最终 verifier 结果关联起来，回答：

> **在类似状态下，哪一种干预真正提高了 verified progress？**

反思层没有权力修改验收标准。证据不足时允许 abstain。

## 10. Adaptive HACT：验证证据虚拟化

HACT 的核心不是简单“压缩日志”，而是把验证语义与证据布局分离。

语义平面保存稳定 check ID、candidate/checker/environment 绑定和 canonical outcome。布局平面只决定这些证据如何排序、聚合和分页。布局迁移会增加 generation fence，从而使旧布局的 publication ticket 失效。

HACT 使用 completion hyperedge：一次 refresh 中共同完成的检查集合。只使用 pairwise similarity 会丢失高阶结构，因此 pairwise affinity 只能用于提出候选排序，最终 layout cost 必须在完整 completion set 上评分。

当前冻结 v5 证据包括：

- 27 个 train/validation/held-out workload；
- clustered 场景在 128/512/1024 checks 下 held-out padded evidence 分别降低 23.43% / 10.75% / 5.56%；
- independent/global control 基本无收益；
- 12 个历史 source candidate 的 36 次 layout replay；
- learned balanced 相对 fixed8 的 whole-epoch compressed 降幅：NetworkX 41.84%、Toolz 4.36%、Future Code 18.53%；
- exhaustive diagnostic page 从 148 降到 95；
- 12/12 layout triple 的 root-status 文本保持一致。

这些结果证明的是证据表示优化，不是 LLM 推理能力提升或公网 WAN 加速。

## 11. 性能方法论：快不能靠降低质量

Future-Code 的性能改进必须在冻结质量边界下比较。

Real-project evaluation 固定 source revision、Task[]、模型、工具、预算、verifier 和 integration checks，再比较 baseline/candidate。

以下情况不能包装成“提速”：

- candidate 更快但质量门禁失败；
- 只有 replay，没有真实 API 请求；
- 费用无法测量却把它当作 0；
- 少于 3 次 live repetition；
- 一个项目推出对 Claude、Codex、Cursor 等系统的普适倍数优势。

## 12. 与普通 Agent Framework 的差异

| 问题 | 普通 Agent Loop | Future-Code |
|---|---|---|
| 目标 | Prompt | Durable objective + frozen contract |
| 分解 | 模型内部计划 | Host-visible DAG + bounded spawn |
| 并发 | 多个 API call | Lease + scope + dependency + quota |
| Provider 故障 | retry / error | durable cooldown + half-open recovery |
| 远程任务 | 超时后不确定 | stable identity + reconcile-first |
| 状态 | conversation | store + journal + artifact + evidence |
| 成功 | 模型说完成 | verifier + final integration |
| 自我改进 | 改 prompt | episode + intervention evidence |
| 证据传输 | 日志/上下文 | 可选 HACT evidence plane |

真正的护城河不在“有多少个 Agent”，而在这些 host-owned 机制能否形成一个可恢复、可验证、可复现、可扩展的长期执行协议。

## 13. 下一阶段重点

近期重点：

1. 自动 FAST / STANDARD / RESEARCH Task-Horizon Router；
2. 对独立 read-only 工具做有界并行；
3. Swarm 支持流式模型响应，降低 time-to-first-action；
4. 精确 profile worktree、Git、SQLite fsync 和 verifier 重建等固定成本；
5. 多个真实项目、至少三次 repetition 的 matched live evaluation；
6. HACT 接入真实诊断检索和物理 WAN 实验。

## 结论

Future-Code 的护城河不应建立在“拥有某一个更聪明的模型”上，而应建立在**如何把不稳定的模型智能转化为持续、可验证、可恢复的工程进展**上。

模型负责提出可能性，系统负责把可能性变成经过证据约束的现实进展。这一分工使 Future-Code 能同时追求两件通常冲突的事情：短任务足够快，长期项目足够可靠。
