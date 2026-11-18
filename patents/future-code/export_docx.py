#!/usr/bin/env python3
"""Build the editable China Mobile patent forms from the two Markdown sources."""
import argparse
from pathlib import Path
import re

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor

from patent_diagrams import diagram

HERE = Path(__file__).resolve().parent
TITLE = '一种6G无线接入网智能体协同控制方法及系统'
INVENTORS = '许达、王飞'
VERSION = 'V1.1'
DATE = '2026.11.18'
DISCLOSURE_HEADINGS = (
    '一、发明名称',
    '二、技术领域',
    '三、现有技术的技术方案',
    '四、现有技术的缺点及本申请要解决的技术问题',
    '五、本申请的技术方案的详细阐述',
    '六、本申请的关键点和欲保护点',
    '七、与第三条中最接近的现有技术相比，本申请有何技术优点',
    '八、其他有助于理解本申请的技术资料',
    '九、本申请的侵权证据可获得性',
)
SEARCH_HEADINGS = (
    '一、使用的中文与外文检索关键词',
    '二、相关专利文献',
    '三、分析评述',
    '四、检索结论',
)
DISCLOSURE_NOTICE = (
    '注意事项',
    '1．技术联系人负责向审核人员和代理人解释技术方案、修改交底书及审核申请文件。申报时填写姓名、电子邮箱和手机。',
    '2．按集团公司技术交底书模板逐项填写。第八部分为可选项。',
    '3．形成完整技术方案即可提交申请。拟对外公开或提交标准的技术构思，应安排在公开前申请。',
    '4．文件名为发明名称、半角短横线、交底书及版本号。',
)
SEARCH_NOTICE = (
    '注意事项',
    '1．围绕技术关键点选择通用中外文检索词，并说明关键词的逻辑组合关系。',
    '2．按集团公司检索报告模板填写关键词、相关文献、分析评述和结论。',
    '3．文件名为发明名称、半角短横线、检索报告及版本号。',
)
BODY_WIDTH = Mm(146.5)


def set_font(style, east_asia, size, bold=False):
    style.font.name = 'Times New Roman'
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    properties = style._element.get_or_add_rPr()
    fonts = properties.rFonts
    for attribute in ('asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme'):
        fonts.attrib.pop(qn(f'w:{attribute}'), None)
    fonts.set(qn('w:eastAsia'), east_asia)
    language = properties.find(qn('w:lang'))
    if language is None:
        language = OxmlElement('w:lang')
        properties.append(language)
    language.set(qn('w:eastAsia'), 'zh-CN')


def set_paragraph(style, line, *, indent=0, before=0, after=0, keep_next=False):
    fmt = style.paragraph_format
    fmt.line_spacing = Pt(line)
    fmt.first_line_indent = Pt(indent)
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    fmt.keep_with_next = keep_next
    fmt.widow_control = True


def build_form(search):
    document = Document()
    section = document.sections[0]
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    section.top_margin = section.bottom_margin = Mm(25.4)
    section.left_margin = section.right_margin = Mm(31.75)

    leading = 18 if search else 24
    styles = document.styles
    set_font(styles['Normal'], 'FangSong', 12)
    set_paragraph(styles['Normal'], leading, indent=24)
    styles['Normal'].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    set_font(styles['Heading 1'], 'FangSong' if search else 'SimHei', 12)
    set_paragraph(styles['Heading 1'], leading, indent=24, before=8, after=2, keep_next=True)
    set_font(styles['Title'], 'SimHei', 22)
    set_paragraph(styles['Title'], 24, before=5, after=5, keep_next=True)
    styles['Title'].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_properties = styles['Title']._element.get_or_add_pPr()
    for local_name in ('pBdr', 'contextualSpacing'):
        node = title_properties.find(qn(f'w:{local_name}'))
        if node is not None:
            title_properties.remove(node)

    for name, font, size, line, before, after, alignment in (
        ('Cover Company', 'SimHei', 16, 18, 12, 6, WD_ALIGN_PARAGRAPH.CENTER),
        ('Cover Field', 'FangSong', 12, 18, 0, 0, WD_ALIGN_PARAGRAPH.LEFT),
        ('Cover Notice', 'FangSong', 10.5, 16, 0, 0, WD_ALIGN_PARAGRAPH.LEFT),
        ('Form Figure', 'FangSong', 10.5, 16, 4, 0, WD_ALIGN_PARAGRAPH.CENTER),
        ('Form Caption', 'FangSong', 10.5, 16, 0, 4, WD_ALIGN_PARAGRAPH.CENTER),
    ):
        style = styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        set_font(style, font, size)
        set_paragraph(style, line, before=before, after=after)
        style.paragraph_format.alignment = alignment

    link_style = styles.add_style('Reference Link', WD_STYLE_TYPE.CHARACTER)
    set_font(link_style, 'FangSong', 12)
    link_style.font.underline = True
    return document


def grid(document, widths):
    table = document.add_table(rows=0, cols=len(widths))
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = 'Table Grid'
    for column, width in zip(table.columns, widths):
        column.width = width
    tbl_pr = table._tbl.tblPr
    total_width = tbl_pr.find(qn('w:tblW'))
    total_width.set(qn('w:type'), 'dxa')
    total_width.set(qn('w:w'), str(BODY_WIDTH.twips))
    cell_margin = OxmlElement('w:tblCellMar')
    for edge, spacing in (('top', 0), ('bottom', 0), ('left', 120), ('right', 120)):
        element = OxmlElement(f'w:{edge}')
        element.set(qn('w:w'), str(spacing))
        element.set(qn('w:type'), 'dxa')
        cell_margin.append(element)
    tbl_pr.insert_element_before(cell_margin, 'w:tblLook')
    return table


def add_grid_row(table, widths):
    row = table.add_row()
    row._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
    for cell, width in zip(row.cells, widths):
        cell.width = width
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    return row.cells


def add_cover(document, search):
    document.add_paragraph('中国移动专利申请', 'Title')
    document.add_paragraph('检索报告' if search else '技术交底书', 'Title')
    rows = (
        [('发明名称', TITLE), ('申报单位', '研究院'),
         ('检索人', INVENTORS + '（联系方式由院内登记）'), ('检索日期', DATE)]
        if search else
        [('公司编号', ''), ('发明名称', TITLE), ('申报单位', '研究院'), ('申报类型', '发明'),
         ('发明人', INVENTORS), ('技术联系人', '许达（联系方式由院内登记）')]
    )
    label_width = Mm(36.4)
    widths = (label_width, BODY_WIDTH - label_width)
    table = grid(document, widths)
    for label, value in rows:
        for cell, text in zip(add_grid_row(table, widths), (label, value)):
            p = cell.paragraphs[0]
            p.style = 'Cover Field'
            p.add_run(text)
    separator = document.add_paragraph()
    set_paragraph(separator, 10, keep_next=True)
    notice = add_grid_row(grid(document, (BODY_WIDTH,)), (BODY_WIDTH,))[0]
    for index, text in enumerate(SEARCH_NOTICE if search else DISCLOSURE_NOTICE):
        p = notice.paragraphs[0] if index == 0 else notice.add_paragraph()
        p.style = 'Cover Notice'
        p.add_run(text)
    if not search:
        document.add_paragraph('中国移动通信集团有限公司', 'Cover Company')


def reference_label(url):
    patent = re.search(r'/patent/([^/]+)', url)
    if patent:
        return patent.group(1) + ' 原文'
    if 'rfc-editor.org' in url:
        return 'RFC ' + re.search(r'rfc(\d+)', url).group(1)
    if 'specificationId=' in url:
        return {
            '4423': 'TR 23.801-01',
            '5491': 'TR 32.801-01',
            '5548': 'TR 29.832',
        }[url.rsplit('=', 1)[1]]
    if 'ran113-reports' in url:
        return 'RAN#113 工作组报告'
    if 'etsi.org' in url:
        return 'TS 28.312 V18.7.0'
    if 'o-ran.org' in url:
        return 'O-RAN 联盟公告'
    return url


def add_hyperlink(paragraph, url):
    relation = paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    link = OxmlElement('w:hyperlink')
    link.set(qn('r:id'), relation)
    run = OxmlElement('w:r')
    props = OxmlElement('w:rPr')
    style = OxmlElement('w:rStyle')
    style.set(qn('w:val'), paragraph.part.document.styles['Reference Link'].style_id)
    props.append(style)
    run.append(props)
    text = OxmlElement('w:t')
    text.text = reference_label(url)
    run.append(text)
    link.append(run)
    paragraph._p.append(link)


def append_text(paragraph, line):
    for part in re.split(r'(\*\*[^*]+\*\*|https://[^\s]+)', line):
        if part.startswith('https://'):
            add_hyperlink(paragraph, part)
        elif part.startswith('**'):
            paragraph.add_run(part[2:-2]).bold = True
        elif part:
            paragraph.add_run(part)


def pick_figure_font(explicit):
    candidates = [Path(explicit)] if explicit else [
        Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
        Path('/usr/local/share/fonts/noto-cjk/NotoSansCJKsc-Regular.otf'),
    ]
    for path in candidates:
        if path.is_file():
            return path
    raise SystemExit('Supply a Simplified Chinese figure font with --font-file.')


def export(stem, target, font):
    search = stem == '检索报告'
    source = (HERE / f'{stem}.md').read_text(encoding='utf-8')
    expected = SEARCH_HEADINGS if search else DISCLOSURE_HEADINGS
    if tuple(re.findall(r'^# (.+)$', source, flags=re.M)) != expected:
        raise ValueError(f'{stem} does not follow the patent form section order.')

    document = build_form(search)
    add_cover(document, search)
    figures = []
    section = ''
    for line in source.splitlines():
        line = line.strip()
        if not line:
            continue
        figure = re.fullmatch(r'\{\{图(\d+) (.+)\}\}', line)
        if figure:
            number = int(figure[1])
            caption = f'图{number} {figure[2]}'
            p = document.add_paragraph(style='Form Figure')
            p.paragraph_format.keep_with_next = True
            p.paragraph_format.line_spacing = 1.0
            picture = p.add_run().add_picture(diagram(number, font), width=Mm(127))
            picture._inline.docPr.set('descr', caption)
            document.add_paragraph(caption, 'Form Caption')
            figures.append(number)
        elif line.startswith('# '):
            section = line[2:]
            document.add_paragraph(section, 'Heading 1')
        elif line.startswith('## '):
            p = document.add_paragraph()
            p.add_run(line[3:]).bold = True
            p.paragraph_format.keep_with_next = True
        else:
            line = re.sub(r'^(\d+)\. ', r'\1．', line)
            p = document.add_paragraph()
            append_text(p, line)
            if re.fullmatch(r'\*\*[^*]+\*\*', line):
                p.paragraph_format.keep_with_next = True
            if section == expected[-1]:
                p.paragraph_format.keep_together = True
                if search and line.startswith(('1．', '2．')):
                    p.paragraph_format.keep_with_next = True
    if figures != ([] if search else [1, 2, 3]):
        raise ValueError(f'{stem} has unexpected figures: {figures}')
    document.core_properties.title = f'{TITLE}-{stem}{VERSION}'
    document.core_properties.author = INVENTORS
    document.core_properties.last_modified_by = INVENTORS
    document.core_properties.subject = '6G Agentic RAN'
    document.core_properties.keywords = '6G, Agentic RAN, 3GPP, 无线接入网'
    document.core_properties.comments = ''
    document.save(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=HERE)
    parser.add_argument('--font-file', help='Simplified Chinese font for patent diagrams')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    font = pick_figure_font(args.font_file)
    for stem in ('交底书', '检索报告'):
        target = args.output_dir / f'{TITLE}-{stem}{VERSION}.docx'
        export(stem, target, font)
        print(target)


if __name__ == '__main__':
    main()
