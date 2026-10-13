现有技术检索报告
Prior Art Search Report
**研发智能体外部作业协调及完成控制**
修订日期：2026-10-13
编制单位：中国移动通信有限公司研究院（中国移动研究院）
编制人员及对应发明人：许达、王飞

# 检索参数 / Search Parameters
| 参数 / Parameter | 内容 / Value |
|---|---|
| 检索日期 / Search Date | 2026-10-13（补充检索及代码复核） |
| 公开时间范围 / Period | 检索截止2026-10-13，不限定起始年份；本案申请日或有效优先权日尚待院内核定 |
| 已核查来源 / Verified Sources | Google Patents 的 US/EP/CN 文献正文及独立权利要求、同族链接；Temporal、LangGraph、Bazel 与 AutoGen 原始资料；CNIPA 法律及审查指南；Future-Code 代码及现有测试 |
| 检索方法 / Method | 公开号及标题复核、英文/中文关键词组合、同族识别、与拟议独立权利要求的逐要件人工对照 |
| 未完成事项 / Limitations | 未执行各国官方数据库的穷尽检索；部分公开仅完成摘要及独立权利要求层级核查；同族全量、审查档案、法律状态、FTO 均待代理人正式复核 |
| 拟保护主题 / Subject | 冻结验收契约下的模型提议双重准入、稳定远端作业幂等确保、未决副作用及证据的目标级完成阻断 |
| 对应交底书版本 | 2026-10-13 修订版；发明人许达、王飞；所属单位中国移动研究院；重点 A+C+E，B/D 为从属，F 不列入本案拟议权利要求 |

## 使用的关键词 / Keywords Used
英文：AI agent orchestration; large language model agent; task DAG; workflow checkpoint; durable execution; model-driven multi-agent; lease fencing; stale worker; idempotent job; reconciliation; external side effect; verification evidence; autonomous software development; certificate tree; incremental verification; agent recovery。

中文：大语言模型 智能体任务编排；动态 DAG；任务恢复；多智能体协同；租约代际；迟到写入；远程作业幂等；不确定提交；机器验证；代码集成验收；证据图谱；检查项增量更新。

## 检索记录与判读口径
本报告的 A—E 是内容分组，与专利局检索报告中表示文献相关性的 X、Y、A 类别没有对应关系。表中的高、中风险表示与候选特征的技术接近程度及后续核查优先级，不是授权概率或官方结论。新颖性应按单一对比文献的完整公开判断；多篇文献的组合问题属于创造性评价，不能混用。

2026-10-13 执行下列公开网页查询，并逐件打开本文列出的专利文献，核对标题、公开日期及所引权利要求。该记录不是官方数据库的全量检索式或命中统计。

| 检索渠道 | 实际使用的查询或直接核查 |
|---|---|
| 公开网页检索 | site.cnipa.gov.cn 2026 专利审查指南 人工智能 算法 技术问题 技术效果 |
| 公开网页检索 | site.patents.google.com patent multi agent coding evidence version lease validation context compression |
| 题名及公开号核查 | CN120560815A；The immortal life of Pi；按原报告各公开号逐件访问 |
| 法律及单位名称核查 | site.cnipa.gov.cn 专利法 第二十二条 第二十四条 第二十六条 2020；中国移动通信有限公司研究院 |

本次复核代码基线：`249b8ccafee935a66accab3ae37c65742b11ecd3`。已运行七个现有测试文件共103项，全部通过；属于宿主及受控适配器行为证据，不是专利新颖性证据。无明确历史版本时间戳的滚动产品文档仅作为技术背景，不能仅凭本次访问时间认定其在本案有效申请日前公开。

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
专利：CN120560815A，《一种基于大语言模型的任务拆解与多智能体编排执行系统及方法》，记录的优先权日2025-06-26，公开日2025-08-29；重点核查权利要求1、6—10。https://patents.google.com/patent/CN120560815A/zh 。

公开要点：权利要求1列出任务解析、DAG构建、资源并发调度和缓存优化；其余权项补充节点元信息、线程并发、异步执行和调试监控。与本申请的重合度：高（动态任务图和多智能体并行）；可能区别：在已核查权利要求中未定位到本案完整的授权绑定—远端未知作业—最终集成再检查链路；这不等于排除说明书其他段落或其他文献的公开。

## B2. 模型驱动动态工作流调整
专利族：US20260127463A1 / EP4742096A1，《Flow orchestration for model-based agents》，优先权日2024-11-07，分别于2026-05-07与2026-05-13公开，https://patents.google.com/patent/US20260127463A1/en 、https://patents.google.com/patent/EP4742096A1/en 。

公开要点：权利要求1记载多步多轮智能体工作流、取得部分数据后由生成式模型调整工作流；权利要求4细化智能体顺序调整。与本发明的重合度：中高（动态编排）；区别主张须强调：原已准入父任务规格不变、宿主根据散列与租约复核、模型不能改变验收边界。该专利族对广义“自适应 Agent 计划”权利要求形成直接挑战。

## B3. 生成式 AI 指导的多智能体任务管理
专利：US20250356313A1，《Multi-agent task management guided by generative artificial intelligence》，公开日2025-11-20，记录的优先权日2024-05-20；核查权利要求1及任务完成流程说明。https://patents.google.com/patent/US20250356313A1/en 。

公开要点：任务管理 Agent、执行 Agent、子任务创建、AI 输出评价与上下文更新。与本发明重合度：高（任务分解、执行、结果评价）；潜在区别需具体落到外部作业提交前意图、UNKNOWN 协调和目标完成的机器验收条件。不得将“模型与任务管理分层”单独作为新颖性结论。

# C类：执行可靠性与协议现有技术 / Category C: Reliable Execution and Protocol Prior Art
## C1. 通用租约、事务与任务重放
Temporal 的事件历史和 Activity 重试、通用分布式锁 fencing token、事务性唯一键及退避机制均属于已知工程手段。原交底书把租约代际、事件存储与重试本身称为创新容易被质疑。需具体比较的是模型提议载荷与当前 fence、冻结契约的反复绑定及其与外部作业的同一目标门控。

参考：https://docs.temporal.io/encyclopedia/event-history ；https://docs.temporal.io/evaluate/understanding-temporal 。上述滚动文档的精确历史公开时点需另查存档，不能代替申请日前公开证据。

## C2. 内容寻址、幂等键与远端副作用
Bazel Remote Execution API 以输入摘要识别动作并支持远程缓存；内容寻址不等于远端物理作业具有幂等提交保证；Temporal 亦指出 Activity 重试需依赖外部接口的幂等性。稳定 key 和“重试安全”本身不足以支持宽泛权利要求。Future-Code 代码实际要求远程 job adapter 具备 idempotentEnsure：未知 job_id 时发送 ensure(key)，已知 job_id 时发送 inspect(jobId)，由远端保证重复 ensure 仅接续同一个作业；若远端不履约，仅凭本地日志不能提供 exactly-once。

参考：https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto ；https://temporal.io/blog/saga-pattern-made-easy 。

**接近本申请的智能体未知结果恢复公开（重点风险）：** Temporal 于 **2026-10-08** 发布《The immortal life of Pi (Running the Pi coding agent on Temporal)》，介绍执行工具前留下 pending 声明、执行中断后对结果标记 UNKNOWN、不自动重放工具调用，并让恢复后的 Agent 先确认外部状态。该公开与交底书技术特征 C 的“先登记意图、不确定不盲目重试”高度接近。未来差异化只能具体落在远端作业适配器的 **idempotent ensure/inspect 契约、稳定绑定键、冻结目标级验收和持续冲突阻断** 的联动；即使如此，也不能排除该公开与 C1/C2 结合后导致创造性不足。

核查：https://temporal.io/blog/the-immortal-life-of-pi-running-the-pi-coding-agent-on-temporal （发布日期 2026-10-08）。

# D类：证据验证与研发自动化现有技术 / Category D: Evidence and R&D Automation Prior Art
## D1. 自主软件测试与独立验证专利
US12411758B1，《Autonomous software testing agent》，2025-09-09 授权公开。权利要求1(b)将通用验证规则与测试脚本区分，规则由自治代理使用；该要件没有直接要求另一个执行者之外的独立检查进程。原报告把两者概括为同一种“独立验证”过宽，现更正。该文献仍说明自治测试及规则化结果校验已有公开。Future-Code 候选区别在于工件/检查器版本绑定、未解决外部作业、强证据冲突和合并树最终检查共同阻断目标完成。

核查：https://patents.google.com/patent/US12411758B1/en 。

## D2. AI 生成软件及其测试流程
US20260211802A1，《Artificial Intelligence (AI) Assisted End-to-End Workflow Integration for Software Development in Digital Model Platforms》，公开日2026-07-23。权利要求1涉及数字模型平台、不可直接互操作工具、微调脚本代理、生成函数及单元测试并解释执行测试。其具体平台和微调限定不能略去；对宽泛“AI代码生成并测试”的主张构成相关背景。本申请必须进一步限定一致性控制、提交意图及外部作业验收条件。

核查：https://patents.google.com/patent/US20260211802A1/en 。

**HACT 的证据层次布局：** Merkle 树、层次证据摘要、增量计算、缓存与内容寻址已广泛公开。Future-Code 的 stable check_id、generation-fenced publication ticket 和 completion hyperedge 布局选择需另行对照证据索引/层次更新/自适应布局文献。当前未完成该主题的专项专利检索，也无充分 live-WAN/在线大模型实证证明普适性能优势；本次从拟议权利要求11—12移出，作为后续单独主题；对应位置改为目标修订谱系及完成记录重放。

# E类：专利检索结果 / Category E: Patent Search Results
## USPTO 检索结果
下表指**美国公开专利文献**；核查工具为 Google Patents 镜像，未声称完成 USPTO 官方站点的检索。

| 公开或授权号 | 主题 / 已公开核心特征 | 风险 | 与本申请可核查的剩余区别 |
|---|---|---|---|
| US20250356313A1 | 多 Agent 任务管理、子任务创建及结果评价；2025-11-20 公开 | 高 | 验收契约—远端任务 UNKNOWN—最终集成的联合门控需逐权项比对 |
| US20260127463A1 | 模型动态调整多 Agent 工作流；2026-05-07 公开 | 高 | 冻结父任务与副作用前租约复核，不能泛称动态 DAG 新颖 |
| US12481517B1 | AI Agent 调度、资源扩缩容；2025-11-25 授权 | 中 | 本申请不以资源编排本身为创新 |
| US12307349B2 | LLM驱动任务专用代理，权利要求1限定金融工具数据及对抗式纠正；2025-05-20授权 | 中 | 编排与结果修正相关，但不能省略其领域及模型限定来断言抵触 |
| US12411758B1 | 自主测试、通用验证规则与脚本区分；2025-09-09授权 | 中 | 不等同于本案外部独立检查器，仍需比较验收链路 |
| US20260211802A1 | 数字模型平台上的脚本及测试生成；2026-07-23公开 | 中 | 本案没有其工具互操作和脚本代理微调限定；技术背景相关 |

核查：https://patents.google.com/patent/US20250356313A1/en ；https://patents.google.com/patent/US20260127463A1/en ；https://patents.google.com/patent/US12481517B1/en ；https://patents.google.com/patent/US12307349B2/en ；https://patents.google.com/patent/US12411758B1/en ；https://patents.google.com/patent/US20260211802A1/en 。

## EPO 检索结果
| 公开号 | 公开日期 | 风险及同族关系 |
|---|---|---|
| EP4742096A1 | 2026-05-13 | 与 US20260127463A1 同一相关专利族；已公开模型驱动工作流重编排 |

核查：https://patents.google.com/patent/EP4742096A1/en 。本节不表示没有其他相关欧洲公开。

## CNIPA 检索结果
以下为中国公开专利文献，借助 Google Patents 核查，不代表官方 CNIPA 全量检索。

| 公开号 | 公开日期 | 定位及核查特征 | 技术接近风险 |
|---|---|---|---|
| CN120560815A | 2025-08-29 | 权利要求1，LLM任务拆解、DAG并发与缓存 | 高，对宽泛编排主题 |
| CN121212278A | 2025-12-26 | 权利要求1、6—8，事件监控、异常诊断及局部重规划 | 高，对自动恢复主题 |
| CN118819778A | 2024-10-22 | 权利要求1，子任务转换为执行对象并构建DAG执行器 | 高，对DAG执行主题 |
| CN121523815A | 2026-02-13 | 权利要求1，依赖图、双层图注意力调度、模型冲突消解和结果融合 | 中，对本案宿主完成控制 |
| CN120973500A | 2025-11-18 | 权利要求1、6，外部状态驱动工具循环、终止条件及可审计归档 | 高，对持久代理循环主题 |

核查：https://patents.google.com/patent/CN120560815A/zh ；https://patents.google.com/patent/CN121212278A/zh ；https://patents.google.com/patent/CN118819778A/zh ；https://patents.google.com/patent/CN121523815A/zh ；https://patents.google.com/patent/CN120973500A/zh 。CN120973500A 的后续授权文献为 CN120973500B（2025-12-23）；法律状态和有效权利要求仍须通过官方档案复核。

**同族更正：** WO2025076107A1 与 US12307349B2 属 Google Patents 所列相关家族，但家族相关不表示权利要求完全相同。US12307349B2 权利要求1含金融数据限定，不能直接外推到所有同族案。核查：https://patents.google.com/patent/US12307349B2/en 。

# 新颖性分析 / Novelty Analysis
## 候选特征 A：提议散列绑定与副作用前再核验
已知：模型工具调用、权限管理和持久记录。候选限定：宿主同时绑定 run/task/fence/contract/recipe/payload，先记录准入，再在副作用边界以当前租约重检。新颖性判断：**未确认**，需补查授权提议及能力票据有关专利；创造性风险为中高。

## 候选特征 B：原子裂变与父规格冻结
已知：DAG、动态重规划、分布式租约、幂等事务。候选限定：父规格不改写、request_key+hash 重放检查与父租约/作用域在同一事务内验证。创造性风险：**高**，适合作为系统组合中的从属细化。

## 候选特征 C：幂等 ensure/inspect 与未知作业阻断
已知：副作用意图/结果日志、幂等键、未知结果先查（特别是 Temporal 2026-10-08 公开）。候选限定：本地 research_jobs 双重身份绑定；适配器 idempotentEnsure；未知 job_id 用 ensure、已知用 inspect；未终结作业阻断目标 PASS。初评：**高度接近现有技术，单独授权风险高**，应放进 A+E 跨层链路。

## 候选特征 D：服务池 epoch 熔断与槽位释放
已知：熔断、退避、半开探测及代际。候选限定：quota_pool 共享 epoch、防迟到成功清除新故障、等待释放工作槽。初评：独立创造性风险**高**；从属备选。

## 候选特征 E：外部作业、冲突与集成的联合验收
已知：机器测试、CI门控、结果聚合及自治测试规则。US12411758B1没有直接建立执行者之外的独立检查器，不据此单件否定本案独立检查要件。候选限定：授权绑定和远端作业身份维持同一目标关联；在集成前后核查任务接受证据、证据冲突、失效主张及当前和历史修订运行中的未决作业，持久保存完成记录。初评：仍有较具体的组合论证空间，但尚未检索充分到可以作出新颖/非显而易见结论。

## 候选特征 F：证据语义与层次布局隔离
已知：内容寻址、哈希树、增量验证。候选限定：稳定检查身份、布局代际隔离及 completion hyperedge 验证样本上的布局选择。当前检索不足以给出可靠的新颖性结论；若另案申请应补充数学规范与独立对照实验。

# 可专利性评估 / Patentability Assessment
| 评估项目 | 复核意见 | 建议动作 |
|---|---|---|
| 新颖性 | 仍未知；多项要件已公开，不能宣称任何一项全球首次 | 优先以修订后的权利要求1逐段核对更早公开 |
| 创造性 | **高风险**；Temporal Pi 与现有 AI Agent 专利显著缩小 C/E 的独立差异 | 围绕完整跨层状态门控、实际故障负测及不可替代的技术效果论证 |
| 充分公开 | 已补数据字段、请求/响应、失败分支及接口契约；仍依赖远端履约 | 按专利法第26条核验具体可实施性，不能以一个配置标志证明真实去重 |
| 工业实用性 | 有代码和执行流程基础 | 保留部署假设、数据结构及异常状态迁移实例 |
| 单一性 | 本次权利要求集中于外部作业协调及完成控制 | B/D限于支持主流程；F从本案拟议权利要求移出 |
| 技术方案及创造性评价 | 面向数据库、远端计算和工件检查的计算机执行问题 | 依2026年生效审查指南整体评价相互作用和效果，不以组件数量证明创造性 |
| 权利归属 | 发明人为许达、王飞，所属单位中国移动研究院 | 按院职务发明流程核定正式申请主体及是否共同申请，不混淆所属单位与申请权 |
| 公开时点 | 仓库可公开访问；旧专利文件已有历史提交 | 提交时间不等于实际公开时间，按技术特征核查首次公众可获取证据及有效申请日 |
| 效果证据 | 103项现有测试通过；没有真实远端或跨平台生产力比较 | 仅用于支持实现与故障处理，不推导固定加速倍数或无条件恰好一次 |

## 中国申请要求与公开时间风险
依据《中华人民共和国专利法》第二十二条，新颖性与创造性以本案有效申请时间及具体公开内容判断；第二十六条要求说明书充分公开、权利要求有依据。2026-01-01 生效的《专利审查指南》修改要求整体评价技术方案，并考虑与技术特征存在相互作用的算法特征。本案论证应落在持久状态、调用时序和计算资源重复消耗，不能只写“智能”“自恢复”或管理效率。

中国专利法第二十四条的六个月例外有特定适用情形，普通自愿上传 GitHub 并不自动获得通用宽限期。未核定本案申请日以前，不应断言某篇2026年资料已经构成可适用现有技术；同样，不能因尚未检索到完整组合就认定可授权。

已核查的 Git 记录中，`cadc093b7819d30ba42118ce9fc48a4bb5dd13c9` 于2026-10-08 12:50:15 +08:00加入旧发布专利文档；`44a5aad63b85a52c8a99ef56d765fd775c49eafd` 于2026-10-09 13:09:59 +08:00加入当前目录交底书；上一轮修订记录为2026-10-10。上述为仓库提交时间，不能证明对应字节在该时刻已向公众开放，也不是最早技术公开或专利优先权的认定。应进一步收集推送、合并、仓库可见性记录及更早代码公开，并逐要件映射。

法律及审查依据：
https://www.cnipa.gov.cn/art/2020/11/23/art_97_155167.html
https://www.cnipa.gov.cn/art/2025/11/13/art_74_202560.html

历史提交：
https://github.com/xuda1979/future-code/commit/cadc093b7819d30ba42118ce9fc48a4bb5dd13c9
https://github.com/xuda1979/future-code/commit/44a5aad63b85a52c8a99ef56d765fd775c49eafd

# 权利要求差异化矩阵 / Claim Differentiation Matrix
| 修订权利要求1要件 | 已知最接近技术 | 待论证的组合限定 | 代码参照 |
|---|---|---|---|
| 冻结验收契约 | Temporal/LangGraph、CI | 提议和副作用整个周期绑定契约/配置 | `src/harness/foundry/store.ts` |
| 结构化提议双校验 | 多 Agent 编排、权限控制 | proposal hash+当前 fence 双边界校验 | `src/harness/foundry/proposals.ts` |
| 远端 UNKNOWN/稳定 key | Temporal Pi、Bazel、幂等 Activity | `idempotentEnsure` 与 `inspect` 的两种状态路径，身份不可漂移 | `src/harness/foundry/swarm/jobs.ts` |
| 未解决结果阻断完成 | 测试门控、持久工作流 | 当前及历史修订作业、冲突和失效主张联合核查 | `src/harness/foundry/swarm/supervisor.ts` |
| 合并树最终检查 | 现有CI、AI脚本与测试生成 | 集成前后重查门控，缓存回执仍核验工件证据 | `src/harness/foundry/swarm/host.ts` |
| 原子裂变（从属） | CN120560815A、US20260127463A1 | 父规格冻结+唯一请求+同事务父 lease 校验 | `src/harness/foundry/dynamicDag.ts` |
| 模型服务恢复（从属） | 既有熔断器 | 资源池 epoch 和旧成功回复拒绝 | `src/harness/foundry/swarm/providerRecovery.ts` |

# 关键区别特征 / Key Distinguishing Features
建议专利代理人优先论证**同一目标契约下的跨故障域状态一致性**：模型侧结构化提议不能直接越权执行；执行侧在副作用边界重验 lease；远端作业在 intent 写入后以原 stable key 经 idempotent ensure/inspect 查询或接续；结果不确定时保持目标 BLOCKED；任务侧接收可信 evidence 并在合并树重新验证后发布 COMPLETE。这里的相互作用是：租约不能判定远端结果；远端终态不能替代工件接受证据；局部通过不能替代组合树检查；新运行不能清除旧作业。这为整体技术效果提供可检验的论证对象，但仍需查明现有技术是否已有组合启示。不能以增加门控数量或限定更多字段直接证明创造性。

# 建议申请策略 / Recommended Filing Strategy
1. 由院知识产权管理部门按职务发明流程核定正式申请主体、申请日及共同申请安排；发明人按许达、王飞列示，所属单位为中国移动研究院。个人联系方式仅在内部申报材料填写。
2. 核查 public GitHub 中最早向公众披露 A/C/E 核心组合的日期。原 `docs/release/FUTURE_CODE_PATENT_CN.md` 与专利目录原稿可能已披露部分内容；提交时间及公有仓库现状不足以确定当时可获取性。依中国申请规则核查是否已有在先申请及特定例外；不能默认普通GitHub公开适用六个月宽限。
3. 由代理人开展 USPTO/EPO/CNIPA/WIPO 正式检索，至少对照 CN120560815A、US20250356313A1、US20260127463A1、US12411758B1、CN120973500A 及 2026-10-08 Temporal Pi 公开，并核对适用公开日。逐项标注 X（单件高度抵触）、Y（结合抵触）、A（背景技术）风险，但本报告不擅自下最终检索类别结论。
4. 已有103项相关测试通过；继续由研发方在真实适配器上保存四类最小故障复现：提议载荷漂移/旧 fence 被拒；远端 UNKNOWN 经相同 key 的重复 ensure 仅有一份作业；adapter 丢失幂等保证时拒绝自动重发；局部 PASS 但强冲突/未决作业/合并检查失败时不能 COMPLETE。记录 commit、配置、环境和结果哈希。
5. 如果代理人认为总体组合缺乏单一性或创造性，优先探索窄 A+C+E 案；B/D 作为附加特征；HACT需专项检索后决定另案布局；本次已从拟议权利要求移出，不以分案替代原申请充分公开要求。不得把“无法停止”“绝对恰好一次”“比 Claude/Codex 快若干倍”等未经实测的效果写入权利要求。

# 结论 / Conclusion
本次修订将申请主题集中于“授权绑定—稳定外部作业协调—目标完成再检查”的具体计算机执行流程，发明人列为许达、王飞，所属单位为中国移动研究院。与泛化的多智能体编排相比，潜在区别在于同一目标关联记录对跨故障域状态的约束，而不是DAG、幂等键或测试的单独使用。

Temporal Pi 对意图先行、未知结果和迟到写入已有接近公开；多件中国和美国文献公开编排、持久循环及自动测试。US12411758B1 的通用验证规则不等同于本案外部独立检查器；US12307349B2 和 US20260211802A1 的特定领域和平台限定已补回，避免过度概括。当前检索没有形成可确认新颖性或创造性的完整证据链，亦未开展自由实施分析。可实施性已由代码、明确接口契约及103项受控测试增强，授权判断仍需结合正式申请日、全文检索和院内申请权核定。

报告准备日期：2026-10-13。供中国移动研究院研发及知识产权管理流程使用；属于初步技术检索分析，不是官方检索报告或正式法律意见。
