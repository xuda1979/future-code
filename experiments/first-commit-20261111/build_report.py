from pathlib import Path
import json
import sys
import subprocess
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
s = json.loads((ROOT / 'summary.json').read_text())

cjk_path = subprocess.check_output(['fc-match', '-f', '%{file}', 'Noto Sans CJK SC'], text=True).strip()
font_manager.fontManager.addfont(cjk_path)
cjk_name = font_manager.FontProperties(fname=cjk_path).get_name()
plt.rcParams.update({'font.family': cjk_name, 'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
fig, ax = plt.subplots(1, 2, figsize=(9.5, 2.55), gridspec_kw={'width_ratios': [1, 1.15]})
colors = ['#7D8995', '#176A70']
ax[0].barh(['初版', '现版'], [121713/1000, 35219/1000], color=colors, height=.48)
ax[0].invert_yaxis(); ax[0].set_xlim(0, 155); ax[0].set_xlabel('准备交给模型的数据量（千字节）')
ax[0].set_title('相同代码审查输出，数据量减少71.1%', fontsize=11, loc='left', pad=15)
for i, v in enumerate([121.713, 35.219]): ax[0].text(v+2, i, f'{v:.1f}', va='center', fontsize=10)
for offset, label, vals, color in [(-.17, '初版', [164, 33], colors[0]), (.17, '现版', [164, 164], colors[1])]:
    bars = ax[1].bar([offset, 1+offset], vals, width=.32, label=label, color=color)
    for bar in bars: ax[1].text(bar.get_x()+bar.get_width()/2, bar.get_height()+4, str(int(bar.get_height())), ha='center', fontsize=10)
ax[1].set_xticks([0,1], ['正常运行', '人为触发一次故障']); ax[1].set_ylim(0, 230)
ax[1].set_ylabel('通过检查的程序数（共164段）')
ax[1].set_title('执行已给定正确答案的程序', fontsize=11, loc='left', pad=15)
ax[1].legend(frameon=False, loc='upper center', bbox_to_anchor=(.52, 1.01), ncol=2, fontsize=8)
fig.tight_layout(w_pad=2)
chart = OUT / 'runtime_comparison.png'; fig.savefig(chart, dpi=200, bbox_inches='tight'); plt.close(fig)

doc = Document(); section = doc.sections[0]
section.page_width = Inches(8.5); section.page_height = Inches(11)
section.top_margin = Inches(.64); section.bottom_margin = Inches(.62)
section.left_margin = section.right_margin = Inches(.7)
for name in ['Normal', 'Title', 'Heading 1', 'Heading 2']:
    style = doc.styles[name]; style.font.name = 'Noto Sans CJK SC'; style.font.color.rgb = RGBColor(0,0,0)
    style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Noto Sans CJK SC')
doc.styles['Normal'].font.size = Pt(10.5)
doc.styles['Normal'].paragraph_format.space_after = Pt(6)
doc.styles['Normal'].paragraph_format.line_spacing = 1.1
doc.styles['Title'].font.size = Pt(21)
doc.styles['Title'].paragraph_format.space_after = Pt(9)
doc.styles['Heading 1'].font.size = Pt(13)
doc.styles['Heading 1'].paragraph_format.space_before = Pt(10)
doc.styles['Heading 1'].paragraph_format.space_after = Pt(6)

def para(text, bold=False, small=False):
    p = doc.add_paragraph(); r = p.add_run(text); r.bold = bold
    if small: r.font.size = Pt(9)
    return p

def table(headers, rows, widths):
    t = doc.add_table(rows=1, cols=len(headers)); t.alignment = WD_TABLE_ALIGNMENT.CENTER; t.autofit=False
    for i, width in enumerate(widths): t.columns[i].width = Inches(width)
    for i, h in enumerate(headers): t.rows[0].cells[i].text = h
    repeat = OxmlElement('w:tblHeader'); t.rows[0]._tr.get_or_add_trPr().append(repeat)
    for values in rows:
        for cell, value in zip(t.add_row().cells, values): cell.text=str(value)
    for ridx, row in enumerate(t.rows):
        for i, cell in enumerate(row.cells):
            cell.width = Inches(widths[i]); cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
            tc = cell._tc.get_or_add_tcPr()
            shd=OxmlElement('w:shd'); shd.set(qn('w:fill'), 'E7EEF1' if ridx==0 else 'FFFFFF'); tc.append(shd)
            borders=OxmlElement('w:tcBorders')
            for edge in ['top','bottom','left','right']:
                el=OxmlElement('w:'+edge); el.set(qn('w:val'),'single'); el.set(qn('w:sz'),'4'); el.set(qn('w:color'),'D9D9D9'); borders.append(el)
            tc.append(borders)
            margins=OxmlElement('w:tcMar')
            for side in ['top','left','bottom','right']:
                el=OxmlElement('w:'+side);el.set(qn('w:w'),'85');el.set(qn('w:type'),'dxa');margins.append(el)
            tc.append(margins)
            for p in cell.paragraphs:
                p.paragraph_format.space_after=Pt(1);p.paragraph_format.line_spacing=1.06
                p.alignment=WD_ALIGN_PARAGRAPH.LEFT if i==0 else WD_ALIGN_PARAGRAPH.CENTER
                for r in p.runs: r.font.size=Pt(9.5);r.bold=ridx==0
    return t

doc.add_paragraph('Future Code 初版与现版对比测试报告', 'Title')
para('2026年11月11日', small=True)
para('本轮测试确认了两项具体改进：处理大量工具输出时，现版准备交给模型的数据更少；工具出错后，现版能更完整地记录结果，并继续后续操作。整体研发效率提高了多少，本轮尚未测出。')
para('测试直接运行两个版本的相关代码，未接入大模型。这样可以单独检查程序改进的效果。共进行了114次正式运行，其中包含重复测试，不代表114项不同的研发任务。')
para('初版为项目首次提交b1f9d186（2026年9月18日）；现版为main分支ac378921（2026年11月10日）。测试未修改两版的生产代码。', small=True)
doc.add_paragraph('测出了哪些改进', 'Heading 1')
table(['测试内容', '初版', '现版'], [
    ('同一批代码审查输出，处理后准备交给模型的数据量', '121,713字节', '35,219字节'),
    ('输出较少时，同样统计数据量', '25,689字节', '25,689字节'),
    ('5种人为设置的工具故障，通过预定检查的场景数', '0/5种', '5/5种'),
    ('正常执行164段已有正确答案的程序', '164段均通过', '164段均通过'),
    ('执行同一批程序时，人为触发一次返回结果的故障', '执行33段后退出', '执行完全部164段')], [3.15,1.95,2.0])
doc.add_picture(str(chart), width=Inches(7.05))
doc.paragraphs[-1].paragraph_format.space_before = Pt(5)
para('每项主要对照均重复4次。程序来自HumanEval数据集，直接使用其标准答案；本轮只检查执行过程，不评模型编程能力。', small=True)
para('71.06%的降幅来自第一项测试：相同的审查输出经两个版本处理后，统计准备好的模型输入数据量。完整输出另存为文件，逐份核对后均与原文一致。这个数字不能直接换算成token或费用节省，也不能说明所有任务都能提速。', small=True)

doc.add_page_break()
doc.add_paragraph('工具出错后，两版有什么不同', 'Heading 1')
para('先写明通过标准，再人为触发故障。检查三件事：每次操作是否留下成功或失败的记录，已完成的文件操作是否正确，后续能否读取实际结果。每种故障重复4次。')
table(['人为设置的故障', '初版表现', '现版表现'], [
    ('操作尚未返回结果时出错', '程序退出', '记录错误，后续读取正常'),
    ('文件写完后，返回结果时出错', '程序退出', '保留文件和错误记录，后续读取正常'),
    ('文件已写完，但没有返回结果', '后续能读文件，\n原操作缺少结果记录', '补充错误提示，后续读取正常'),
    ('整理工具返回结果时出错', '程序退出', '保留结果并提示错误，后续读取正常'),
    ('执行前检查工具参数时报错', '调用未正常处理', '进入正常报错流程，后续读取正常')], [2.5,1.8,2.8])
para('在正常操作和普通工具报错两项对照中，两版均4次通过。初版在“没有返回结果”的场景中仍能继续读取，不能笼统地说初版遇到故障就会停止。人为故障测试也不能用于推算实际任务的故障率。', small=True)
doc.add_paragraph('测试方法与结论范围', 'Heading 1')
para('两版使用同一台机器、同一批输入和同一套检查程序。初版原有的搜索、并行执行和输出保存功能均予保留。统计模型输入前，两边都先应用Bash原有的30,000字符单工具输出上限，避免人为放大初版的数据量。')
para('现版增加了批量输出处理步骤，所测本地处理时间的中位数为2.741毫秒，初版为0.045毫秒。正常执行164段程序，两版分别用时约5.067秒和5.209秒。这些短时测试不足以判断一般任务的耗时变化。', small=True)
para('完整智能体评测应让系统实际完成任务，再独立检查结果。SWE-bench用项目测试验收智能体提交的修改，Inspect分别记录执行过程、评分和日志[1][2]。本轮未接入模型，只验证运行机制，尚不能给出完整智能体的基准成绩。')
doc.add_paragraph('下一步怎样证明整体研发效率提高', 'Heading 1')
para('两版接入同一模型，在相同时间、费用和工具权限下完成同一批新任务，由独立测试判定是否完成。失败、重试、验证和人工介入都计入成本，比较任务完成率、完成时间和实际费用。详细方案见仓库评测方法说明。')
para('考核材料可表述为：已完成Future Code初版与现版的运行机制对比。在所测场景中，现版准备交给模型的数据量减少71.06%，完整输出保持一致；5类工具故障测试均达到预定标准。整体研发效率的提升幅度，还需同模型任务测试确认。', bold=True)
para('[1] SWE-bench官方评测指南：www.swebench.com/SWE-bench/guides/evaluation/\n[2] Inspect官方教程与评分说明：inspect.aisi.org.uk/tutorial.html；inspect.aisi.org.uk/scoring.html\n原始记录与复现脚本：experiments/first-commit-20261111。参数设置不准确的17次试运行已排除，仍保留记录供核查。', small=True)

doc.core_properties.title='Future Code 初版与现版对比测试报告'
doc.core_properties.subject='运行机制改进及整体研发效率评测方法'
doc.core_properties.author='Da Xu'
# Remove template border residue and disable CJK document-grid snapping.
for style in doc.styles:
    if style.type == 1:
        pp = style.element.get_or_add_pPr()
        for el in list(pp):
            if el.tag == qn('w:pBdr'): pp.remove(el)
        snap=OxmlElement('w:snapToGrid');snap.set(qn('w:val'),'0');pp.append(snap)
paragraphs = list(doc.paragraphs) + [p for t in doc.tables for row in t.rows for cell in row.cells for p in cell.paragraphs]
for p in paragraphs:
    pp=p._p.get_or_add_pPr()
    for el in list(pp):
        if el.tag == qn('w:pBdr'): pp.remove(el)
    snap=OxmlElement('w:snapToGrid');snap.set(qn('w:val'),'0');pp.append(snap)
doc.save(OUT / 'Future_Code_First_Commit_Comparison.docx')
print(OUT / 'Future_Code_First_Commit_Comparison.docx')
