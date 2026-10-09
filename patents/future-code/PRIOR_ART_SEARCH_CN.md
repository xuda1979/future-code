现有技术检索报告  
Prior Art Search Report  
**面向长期研发任务的证据驱动、自恢复智能体执行系统**  
编制日期：2026-10-09

# 检索参数 / Search Parameters
| 参数 / Parameter | 内容 / Value |
|---|---|
| 检索日期 / Search Date | 2026年10月9日 |
| 公开时间范围 / Period | 2008—2026年10月9日；重点2018—2026年 |
| 已实际使用渠道 / Sources | Google Patents 中 US/EP/CN/WO 公开页；Temporal、LangGraph、Bazel 官方文档；Future-Code GitHub 原始代码及技术报告 |
| 检索方式 / Method | 英中关键词组合检索、关联专利族交叉核验、正文及权利要求特征对比；人工筛选高相关文献 |
| 未完成核验 / Limitations | 未执行 USPTO、EPO、CNIPA 或 WIPO 官方数据库的穷尽检索；未核实所有同族案、审查档案和法律状态，不是 FTO 结论 |
| 待审查主题 / Claimed subject | 冻结验收契约+绑定提议的宿主授权+代际租约+远端作业协调优先+独立验证/最终集成的组合 |

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
## C1. 任务所有权、租约及恢复
资料：Temporal 的 Workflow/Activity 恢复、任务超时与事件历史（见 A2），以及通用分布式系统中的租约、代际/任期和 fencing 技术。后者属于成熟工程构件；本次检索尚未找到足以断言具体“租约代际”权利要求全新或已被全面覆盖的单一决定性专利。

与本发明的区别重点：宿主既校验 task fence/owner/deadline，又复核 proposal 与 contract/recipe/payload 的不可变绑定；动态 spawn 和结果写入受同一代际约束。仅声明“使用 fencing 防止迟到写入”很可能缺乏创造性。

## C2. 内容寻址计算及重试副作用
资料：Bazel Remote Execution API，https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto ；Bazel 远程缓存介绍，https://bazel.googlesource.com/bazel/+/refs/heads/staging/src/main/java/com/google/devtools/build/lib/remote/README.md 。

公开要点：由动作输入/命令的摘要标识可重复动作并缓存执行结果。与本发明的关系：稳定身份、可重复任务缓存均已知；训练/仿真等非幂等远程副作用只有在远端可查询稳定 key、且查询语义可靠时，协调优先策略才能阻止盲目再次提交。本申请不能把“所有操作 exactly-once”作为既成效果。

# D类：证据验证与研发自动化现有技术 / Category D: Evidence and R&D Automation Prior Art
## D1. AI 辅助软件生成与测试验证
专利：US20260211802A1，《Artificial Intelligence (AI) Assisted End-to-End Workflow Integration for Software Development in Digital Model Platforms》，2026年公开，https://patents.justia.com/patent/20260211802 。

公开要点：AI 生成脚本、测试脚本并执行测试生成验证报告。与本申请的重合度：中（独立测试/验证思想）；本申请的特定区别需进一步限定到跨任务版本、外部作业未决、强证据冲突和最终组合检查共同阻断目标完成的机制。

## D2. 可复用验证结果与自适应证据表示
资料：Bazel 的 action digest 与缓存规范（见 C2）；Future-Code 的 HACT 研究实现和代码（`src/hact/`）。增量验证、分层聚合、版本散列及证据树属于已知技术方向，不能仅凭“采用树结构”主张新颖。未来如对 completion hyperedge 学习、semantic/layout 分离及 generation fence 独立申请，须针对 Merkle 结构、增量构建、层次证据压缩及工作负载自适应布局开展更细粒度检索。现有公开材料仅支持条件性技术效果，不能证明所有场景比扁平台账更快。

# E类：专利检索结果 / Category E: Patent Search Results
## USPTO 检索结果
| 公开/授权号 | 名称简述 | 相关度 | 初步区分 |
|---|---|---|---|
| US20250356313A1 | AI 驱动多 Agent 任务管理 | 高 | 子任务与输出评价重合；未核实契约-租约-作业-证据联合门控 |
| US20260127463A1 | 模型驱动工作流编排 | 高 | 动态调整流程重合；本申请拟限定冻结规格及宿主复核 |
| US12481517B1 | AI agents orchestration | 中 | 代理路由、资源配置与负载优化；与外部作业验收闭环不同 |
| US12307349B2 | LLM 驱动任务专用 Agent 编排 | 中 | 多 Agent 协调公开；任务结果可信验收非其主要摘要要点 |

核查链接：https://patents.google.com/patent/US20250356313A1/en ；https://patents.google.com/patent/US20260127463A1/en ；https://patents.google.com/patent/US12481517B1/en ；https://patents.google.com/patent/US12307349B2/en 。以上法律状态应以官方记录为准。

## EPO 检索结果
| 公开号 | 名称简述 | 相关度 | 初步区分 |
|---|---|---|---|
| EP4742096A1 | Flow orchestration for model-based agents | 高 | 与 US20260127463A1 同族；不得按两件独立创新计数 |

核查链接：https://patents.google.com/patent/EP4742096A1/en 。本次仅核实该高相关欧洲公开，不能解释为欧洲检索无其他专利。

## CNIPA 检索结果
| 公开号 | 名称简述 | 相关度 | 初步区分 |
|---|---|---|---|
| CN120560815A | LLM 任务拆解及 DAG 编排 | 高 | 任务图与并行已公开 |
| CN121212278A | LLM 智能体自动编排 | 高 | 事件驱动监测、异常触发重规划已公开 |
| CN118819778A | 大模型智能体编排任务处理 | 高 | 任务拆解和工具执行已公开 |
| CN121523815A | 软件多智能体协同 | 中高 | 动态协同和依赖图公开，权利要求需避开概念覆盖 |

核查链接：https://patents.google.com/patent/CN120560815A/zh ；https://patents.google.com/patent/CN121212278A/zh ；https://patents.google.com/patent/CN118819778A/zh ；https://patents.google.com/patent/CN121523815A/zh 。WO2025076107A1 是另一个相关专利族，参见 https://patents.google.com/patent/WO2025076107A1/en 。

# 新颖性分析 / Novelty Analysis
## 创新点 A：提议绑定与执行前二次准入
已知部分：Agent 规划、工具权限和任务路由；建议主张的附加技术特征：run/task/fence/contract/recipe/payload 的散列绑定、追加式记录和副作用前复核。初评：组合具可检索的技术边界，但尚不能判定全球新颖性；需进一步检索“agent action capability / proposal authorization / binding”。

## 创新点 B：冻结父任务与原子化代际裂变
已知部分：动态 DAG 和租约。建议收窄至“不改写父任务规格 + request_key 去重 + 校验父租约及依赖范围 + 单事务追加 spawn edge”；初评：创造性风险中高，可能被视为已知事务/幂等性技术在 Agent 上的组合应用。

## 创新点 C：外部副作用协调优先恢复
已知部分：幂等键、作业查询、事件日志。建议保护的特定联系：提交意图先写入、UNKNOWN 状态、reconcile-first、未证实不存在则不可重发，以及目标完成门控对未决副作用的阻断。初评：可作为与 A/E 组合的较强特征；独立主张“幂等提交”风险高。

## 创新点 D：共享模型服务故障代际
已知部分：熔断器、指数退避、半开探测。具体特征：quota_pool 跨执行者共享 epoch，迟到成功不能清除新故障，冷却时释放工作槽。初评：更适合从属权利要求；单独创造性风险高。

## 创新点 E：独立证据和目标级验收门控
已知部分：CI 检查、独立验证、结果缓存。特定联动：冻结 checker 身份、工件证据、OPEN conflict、UNKNOWN external jobs、最终集成检查共同判定 COMPLETE。初评：与 C 联合较值得保护；仍需查证“agent verification gate”专利及文献。

## 创新点 F：语义/布局分离与 HACT
已知部分：证据树、内容寻址、增量计算。特定联动：稳定 check_id、layout_generation、completion hyperedge 验证样本优化且失败回退。初评：可能适合独立、较窄主题的后续申请，当前宜作为从属备选，避免与总体运行时发明单一性冲突。

# 可专利性评估 / Patentability Assessment
| 评估项 | 初步判断 | 主要风险 / 下一步 |
|---|---|---|
| 新颖性 | 尚不能认定；狭窄组合存在论证空间 | US/EP/CN 多件高相关专利，须逐项权利要求对照 |
| 创造性 | 中高风险 | DAG、熔断、fencing、检查点、幂等键均属常见技术，需证明不可直接推得的联动与技术效果 |
| 工业实用性 | 较明确 | 可在软件研发、仿真、训练平台部署，需给具体状态机/数据结构实现 |
| 充分公开 | 初步具备，待完善 | 提交意图时序、远端适配接口、冲突裁决、失败边界需研发方确认 |
| 专利客体 | 需技术化陈述 | 不能仅主张抽象“模型思考/规划”；强调计算资源、状态一致性及具体计算机处理步骤 |
| 申请权/公开风险 | 高优先级核验 | 现有 GitHub 公共材料已涉及专利内容，需锁定首次公开时间和权属 |
| 实证支撑 | 有代码及离线测试，广泛生产率效果未证实 | 避免“始终运行”“速度翻倍”“绝对不重复执行”等无证实措辞 |

# 权利要求差异化矩阵 / Claim Differentiation Matrix
| 权利要求要件 | 已知技术覆盖 | 建议强调的区别技术特征 | 风险 |
|---|---|---|---|
| LLM 多 Agent / DAG | CN120560815A、US20250356313A1 | 不作为独立创新点 | 高 |
| 动态编排 / 重规划 | EP4742096A1、CN121212278A | 冻结父契约、可验证宿主准入 | 高 |
| 持久事件与恢复 | Temporal、LangGraph | 提议-租约-外部作业-验收的跨层绑定 | 中高 |
| 远程作业 stable key | 通用幂等/缓存技术 | 意图先写 + UNKNOWN 协调 + 完成阻断 | 中 |
| 独立验证和证据 | CI、Bazel、US20260211802A1 | 冲突/外部作业/集成的联合 gate | 中高 |
| HACT 自适应布局 | 增量与层次证据相关技术 | 语义/布局隔离及旧 generation 拒绝 | 待专项检索 |

# 关键区别特征 / Key Distinguishing Features
建议独立方法权利要求优先保留这一完整因果链：①冻结目标、检查器和权限边界；②模型提出操作，宿主补全绑定并在副作用前二次核验；③父任务不可变、代际执行及可重放去重裂变；④外部作业提交意图先于网络副作用，UNKNOWN 时协调优先；⑤将未解决远程作业和矛盾证据列为目标级否决条件；⑥在集成环境复核所有工件后方可发布 COMPLETE。上述特征可形成可检查的状态不变量，但其整体是否具创造性尚不能以本次初检断言。

# 建议申请策略 / Recommended Filing Strategy
1. 尽快确认申请主体、发明人贡献和 GitHub 代码权属，整理最早版本、公开日志及内部发明完成日期；在后续公开扩散前咨询中国专利代理人。公开代码可能影响中外申请的新颖性，宽限期的适用范围与证据要求因司法辖区而异，不能默认可补救。
2. 先由代理人以独立权利要求1为核心进行中美欧及 PCT 正式检索；逐特征绘制 claim chart 并比对上述专利族全文、审查意见与法律状态。
3. 如整体权利要求面临单一性问题，可优先保留 A+B+C+E 的一致性及验收闭环；D 作为从属可选，F 如有充分算法创新与专项检索再考虑独立申请。
4. 研发方补充状态迁移伪代码、数据库约束、断线恢复实验、租约迟到写入负测、未知作业不重发测试、强证据冲突阻断测试和最终集成验证轨迹；所有效果使用可复现条件和实际测量。
5. 本报告为公开网页层面的初步检索，不能替代官方数据库复核、侵权自由实施（FTO）检索或正式法律意见。拟申请 PCT 等境外路径时须与代理人根据有效优先权日和披露时点确定期限。

# 结论 / Conclusion
本次初检明确发现了覆盖 LLM 任务分解、DAG、多智能体协调、动态工作流、持久化恢复和测试验证的相近公开，因此不能支持“首次提出多 Agent 协同”“首次实现自恢复”或“六项创新均未公开”等宽泛结论。Future-Code 更值得评估的申请主题，是冻结验收约束下的结构化提议准入、租约代际、远程不确定副作用协调和目标级独立验收的协同状态机。建议按窄而可实施的组合保护路径继续尽职检索与实证补强，现阶段可作为技术交底与代理人讨论材料，不应直接视作可授权性保证。

报告准备日期：2026-10-09。以上检索记录与法律分析仅供研发及专利代理讨论，正式结论应以审查官方公开文本、法律状态和专业意见为准。
