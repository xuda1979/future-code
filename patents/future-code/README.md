# Future-Code 专利资料

修订日期：2026-10-13。编制单位为中国移动通信有限公司研究院（中国移动研究院），发明人为**许达、王飞**。所属单位已明确，正式申请主体及共同申请安排按院职务发明管理流程核定。

拟议主题：**一种研发智能体的外部作业协调及完成控制方法**。核心是授权绑定、稳定远端作业协调与目标完成再检查的相互约束。

| 文件 | 用途 |
|---|---|
| [INVENTION_DISCLOSURE_CN.md](INVENTION_DISCLOSURE_CN.md) | 保留原十一项一级章节的交底书源文稿，13项拟议权利要求 |
| [INVENTION_DISCLOSURE_CN.docx](INVENTION_DISCLOSURE_CN.docx) | 可编辑Word交底书，包含三幅实际流程图及关键修订批注 |
| [PRIOR_ART_SEARCH_CN.md](PRIOR_ART_SEARCH_CN.md) | 保留原十二项一级章节的初步检索报告源文稿 |
| [PRIOR_ART_SEARCH_CN.docx](PRIOR_ART_SEARCH_CN.docx) | 可编辑Word检索报告，引用使用真实文献链接 |
| [REVIEW_20261013.md](REVIEW_20261013.md) | 十项审阅问题、处理依据、源代码定位及103项测试结果 |
| [export_docx.py](export_docx.py) | 从源文稿重建两份Word文件；需要python-docx、Pillow及Noto Sans CJK SC字体 |

本次修订纠正了对验证专利及特定领域权利要求的过度概括，补充远端接口契约、历史修订作业门控、集成前后核验及完成记录重放。HACT布局优化留作后续专项主题，不列入本案拟议权利要求。

代码复核基线为 `249b8ccafee935a66accab3ae37c65742b11ecd3`。七个相关现有测试文件共103项通过、0项失败。测试仅支持受控宿主及适配器行为，不证明真实模型生产力或专利可授权性。

Word文件按A4、正文11pt排版，交底书9页、检索报告9页，18页均已逐页渲染核对附图、表格、中文字体及分页。目录内的Word文件与本次源文稿对应；旧稿中“二进制Word无法提交”的说明不再适用。

这些资料用于院内研发与知识产权工作，不是正式申请文件、官方检索报告或自由实施意见。检索报告列明现有技术、实际公开时间和申请日尚需核定的具体事项。旧文件 `docs/release/FUTURE_CODE_PATENT_CN.md` 保留为历史材料，当前交底书与检索报告以本目录为准。
