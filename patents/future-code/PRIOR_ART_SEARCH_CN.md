现有技术检索报告  
Prior Art Search Report  
**面向长期研发任务的证据驱动、自恢复智能体执行系统**  
编制日期：2026-10-09

# 检索参数 / Search Parameters
| 参数 / Parameter | 内容 / Value |
|---|---|
| 检索日期 / Search Date | 2026-10-09（更新复核） |
| 公开时间范围 / Period | 2008—2026-10-09；重点2018—2026年 |
| 已核查来源 / Verified Sources | Google Patents 的 US/EP/CN/WO 文献页与部分权利要求；Temporal、LangGraph、Bazel 官方公开资料；Future-Code GitHub 源代码和既有测试说明 |
| 检索方法 / Method | 公开号及标题复核、英文/中文关键词组合、同族识别、与拟议独立权利要求的逐要件人工对照 |
| 未完成事项 / Limitations | 未执行各国官方数据库的穷尽检索；部分公开仅完成摘要及独立权利要求层级核查；同族全量、审查档案、法律状态、FTO 均待代理人正式复核 |
| 拟保护主题 / Subject | 冻结验收契约下的模型提议双重准入、稳定远端作业幂等确保、未决副作用及证据的目标级完成阻断 |
| 对应交底书版本 | 本次复核版，发明人列示：许达、王飞；交底书重点 A、C、E，B/D/F 为从属或备选 |

## 使用的关键词 / Keywords Used
英文：AI agent orchestration; large language model agent; task DAG; workflow checkpoint; durable execution; model-driven multi-agent; lease fencing; stale worker; idempotent job; reconciliation; external side effect; verification evidence; autonomous software development; certificate tree; incremental verification; agent recovery。

中文：大语言模型 智能体任务编排；动态 DAG；任务恢复；多智能体协同；租约代际；迟到写入；远程作业幂等；不确定提交；机器验证；代码集成验收；证据图谱；检查项增量更新。

# A类：基础性现有技术 / Category A: Foundational Prior Art
## A1. 大模型多智能体协作框架
文献：Wu 等，《AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation》，2023，arXiv:2308.08155，https://arxiv.org/abs/2308.08155 。

主要内容：多个可对话 Agent 协作、工具使用及对话编排。与本交底书的关系：证明“多智能体+调用工具+讨论/协调”是已知范式；该文献不是本发明架构的唯一背景，也不能据此断言其没有任何执行验证机制。潜在区别须落在具体的提议哈希绑定、代际租约和远端副作用恢复状态上，而非 Agent 数量。

## A2. 持久工作流与故障重放
资料：Temporal《Event History》《Understanding Temporal》，https://docs.temporal.io/encyclopedia/event-history 、https://docs.temporal.io/evaluate/understanding-temporal 。

主要内容：将事件追加到持久历史，通过事件重放恢复 Workflow，管理 Activity 与失败重试。与本发明的关系：持久工作流、事件日志、崩溃恢复和重试都已广泛公开。本发明不能主张这些基础机制单独新颖；需限定“模型提议准入—冻结目标—外部实验不确定状态—最终证据门控”这一特定相互约束的技术流程。

## A3. 智能体图持久化与检查点
资料：LangGraph《Persistence》，https://docs.langchain.com/oss/python/langgraph/persistence （亦可参见 https://langchain-ai.github.io/langgraph/concepts/durable_execution/ ）。

主要内容：执行图的 checkpointer、线程状态持久化、故障恢复、人机交互恢复。风险：以“任务 DAG + 检查点 + 可恢复”概括权利要求，容易与该方案及更早工作流引擎重合。候选差异不在检查点本身，而在被权限和版本绑定的跨外部系统完成证明。

# B类：相关智能体编排现有技术 / Category B: Related Agent Orchestration Prior Art
## B1. 基于大语言模型的任务拆解与 DAG 编排
专利：CN120560815A，《一种基于大语言模型的任务拆解与多智能体编排执行系统及方法》，优先权日2025-06-26，https://patents.google.com/patent/CN120560815A/zh 。

公开要点：LLM 解析任务，生成 DAG，并行调度、上下文与缓存优化。与本申请的重合度：高（动态任务图和多智能体并行）；可能区别：其概述与权利要求公开的侧重点并非冻结目标验收与外部副作用不确定状态的联合门控，但需对全文、从属权利要求及同族案再查。

## B2. 模型驱动动态工作流调整
专利族：US20260127463A1 / EP4742096A1，《Flow orchestration for model-based agents》，优先权日2024-11-07，分别于2026-05-07与2026-05-13公开，https://patents.google.com/patent/US20260127463A1/en 、https://patents.google.com/patent/EP4742096A1/en 。

公开要点：使用多轮、多智能体工作流，在部分数据返回后由生成式模型调整执行顺序/流程。与本发明的重合度：中高（动态编排）；区别主张须强调：原已准入父任务规格不变、宿主根据散列与租约复核、模型不能改变验收边界。该专利族对广义“自适应 Agent 计划”权利要求形成直接挑战。

## B3. 生成式 AI 指导的多智能体任务管理
专利：US20250356313A1，《Multi-agent task management guided by generative artificial intelligence》，2025年公开，https://patents.google.com/patent/US20250356313A1/en 。

公开要点：任务管理 Agent、执行 Agent、子任务创建、AI 输出评价与上下文更新。与本发明重合度：高（任务分解、执行、结果评价）；潜在区别需具体落到外部作业提交前意图、UNKNOWN 协调和目标完成的机器验收条件。不得将“模型与任务管理分层”单独作为新颖性结论。

# C类：执行可靠性与协议现有技术 / Category C: Reliable Execution and Protocol Prior Art
## C1. 通用租约、事务与任务重放
Temporal 的事件历史和 Activity 重试、通用分布式锁 fencing token、事务性唯一键及退避机制均属于已知工程手段。原交底书把租约代际、事件存储与重试本身称为创新容易被质疑。需具体比较的是模型提议载荷与当前 fence、冻结契约的反复绑定及其与外部作业的同一目标门控。

参考：https://docs.temporal.io/encyclopedia/event-history ；https://docs.temporal.io/evaluate/understanding-temporal 。

## C2. 内容寻址、幂等键与远端副作用
Bazel Remote Execution API 及远程缓存中以输入摘要识别动作属于既有机制；Temporal 亦指出 Activity 重试需依赖外部接口的幂等性。稳定 key 和“重试安全”本身不足以支持宽泛权利要求。Future-Code 代码实际要求远程 job adapter 具备 idempotentEnsure：未知 job_id 时发送 ensure(key)，已知 job_id 时发送 inspect(jobId)，由远端保证重复 ensure 仅接续同一个作业；若远端不履约，仅凭本地日志不能提供 exactly-once。

参考：https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto ；https://temporal.io/blog/saga-pattern-made-easy 。

**接近本申请的智能体未知结果恢复公开（重点风险）：** Temporal 于 **2026-10-08** 发布《The immortal life of Pi (Running the Pi coding agent on Temporal)》，介绍执行工具前留下 pending 声明、执行中断后对结果标记 UNKNOWN、不自动重放工具调用，并让恢复后的 Agent 先确认外部状态。该公开与交底书创新点 C 的“先登记意图、不确定不盲目重试”高度接近。未来差异化只能具体落在远端作业适配器的 **idempotent ensure/inspect 契约、稳定绑定键、冻结目标级验收和持续冲突阻断** 的联动；即使如此，也不能排除该公开与 C1/C2 结合后导致创造性不足。

核查：https://temporal.io/blog/the-immortal-life-of-pi-running-the-pi-coding-agent-on-temporal （发布日期 2026-10-08）。

# D类：证据验证与研发自动化现有技术 / Category D: Evidence and R&D Automation Prior Art
## D1. 自主软件测试与独立验证专利
US12411758B1，《Autonomous software testing agent》，2025-09-09 授权公开。其权利要求明确涵盖自主测试 Agent 及与测试操作分离的验证规则，故“执行与验证分离”不能作为本申请独立创新。Future-Code 候选区别在于工件/检查器版本绑定、未解决外部作业、强证据冲突和合并树最终检查共同阻断目标完成。

核查：https://patents.google.com/patent/US12411758B1/en 。

## D2. AI 生成软件及其测试流程
US20260211802A1，《Artificial Intelligence (AI) Assisted End-to-End Workflow Integration for Software Development in Digital Model Platforms》，2026 年公开，包含生成程序、生成测试并产出报告。该专利直接挑战把“模型产出代码 + 测试验证 + 报告”组合为独立发明的论证。本申请必须进一步限定一致性控制、提交意图及外部作业验收条件。

核查：https://patents.justia.com/patent/20260211802 。

**HACT 的证据层次布局：** Merkle 树、层次证据摘要、增量计算、缓存与内容寻址已广泛公开。Future-Code 的 stable check_id、generation-fenced publication ticket 和 completion hyperedge 布局选择需另行对照证据索引/层次更新/自适应布局文献。当前未完成该主题的专项专利检索，也无充分 live-WAN/在线大模型实证证明普适性能优势；宜作为从属备选或后续单独主题。

# E类：专利检索结果 / Category E: Patent Search Results
## USPTO 检索结果
下表指**美国公开专利文献**；核查工具为 Google Patents 镜像，未声称完成 USPTO 官方站点的检索。

| 公开或授权号 | 主题 / 已公开核心特征 | 风险 | 与本申请可核查的剩余区别 |
|---|---|---|---|
| US20250356313A1 | 多 Agent 任务管理、子任务创建及结果评价；2025-11-20 公开 | 高 | 验收契约—远端任务 UNKNOWN—最终集成的联合门控需逐权项比对 |
| US20260127463A1 | 模型动态调整多 Agent 工作流；2026-05-07 公开 | 高 | 冻结父任务与副作用前租约复核，不能泛称动态 DAG 新颖 |
| US12481517B1 | AI Agent 调度、资源扩缩容；2025-11-25 授权 | 中 | 本申请不以资源编排本身为创新 |
| US12307349B2 | LLM 驱动多任务代理编排与检验；2025-05-20 授权 | 中高 | 原独立权利要求包含代理结果复核概念，须核实范围 |
| US12411758B1 | 自主软件测试与分离的验证规则；2025-09-09 授权 | 中高 | 独立验证本身已知，拟限定跨远程任务与集成完成门控 |

核查：https://patents.google.com/patent/US20250356313A1/en ；https://patents.google.com/patent/US20260127463A1/en ；https://patents.google.com/patent/US12481517B1/en ；https://patents.google.com/patent/US12307349B2/en ；https://patents.google.com/patent/US12411758B1/en 。

## EPO 检索结果
| 公开号 | 公开日期 | 风险及同族关系 |
|---|---|---|
| EP4742096A1 | 2026-05-13 | 与 US20260127463A1 同一相关专利族；已公开模型驱动工作流重编排 |

核查：https://patents.google.com/patent/EP4742096A1/en 。本节不表示没有其他相关欧洲公开。

## CNIPA 检索结果
以下为中国公开专利文献，借助 Google Patents 核查，不代表官方 CNIPA 全量检索。

| 公开号 | 核查主题 | 风险 |
|---|---|---|
| CN120560815A | LLM 任务拆解、DAG 调度与缓存优化 | 高 |
| CN121212278A | 任务自动编排、事件驱动异常重规划 | 高 |
| CN118819778A | 大模型 Agent 编排与任务处理 | 高 |
| CN121523815A | 软件多智能体动态协同及依赖图 | 中高 |

核查：https://patents.google.com/patent/CN120560815A/zh ；https://patents.google.com/patent/CN121212278A/zh ；https://patents.google.com/patent/CN118819778A/zh ；https://patents.google.com/patent/CN121523815A/zh 。

**同族更正：** WO2025076107A1 与 US12307349B2 对应同一相关申请家族，不应被误写为完全独立的另一技术来源。核查：https://patents.google.com/patent/US12307349B2/en 。

# 新颖性分析 / Novelty Analysis
## 创新点 A：提议散列绑定与副作用前再核验
已知：模型工具调用、权限管理和持久记录。候选限定：宿主同时绑定 run/task/fence/contract/recipe/payload，先记录准入，再在副作用边界以当前租约重检。新颖性判断：**未确认**，需补查授权提议及能力票据有关专利；创造性风险为中高。

## 创新点 B：原子裂变与父规格冻结
已知：DAG、动态重规划、分布式租约、幂等事务。候选限定：父规格不改写、request_key+hash 重放检查与父租约/作用域在同一事务内验证。创造性风险：**高**，适合作为系统组合中的从属细化。

## 创新点 C：幂等 ensure/inspect 与未知作业阻断
已知：副作用意图/结果日志、幂等键、未知结果先查（特别是 Temporal 2026-10-08 公开）。候选限定：本地 research_jobs 双重身份绑定；适配器 idempotentEnsure；未知 job_id 用 ensure、已知用 inspect；未终结作业阻断目标 PASS。初评：**高度接近现有技术，单独授权风险高**，应放进 A+E 跨层链路。

## 创新点 D：服务池 epoch 熔断与槽位释放
已知：熔断、退避、半开探测及代际。候选限定：quota_pool 共享 epoch、防迟到成功清除新故障、等待释放工作槽。初评：独立创造性风险**高**；从属备选。

## 创新点 E：外部作业、冲突与集成的联合验收
已知：独立验证、测试门控、CI、结果聚合及自治测试专利。候选限定：同一冻结目标下同时阻断 UNKNOWN 外部任务、OPEN conflict、失效 claim，并强制合并工件后再运行固定检查器。初评：仍有较具体的组合论证空间，但尚未检索充分到可以作出新颖/非显而易见结论。

## 创新点 F：证据语义与层次布局隔离
已知：内容寻址、哈希树、增量验证。候选限定：稳定检查身份、布局代际隔离及 completion hyperedge 验证样本上的布局选择。当前检索不足以给出可靠的新颖性结论；若另案申请应补充数学规范与独立对照实验。

# 可专利性评估 / Patentability Assessment
| 评估项目 | 复核意见 | 建议动作 |
|---|---|---|
| 新颖性 | 仍未知；多项要件已公开，不能宣称任何一项全球首次 | 优先以修订后的权利要求1逐段核对更早公开 |
| 创造性 | **高风险**；Temporal Pi 与现有 AI Agent 专利显著缩小 C/E 的独立差异 | 围绕完整跨层状态门控、实际故障负测及不可替代的技术效果论证 |
| 充分公开 | 旧稿远端恢复语义与代码不符；本次已按 idempotentEnsure 修正 | 代理人进一步确认 ensure 的远端原子性及宿主/适配器失效处理 |
| 工业实用性 | 有代码和执行流程基础 | 保留部署假设、数据结构及异常状态迁移实例 |
| 单一性 | A/B/C/D/E/F 技术主题较多 | 以 A+C+E 为中心，B/D 为从属，F 单独考虑 |
| 权利归属 | 仍待核实；已确认发明人列示为许达、王飞 | 由两位核对排序、创造性贡献、申请主体及开源来源 |
| 公开时点 | **紧迫**；仓库公开且 2026-10-09 既有专利交底书 PR 已合并 | 梳理最早 GitHub commit、公开内容及适用法域宽限期，不承诺仍具新颖性 |
| 效果证据 | 有离线/回归测试说明，无跨平台 live-agent 性能优越结论 | 不使用固定倍数或绝对 exactly-once 作为申请依据 |

# 权利要求差异化矩阵 / Claim Differentiation Matrix
| 修订权利要求1要件 | 已知最接近技术 | 待论证的组合限定 | 代码参照 |
|---|---|---|---|
| 冻结验收契约 | Temporal/LangGraph、CI | 提议和副作用整个周期绑定契约/配置 | `src/harness/foundry/store.ts` |
| 结构化提议双校验 | 多 Agent 编排、权限控制 | proposal hash+当前 fence 双边界校验 | `src/harness/foundry/proposals.ts` |
| 远端 UNKNOWN/稳定 key | Temporal Pi、Bazel、幂等 Activity | `idempotentEnsure` 与 `inspect` 的两种状态路径，身份不可漂移 | `src/harness/foundry/swarm/jobs.ts` |
| 未解决结果阻断完成 | 测试门控与独立验证 | 远端任务/强证据冲突/失效 claim 联合条件 | `src/harness/foundry/swarm/supervisor.ts` |
| 合并树最终检查 | 现有 CI/多 Agent 测试 | 冻结目标下局部 PASS 不提升为目标 PASS | `src/harness/foundry/swarm/host.ts` |
| 原子裂变（从属） | CN120560815A、US20260127463A1 | 父规格冻结+唯一请求+同事务父 lease 校验 | `src/harness/foundry/dynamicDag.ts` |
| 模型服务恢复（从属） | 既有熔断器 | 资源池 epoch 和旧成功回复拒绝 | `src/harness/foundry/swarm/providerRecovery.ts` |

# 关键区别特征 / Key Distinguishing Features
建议专利代理人优先论证**同一目标契约下的跨故障域状态一致性**：模型侧结构化提议不能直接越权执行；执行侧在副作用边界重验 lease；远端作业在 intent 写入后以原 stable key 经 idempotent ensure/inspect 查询或接续；结果不确定时保持目标 BLOCKED；任务侧接收可信 evidence 并在合并树重新验证后发布 COMPLETE。每一步都有明确数据字段、存储时序和失败分支。**单独使用**这些组件多数属于既有技术；目前无法断言这一组合可获授权。

# 建议申请策略 / Recommended Filing Strategy
1. 立即由许达、王飞核对发明人实际创造性贡献、排名、所属单位和申请权；不要从示例模板复制他人的申请人及联系方式。
2. 核查 public GitHub 中最早向公众披露 A/C/E 核心组合的日期。原 `docs/release/FUTURE_CODE_PATENT_CN.md` 与专利目录原稿可能已披露部分内容；任何新公开版本继续增加失权风险。由专业代理人判断中国及境外法域适用规定。
3. 由代理人开展 USPTO/EPO/CNIPA/WIPO 正式检索，至少对照 CN120560815A、US20250356313A1、US20260127463A1、US12411758B1 及 2026-10-08 Temporal Pi 公开。逐项标注 X（单件高度抵触）、Y（结合抵触）、A（背景技术）风险，但本报告不擅自下最终检索类别结论。
4. 要求研发方提交四项最小可复现回归：提议载荷漂移/旧 fence 被拒；远端 UNKNOWN 经相同 key 的重复 ensure 仅有一份作业；adapter 丢失幂等保证时拒绝自动重发；局部 PASS 但强冲突/未决作业/合并检查失败时不能 COMPLETE。记录 commit、配置、环境和结果哈希。
5. 如果代理人认为总体组合缺乏单一性或创造性，优先探索窄 A+C+E 案；B/D 作为附加特征；HACT 需专项检索后再决定是否分案。不得把“无法停止”“绝对恰好一次”“比 Claude/Codex 快若干倍”等未经实测的效果写入权利要求。

# 结论 / Conclusion
补充检索与代码复核改变了旧稿对创新点 C 的风险判断：意图先行、UNKNOWN 状态及恢复前查询与 2026-10-08 Temporal Pi 公开高度接近；自主测试的独立规则验证亦见于 US12411758B1。Future-Code 的潜在可保护对象应限缩为以固定验收契约为中心，结合模型提议二次宿主准入、受远端幂等保证约束的稳定作业协调、未决作业/矛盾证据否决条件及合并树独立验收的具体技术过程。当前**既不能肯定新颖性，也不能确认创造性或自由实施**；公开源代码已增加优先日风险，应由专业代理人尽快作正式检索与申请策略判断。

报告准备日期：2026-10-09（复核版）。仅供研发与专利代理讨论，不构成法律意见或官方检索报告。
