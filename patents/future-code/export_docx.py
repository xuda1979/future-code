#!/usr/bin/env python3
"""Export the two patent source documents with real diagrams and hyperlinks."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import re

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT_NAME = 'Noto Sans CJK SC'
SOURCES = ['INVENTION_DISCLOSURE_CN', 'PRIOR_ART_SEARCH_CN']
REVIEW_COMMENTS = {
    SOURCES[0]: [
        ('中国移动通信有限公司研究院（内部申报建议主体', 'R01 已按指定单位填写；申请权及共同申请安排由院知识产权管理流程核定。'),
        ('本地租约校验只能拒绝', 'R03 已收窄本地租约保障范围，远端去重另依赖受信适配器。'),
        ('对同一持久工具调用', 'R04 已说明稳定键的作用域及旧作业未决时的替代运行限制。'),
        ('权利要求11：', 'R10 已移出HACT布局特征，改为同一目标历史修订作业门控。'),
    ],
    SOURCES[1]: [
        ('本报告的 A—E', 'R08 已区分内容分组、技术接近风险与官方检索类别。'),
        ('权利要求1(b)', 'R06 已更正对通用验证规则的概括；它不直接要求执行者之外的独立检查器。'),
        ('普通自愿上传 GitHub', 'R09 已加入中国公开时间规则；提交时间不能代替实际公众可获取证据。'),
        ('金融工具数据及对抗式纠正', 'R07 已补回金融数据限定，避免将特定权利要求扩大为通用代理编排。'),
    ],
}


def font_path(value: str | None) -> Path:
    candidates = [Path(value)] if value else [
        Path('/usr/local/share/fonts/noto-cjk/NotoSansCJKsc-Regular.otf'),
        Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SystemExit('Install Noto Sans CJK SC or pass --font-file PATH.')


def diagram(number: int, font: Path) -> BytesIO:
    """Exact black and white flow figures; model images are not used."""
    sizes = {1: (1800, 680), 2: (1800, 780), 3: (1800, 1060)}
    canvas = Image.new('RGB', sizes[number], 'white')
    draw = ImageDraw.Draw(canvas)
    normal = ImageFont.truetype(str(font), 37)
    small = ImageFont.truetype(str(font), 31)

    def box(rect, label):
        draw.rectangle(rect, outline='black', width=3)
        lines = label.split('\n')
        center = ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
        for i, line in enumerate(lines):
            bounds = draw.textbbox((0, 0), line, font=normal)
            w, h = bounds[2] - bounds[0], bounds[3] - bounds[1]
            draw.text((center[0] - w / 2, center[1] + (i - (len(lines)-1)/2)*49 - h/2 - bounds[1]), line, font=normal, fill='black')

    def arrow(points, label=None, at=None):
        draw.line(points, fill='black', width=3, joint='curve')
        end, previous = points[-1], points[-2]
        dx, dy = end[0]-previous[0], end[1]-previous[1]
        length = (dx*dx+dy*dy)**.5
        ux, uy = dx/length, dy/length
        draw.polygon([end, (end[0]-16*ux+8*uy,end[1]-16*uy-8*ux), (end[0]-16*ux-8*uy,end[1]-16*uy+8*ux)], fill='black')
        if label:
            draw.text(at, label, font=small, fill='black')

    if number == 1:
        box((50,40,550,180), '模型结构化提议')
        box((650,40,1150,180), '宿主身份绑定\n与权限准入')
        box((1250,40,1750,180), '冻结契约与\n任务图及租约')
        arrow([(550,110),(650,110)])
        arrow([(1150,110),(1250,110)])
        box((1250,280,1750,420), '本地工具或\n远端作业协调')
        arrow([(1500,180),(1500,280)])
        box((650,280,1150,420), '工件及独立\n机器检查证据')
        arrow([(1250,350),(1150,350)])
        box((50,280,550,420), '完成门控与\n集成再验证')
        arrow([(650,350),(550,350)])
        box((50,520,550,650), '持久目标完成记录')
        arrow([(300,420),(300,520)])
    elif number == 2:
        box((480,30,1320,140), '提议与任务租约代际 f')
        box((480,210,1320,350), '核验契约 载荷 作用域\n及当前租约有效期')
        arrow([(900,140),(900,210)])
        box((40,430,770,570), '登记准入\n原子追加子任务')
        box((1050,430,1760,570), '拒绝或延期')
        arrow([(650,350),(650,390),(405,390),(405,430)], '有效', (430,351))
        arrow([(1150,350),(1150,390),(1405,390),(1405,430)], '无效', (1420,351))
        box((40,650,770,760), '实际操作前复核 f\n有效才执行和验证')
        box((1050,650,1760,760), '旧代际或过期\n拒绝宿主写入')
        arrow([(405,570),(405,650)])
        arrow([(770,705),(1050,705)], '失效', (847,655))
    else:
        box((420,25,1380,140), '事务中持久化意图\n稳定作业键及输入绑定')
        box((520,210,1280,310), '本地是否已有 job_id')
        arrow([(900,140),(900,210)])
        box((50,385,750,505), '幂等 ensure\n复用原 key')
        box((1050,385,1750,505), 'inspect\n使用已知 job_id')
        arrow([(600,310),(600,345),(400,345),(400,385)], '否', (380,310))
        arrow([(1200,310),(1200,345),(1400,345),(1400,385)], '是', (1430,310))
        box((520,590,1280,710), '核验响应身份和状态')
        arrow([(400,505),(400,550),(720,550),(720,590)])
        arrow([(1400,505),(1400,550),(1080,550),(1080,590)])
        box((60,810,740,940), '终态回执及检查证据\n进入目标完成门控')
        box((1060,810,1760,940), '未决或 UNKNOWN\n持久等待或人工协调')
        arrow([(650,710),(650,750),(400,750),(400,810)], '终态', (430,715))
        arrow([(1150,710),(1150,750),(1410,750),(1410,810)], '未确认', (1440,715))
        arrow([(1760,875),(1780,875),(1780,170),(1280,170),(1280,260)], '原身份重查', (1430,175))
        draw.text((65,980), '外部终态不等于目标验收通过；未决作业阻止目标完成', font=small, fill='black')
    output = BytesIO()
    canvas.save(output, format='PNG', dpi=(300,300))
    output.seek(0)
    return output


def hyperlink(paragraph, url: str):
    from docx.opc.constants import RELATIONSHIP_TYPE
    url = url.rstrip('.,;；。，、')
    name = re.search(r'/patent/([^/]+)', url)
    if name:
        label = name.group(1) + ' 文献页'
    elif 'cnipa.gov.cn' in url:
        label = 'CNIPA 专利法' if '2020/' in url else 'CNIPA 审查指南修改决定'
    elif '/commit/' in url:
        label = '历史提交 ' + url.rsplit('/',1)[1][:12]
    elif 'arxiv' in url:
        label = 'AutoGen 原论文'
    elif 'remote_execution.proto' in url:
        label = 'Bazel 远程执行接口'
    elif 'the-immortal-life' in url:
        label = 'Temporal Pi 公开文章'
    else:
        label = url.split('//')[-1]
    element = OxmlElement('w:hyperlink')
    element.set(qn('r:id'), paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True))
    run = OxmlElement('w:r')
    properties = OxmlElement('w:rPr')
    color = OxmlElement('w:color'); color.set(qn('w:val'),'000000'); properties.append(color)
    underline = OxmlElement('w:u'); underline.set(qn('w:val'),'single'); properties.append(underline)
    run.append(properties)
    content = OxmlElement('w:t'); content.text = label; run.append(content)
    element.append(run); paragraph._p.append(element)


def add_inline(paragraph, value: str):
    token = re.compile(r'(https?://[^\s；。\)）]+|\*\*[^*]+\*\*|`[^`]+`)')
    position = 0
    for match in token.finditer(value):
        if match.start() > position:
            paragraph.add_run(value[position:match.start()])
        part = match.group()
        if part.startswith('http'):
            hyperlink(paragraph, part)
        elif part.startswith('**'):
            paragraph.add_run(part[2:-2]).bold = True
        else:
            run = paragraph.add_run(part[1:-1]); run.font.name='DejaVu Sans Mono'; run.font.size=Pt(9)
        position = match.end()
    if position < len(value):
        paragraph.add_run(value[position:])


def style_document(document):
    section = document.sections[0]
    # Preserve the A4 format used by the existing patent package.
    section.page_width=Cm(21); section.page_height=Cm(29.7)
    section.top_margin=Cm(1.9); section.bottom_margin=Cm(1.8)
    section.left_margin=Cm(2.0); section.right_margin=Cm(2.0)
    section.footer_distance=Cm(.8)
    for border in list(document.styles.element.iter(qn('w:pBdr'))):
        border.getparent().remove(border)
    for name in ['Normal','Title','Subtitle','Heading 1','Heading 2','Heading 3','Caption']:
        style=document.styles[name]
        style.font.name=FONT_NAME; style.font.color.rgb=RGBColor(0,0,0)
        style.font.italic=False
        style._element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'),FONT_NAME)
    normal=document.styles['Normal']
    normal.font.size=Pt(11)
    normal.paragraph_format.line_spacing=Pt(17)
    normal.paragraph_format.space_after=Pt(6)
    normal.paragraph_format.widow_control=True
    document.styles['Title'].font.size=Pt(19)
    document.styles['Title'].paragraph_format.line_spacing=Pt(28)
    document.styles['Title'].paragraph_format.space_after=Pt(10)
    document.styles['Subtitle'].font.size=Pt(12)
    document.styles['Subtitle'].paragraph_format.line_spacing=Pt(20)
    for level,size in [(1,14),(2,12),(3,11)]:
        style=document.styles[f'Heading {level}']; style.font.size=Pt(size); style.font.bold=True
        style.paragraph_format.line_spacing=Pt(21 if level==1 else 18)
        style.paragraph_format.space_before=Pt(11 if level==1 else 7)
        style.paragraph_format.space_after=Pt(5)
        style.paragraph_format.keep_with_next=True
    footer=section.footer.paragraphs[0]
    footer.alignment=WD_ALIGN_PARAGRAPH.CENTER
    footer.add_run('第 ')
    field=OxmlElement('w:fldSimple'); field.set(qn('w:instr'),'PAGE'); footer._p.append(field)
    footer.add_run(' 页')
    for run in footer.runs: run.font.size=Pt(9)
    document.core_properties.author='许达、王飞'
    document.core_properties.last_modified_by='许达、王飞'
    document.core_properties.created=datetime(2026,10,13,tzinfo=timezone.utc)
    document.core_properties.modified=datetime(2026,10,13,tzinfo=timezone.utc)
    document.core_properties.comments='中国移动通信有限公司研究院 专利资料'


def add_table(document, rows):
    cols=len(rows[0]); table=document.add_table(rows=1, cols=cols)
    table.alignment=WD_TABLE_ALIGNMENT.CENTER; table.autofit=False
    if cols==2: widths=[3.4,13.6]
    elif cols==3: widths=[3.2,7.1,6.7]
    else: widths=[3.0,3.0,6.4,4.6]
    if '代码参照' in rows[0]: widths=[3.1,3.2,6.3,4.4]
    if cols==4 and '公开日期' in rows[0]: widths=[3.1,2.5,7.6,3.8]
    if rows[0][0]=='公开或授权号': widths=[3.4,5.6,1.4,6.6]
    if rows[0]==['记录','关键字段','核验目的']: widths=[4.5,6.4,6.1]
    for i,width in enumerate(widths): table.columns[i].width=Cm(width)
    borders=OxmlElement('w:tblBorders')
    for edge in ['top','left','bottom','right','insideH','insideV']:
        element=OxmlElement('w:'+edge)
        for attr,value in [('val','single'),('sz','4'),('color','D9D9D9')]: element.set(qn('w:'+attr),value)
        borders.append(element)
    table._tbl.tblPr.append(borders)
    for row_index,record in enumerate(rows):
        cells=table.rows[0].cells if row_index==0 else table.add_row().cells
        properties=cells[0]._tc.getparent().get_or_add_trPr()
        no_split=OxmlElement('w:cantSplit'); properties.append(no_split)
        if row_index==0: properties.append(OxmlElement('w:tblHeader'))
        for column,(cell,text) in enumerate(zip(cells,record)):
            cell.width=Cm(widths[column]); cell.vertical_alignment=WD_ALIGN_VERTICAL.CENTER
            tcpr=cell._tc.get_or_add_tcPr()
            margin=OxmlElement('w:tcMar')
            for side in ['top','bottom','left','right']:
                edge=OxmlElement('w:'+side); edge.set(qn('w:w'),'85'); edge.set(qn('w:type'),'dxa'); margin.append(edge)
            tcpr.append(margin)
            if row_index==0:
                shade=OxmlElement('w:shd'); shade.set(qn('w:fill'),'E8EDF2'); tcpr.append(shade)
            paragraph=cell.paragraphs[0]
            paragraph.paragraph_format.space_after=Pt(1)
            paragraph.paragraph_format.line_spacing=Pt(15)
            if row_index==0 or len(text)<14: paragraph.alignment=WD_ALIGN_PARAGRAPH.CENTER
            add_inline(paragraph,text)
            for run in paragraph.runs:
                run.font.size=Pt(10)
                if row_index==0: run.bold=True
    spacer=document.add_paragraph()
    spacer.paragraph_format.space_after=Pt(2); spacer.paragraph_format.line_spacing=Pt(3)
    spacer.paragraph_format.space_before=Pt(0)
    return table


def add_comments(document, specs):
    paragraphs=list(document.paragraphs)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells: paragraphs.extend(cell.paragraphs)
    for needle,message in specs:
        paragraph=next((p for p in paragraphs if needle in p.text),None)
        if paragraph is None: raise ValueError(f'comment anchor missing: {needle}')
        runs=paragraph.runs
        if not runs: raise ValueError('comment needs an ordinary text run')
        document.add_comment(runs,text=message,author='技术审阅',initials='审阅')


def export(stem, destination, font):
    lines=(HERE/(stem+'.md')).read_text().splitlines()
    document=Document(); style_document(document)
    document.core_properties.title=lines[0]
    figure=0; section_number=0; position=0
    while position<len(lines):
        line=lines[position].strip(); position+=1
        if not line: continue
        if line.startswith('```mermaid'):
            while position<len(lines) and not lines[position].startswith('```'): position+=1
            position+=1; figure+=1
            caption=document.add_paragraph('图'+str(figure),style='Caption')
            caption.paragraph_format.keep_with_next=True
            caption.alignment=WD_ALIGN_PARAGRAPH.CENTER
            paragraph=document.add_paragraph(); paragraph.alignment=WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.line_spacing=1
            run=paragraph.add_run(); shape=run.add_picture(diagram(figure,font),width=Cm(16.8))
            shape._inline.docPr.set('descr', {1:'模型提议、宿主控制与证据验证流程',2:'提议权限与实际操作前的租约复核流程',3:'远端作业确保与查询协调流程'}[figure])
            continue
        if line.startswith('|'):
            block=[line]
            while position<len(lines) and lines[position].strip().startswith('|'):
                block.append(lines[position].strip()); position+=1
            rows=[[x.strip() for x in row.strip('|').split('|')] for row in block if not re.match(r'^\|[\s:|\-]+\|$',row)]
            assert all(len(row)==len(rows[0]) for row in rows)
            add_table(document,rows); continue
        heading=re.match(r'^(#{1,3})\s+(.+)',line)
        if heading:
            level=len(heading.group(1)); label=heading.group(2)
            # Keep original chapter labels; only simplify their displayed punctuation.
            label=label.replace(' / ','  ').replace('：','  ')
            if level==1:
                section_number+=1; label=str(section_number)+'  '+label
            document.add_paragraph(label,style=f'Heading {level}'); continue
        if position==1:
            document.add_paragraph(line,style='Title'); continue
        if position<=7 and not line.startswith('英文'):
            paragraph=document.add_paragraph()
            add_inline(paragraph,line)
            paragraph.paragraph_format.space_after=Pt(4)
            if line.startswith('**'): paragraph.style='Subtitle'
            for run in paragraph.runs:
                if not line.startswith('**'): run.font.size=Pt(10)
            continue
        paragraph=document.add_paragraph(); add_inline(paragraph,line)
    assert section_number==(11 if stem==SOURCES[0] else 12)
    assert figure==(3 if stem==SOURCES[0] else 0)
    add_comments(document,REVIEW_COMMENTS[stem])
    target=destination/(stem+'.docx'); document.save(target)
    return target


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,default=HERE)
    parser.add_argument('--font-file')
    args=parser.parse_args(); args.output_dir.mkdir(parents=True,exist_ok=True)
    font=font_path(args.font_file)
    for stem in SOURCES: print(export(stem,args.output_dir,font))


if __name__=='__main__': main()
