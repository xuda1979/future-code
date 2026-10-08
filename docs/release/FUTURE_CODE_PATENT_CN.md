# 专利技术交底书（建议稿）

## 一、发明名称

**一种面向长期研发任务的证据驱动、自恢复且可自适应编排的智能体执行方法、系统、电子设备及存储介质**

可选简称：**证据驱动的长期研发智能体运行系统**。

> 说明：本文为技术交底及权利要求建议稿，不构成法律意见。正式申请前应由专利代理人结合现有技术检索、申请主体、发明人信息和目标法域进一步调整。

## 二、技术领域

本发明涉及人工智能智能体、软件工程自动化、分布式任务编排、机器学习研发平台、远程计算任务管理及计算机系统可靠性领域，尤其涉及一种将大模型认知能力与宿主执行权分离，并基于持久任务图、租约 fencing、证据状态、独立验证、远程副作用稳定身份、故障恢复和自适应策略选择实现长期研发任务连续执行的技术方案。

## 三、背景技术

现有大模型智能体通常采用“模型输出 -> 工具调用 -> 将结果返回模型”的循环。该结构适合短时交互，但用于跨小时、跨天的软件研发或科研任务时存在至少以下问题：

1. 任务状态依赖对话上下文，压缩或进程中断后容易丢失；
2. 多个子智能体缺少统一且可验证的执行所有权，可能产生并发写冲突；
3. API 暂时不可用时，前台 worker 可能长时间 sleep 或形成 retry storm；
4. 远程训练/仿真调用超时后，无法区分“提交失败”和“已经运行但本地未知”，容易重复提交；
5. 模型既提出方案又解释结果，缺少独立于模型文本的 PASS 判定；
6. 自我反思常停留在自然语言总结，无法证明策略是否提高了验证后的进展；
7. 当验证证据规模较大时，完整传递会产生大量重复证据开销；
8. 为提高速度调整 Agent 策略时，容易连同验收标准一起变化。

因此，需要一种在模型、网络和远程计算均可能不稳定的情况下，仍保持任务身份、执行权、证据和验收规则连续一致的技术方案。

## 四、发明目的

本发明至少解决以下技术问题：

- 将概率性的大模型认知与确定性的执行授权分离；
- 在进程崩溃、Worker 超时或迁移后避免 stale worker 发布；
- 在动态任务裂变时保持父任务规格不可变和 lineage 可追溯；
- 在模型服务故障时释放计算槽并抑制重复请求；
- 对远程副作用采用 reconcile-first，避免昂贵任务重复提交；
- 用机器可验证证据而非模型最终回答决定任务通过；
- 对长期历史中的失败假设、冲突证据和有效干预进行持久化；
- 在不改变验收语义的前提下优化验证证据布局；
- 根据任务 horizon 调整延迟/推理策略，同时保持统一质量边界。

## 五、总体架构

本发明包括三个逻辑平面。

### 5.1 认知平面

至少一个大模型接收受限上下文并生成结构化 Proposal，所述 Proposal 可包括任务分解、代码修改、工具调用、实验假设、恢复建议或子任务生成请求。

### 5.2 主权控制平面

由宿主系统而非模型持有至少下列受保护状态：

- Objective ID 及冻结验收契约；
- Task DAG、依赖、read/write scope；
- Task attempt、lease owner、lease generation；
- 动态 spawn authority、depth limit、child limit；
- Provider quota pool 及故障 epoch；
- 外部 job key、submission intent、reconciliation state；
- verifier/checker identity；
- final integration state；
- budget 与 stop condition。

模型 Proposal 必须经过 admit、reject 或 defer 后才能变为可执行动作。

### 5.3 证据平面

系统记录与目标和候选版本绑定的 observation、artifact、verifier result、claim、conflict、adjudication record、episode 和 replay receipt。证据记录具有 provenance，可指向代码版本、环境、检查器和远程 job。

## 六、关键技术方案

### 6.1 不可变任务规格与追加式动态裂变

已入队父任务的目标、验收条件和 scope 保持不可变。运行过程中发现新工作时，不原位改写父任务，而是写入 spawn edge 并生成稳定 Task ID 的子任务。

宿主验证父任务 delegation authority、子任务深度、数量、scope 和 request identity，从而使 replay 不会重复产生不同子图。

### 6.2 Lease fencing 与 stale worker 拒绝

对每个任务维护 lease generation。Worker 获取任务时同时获得 generation；任何可发布结果必须携带该 generation。

当 lease 过期、被回收或转移时 generation 增加，旧 worker 即使随后恢复，也因 generation 不匹配而不能发布。

### 6.3 Provider 故障共享状态机

按 quota pool 共享维护 HEALTHY、OPEN、HALF_OPEN 状态：

- transient provider failure 进入 OPEN 并记录 retry_at；
- OPEN 状态拒绝新的模型请求预留并释放 worker 容量；
- 到达 retry_at 后仅允许一个受控 probe 进入 HALF_OPEN；
- probe 成功恢复 HEALTHY，失败则增加 backoff；
- 每次故障周期具有 outage epoch，旧 epoch 的晚到成功不得清除新故障。

### 6.4 远程副作用稳定身份和 reconcile-first

对训练、仿真、远程编译等外部任务，在提交前持久化 logical job key、submission intent、payload/hash 和 provider identity。

当提交结果不确定或控制端崩溃时，恢复流程首先通过稳定 key 查询远端状态。只有证据表明先前副作用不存在时才允许重新提交。

### 6.5 独立验证与最终集成

Worker 产生的候选 patch 不能自行标记 PASS。独立 verifier 在冻结 checker 配置下验证候选，并将证据绑定到 candidate identity。

多个任务分别 PASS 后，系统在集成环境中按依赖顺序重构 patch、检测冲突并运行 final integration checks。只有集成证据满足 Objective acceptance contract 时才发布目标完成状态。

### 6.6 Evidence Fabric 和冲突裁决

若同一目标存在相互矛盾的强证据，则建立 OPEN conflict，而不是多数投票。

系统根据冲突构造 adjudication proposal，其验收条件要求产生可机器判断的 discriminator，例如最小复现、反例、差分测试或判别实验。Adjudication proposal 仍通过正常 admission。

### 6.7 受约束的自反思与 Intervention Memory

系统按 episode 保存任务拓扑、失败模式、干预策略、样本数、不确定性、资源消耗和最终独立验证结果。

在停滞、重复失败或阶段结束时，可由模型产生 reflection；宿主将其转化为 advisory intervention。后续策略选择依据历史 verified outcome，而不是只依据自然语言相似度。

Intervention 不得直接修改冻结 verifier、acceptance threshold 或权限边界。

### 6.8 Adaptive HACT 验证证据虚拟化

对大量验证项建立稳定 semantic check ID。Candidate identity 至少绑定 source snapshot、checker、environment、registry 和 epoch。

Canonical evidence 为语义真值来源；HACT layout 仅保存 semantic ID 的 permutation 和 aggregation tree。

布局切换时 generation 增加，并使旧布局 publication ticket 失效。授权函数读取 canonical evidence 和受保护 contract，而不以 layout 形状定义验收语义。

训练阶段记录 completion hyperedge，即两次 refresh 之间共同 final 的 check 集合。Pairwise affinity 仅用于生成候选排序，layout 选择通过完整 hyperedge 回放并在 validation cohort 上与 incumbent 比较。

### 6.9 基于任务 horizon 的执行策略选择

宿主根据依赖数量、预计时长、远程 job、风险等级、重复失败、文件影响范围等可观察信号选择 FAST、STANDARD 或 RESEARCH 等执行策略。

策略可改变模型 effort、并行度、重试等待方式、上下文预算和是否进入 durable supervisor，但不得降低 frozen acceptance contract。

## 七、技术效果

本发明可产生以下一种或多种技术效果：

1. 崩溃恢复后阻止 stale result 污染当前状态；
2. 动态多智能体裂变可审计且不原位篡改父任务；
3. Provider 故障期间释放 worker 容量并减少重复请求；
4. 远程任务失联后减少重复训练/仿真；
5. 将模型主观“完成”与机器可验证 PASS 分离；
6. 通过最终集成避免局部 PASS 被错误提升为整体 PASS；
7. 保留失败假设和冲突证据，降低长期研发重复试错；
8. 在验收语义不变的条件下自适应优化证据表示；
9. 简单任务使用低开销路径，长期任务保留强恢复和强验证。

## 八、附图建议

- 图1：认知平面、主权控制平面、证据平面总体架构；
- 图2：Provider HEALTHY/OPEN/HALF_OPEN 状态机与 outage epoch；
- 图3：Task DAG、spawn edge、lease generation 和 stale worker 拒绝；
- 图4：远程 job submission-intent / reconcile-first 流程；
- 图5：HACT semantic plane、layout plane、canonical evidence 和 generation fence；
- 图6：FAST/STANDARD/RESEARCH horizon router 与统一 acceptance contract。

## 九、实施例

### 实施例一：大型软件功能开发

系统将一个跨模块目标冻结为 Objective，拆分为接口、API、存储、测试和集成任务。接口任务通过后，其 artifact 以 hash 绑定的 dependency view 提供给并行子任务。Worker 超时后 lease generation 更新，旧 worker 返回时不能提交。各任务独立验证后重新集成，并运行项目级 regression gate。

### 实施例二：远程模型训练

本地 Agent 提交训练前生成 job key 和 submission intent。网络在提交返回前断开。恢复进程不直接再次提交，而是按 job key 查询训练平台；若发现任务 RUNNING，则恢复监控；仅在确认不存在该 job 时才重新提交。

### 实施例三：验证证据自适应布局

系统记录历史 candidate 的 completion hyperedge，生成 learned-order balanced-tree 候选。Validation 无收益时保留 incumbent；存在稳定 locality 时部署新布局并增加 generation。旧 generation 的 publication ticket 被拒绝，验收结果仍由同一 canonical check registry 决定。

## 十、建议权利要求

### 权利要求1（独立方法）

一种面向长期研发任务的智能体执行方法，其特征在于，包括：

A. 建立与研发目标对应的持久目标标识和冻结验收契约，所述冻结验收契约至少包括任务依赖、验收条件和执行权限边界；

B. 接收大模型生成的候选执行提议，并由独立于所述大模型的宿主控制模块对所述候选执行提议进行准入判定；

C. 对准入任务分配包含代际信息的执行租约，并基于所述代际信息拒绝租约已失效的执行者提交状态变更；

D. 将任务执行产生的工件及验证结果形成与候选版本绑定的持久证据，并由独立验证模块根据所述冻结验收契约产生任务验收状态；

E. 当外部模型服务不可用时，将服务不可用状态持久化为共享故障状态并释放持有该模型请求的执行容量，在满足恢复条件后通过受控探测恢复请求准入；

F. 对具有外部副作用的远程任务，在提交前记录稳定任务标识和提交意图，并在提交结果不确定时先根据所述稳定任务标识执行状态协调，再决定是否重新提交；

G. 在多个任务验收通过后重新构建组合候选并执行最终集成验证，仅在最终集成证据满足所述冻结验收契约时输出研发目标完成状态。

### 权利要求2

根据权利要求1所述的方法，其中动态任务裂变通过追加 spawn edge 新建子任务实现，已准入父任务规格保持不可变，并对裂变深度、子任务数量和委托权限进行宿主侧限制。

### 权利要求3

根据权利要求1所述的方法，其中共享故障状态至少包括 HEALTHY、OPEN 和 HALF_OPEN，并使用故障 epoch 防止早于当前故障 epoch 的晚到成功响应清除当前故障。

### 权利要求4

根据权利要求1所述的方法，其中所述执行租约包括 lease owner、lease generation 和有效期，状态写入需要同时满足当前 owner 与 generation。

### 权利要求5

根据权利要求1所述的方法，其中证据包括 observation、content-addressed artifact、verifier result、claim 和 conflict 中至少两类，并保存产生证据的代码、检查器或环境身份。

### 权利要求6

根据权利要求5所述的方法，其中互相矛盾的强证据形成 conflict，并生成需要最小复现、反例、差分测试或判别实验的 adjudication proposal。

### 权利要求7

根据权利要求1所述的方法，其中根据历史 episode 中的验证结果生成 intervention memory，并仅在不修改冻结验收契约的条件下选择后续恢复或执行策略。

### 权利要求8

根据权利要求1所述的方法，其中对验证证据建立语义平面和布局平面，语义平面保存稳定 check identity 和 canonical outcome，布局平面保存所述 check identity 的排列及层次聚合结构。

### 权利要求9

根据权利要求8所述的方法，其中布局迁移时增加 layout generation，并拒绝携带旧 layout generation 的 publication ticket。

### 权利要求10

根据权利要求8所述的方法，其中记录同一 refresh 周期共同完成的多个 check 形成 completion hyperedge，基于所述 completion hyperedge 评价候选证据布局的层次更新成本。

### 权利要求11

根据权利要求10所述的方法，其中 pairwise affinity 用于生成候选 check 排序，候选布局依据独立 validation 数据上的完整 completion-hyperedge 成本进行选择，并在候选不优于 incumbent 时保留 incumbent。

### 权利要求12

根据权利要求1所述的方法，其中基于任务 horizon 选择至少两种不同的模型 effort、重试、并行或上下文策略，同时保持相同的冻结验收条件。

### 权利要求13（独立系统）

一种智能体执行系统，包括模型适配模块、主权控制模块、任务调度模块、证据存储模块、独立验证模块、外部任务协调模块和集成模块，各模块被配置为执行权利要求1至12任一项所述的方法。

### 权利要求14

一种电子设备，包括处理器和存储器，所述存储器中存储有指令，所述指令被所述处理器执行时使所述电子设备执行权利要求1至12任一项所述的方法。

### 权利要求15

一种非暂态计算机可读存储介质，其上存储有计算机程序，所述程序被处理器执行时实现权利要求1至12任一项所述的方法。

## 十一、保护策略建议

优先保护以下具有明确状态机、数据结构和技术效果的组合，而不是仅保护“多智能体”或“自动恢复”：

1. 冻结 acceptance contract + 模型 Proposal/宿主 Authority 分离；
2. lease generation fencing + immutable task spec + append-only spawn edge；
3. shared provider outage epoch + worker release + half-open probe；
4. stable external job identity + submission intent + reconcile-first；
5. canonical evidence + independent verifier + final integration；
6. semantic/layout separation + generation fence + completion-hyperedge layout selection。

其中第6组可考虑作为独立 HACT 分案或后续申请，以增强技术聚焦度。

## 十二、检索建议

正式申请前建议由专利代理人针对以下关键词及组合开展中、美、欧及 PCT 检索：

- AI agent runtime / agent orchestration / durable workflow；
- lease fencing / generation fencing / stale worker；
- distributed task DAG / dynamic task spawning；
- circuit breaker / half-open / shared provider recovery；
- idempotent external job / reconcile-before-retry；
- evidence graph / proof-carrying agent / independent verifier；
- adaptive certificate tree / evidence layout / authenticated tree；
- completion hyperedge / workload-adaptive data structure；
- verification-first agentic software engineering。

最终权利要求范围、单一性、创造性论证和公开时点，应结合正式现有技术检索与专利代理人意见确定。
