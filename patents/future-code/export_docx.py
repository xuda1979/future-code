#!/usr/bin/env python3
"""Export patent sources using the supplied attachments' native Word formats."""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import re
import zipfile

from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches
from docx.table import Table
from docx.text.paragraph import Paragraph

from patent_diagrams import diagram

HERE = Path(__file__).resolve().parent
SOURCES = ['INVENTION_DISCLOSURE_CN', 'PRIOR_ART_SEARCH_CN']
FIGURES = {
    1: '图1：模型提议、宿主控制及证据验证数据流',
    2: '图2：提议绑定、租约复核及动态子任务准入流程',
    3: '图3：远端作业 ensure/inspect 协调与完成门控流程',
}
FORMAT_PARTS = ['word/styles.xml', 'word/theme/theme1.xml',
                'word/numbering.xml', 'word/settings.xml', 'word/fontTable.xml',
                'word/webSettings.xml']


def font_path(value: str | None) -> Path:
    candidates = [Path(value)] if value else [
        Path('/usr/local/share/fonts/noto-cjk/NotoSansCJKsc-Regular.otf'),
        Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
    ]
    for path in candidates:
        if path.is_file():
            return path
    raise SystemExit('Install Noto Sans CJK SC or pass --font-file PATH.')


def hyperlink(paragraph, url):
    """Keep links clickable, using compact labels rather than overflowing URLs."""
    url = url.rstrip('.,;；。，、')
    patent = re.search(r'/patent/([^/]+)', url)
    if patent:
        label = patent.group(1) + ' 文献页'
    elif 'cnipa.gov.cn' in url:
        label = 'CNIPA 专利法' if '2020/' in url else 'CNIPA 审查指南修改决定'
    elif '/commit/' in url:
        label = '历史提交 ' + url.rsplit('/', 1)[1][:12]
    elif 'arxiv' in url:
        label = 'AutoGen 原论文'
    elif 'remote_execution.proto' in url:
        label = 'Bazel 远程执行接口'
    elif 'the-immortal-life' in url:
        label = 'Temporal Pi 公开文章'
    elif 'event-history' in url:
        label = 'Temporal Event History'
    elif 'understanding-temporal' in url:
        label = 'Understanding Temporal'
    elif 'saga-pattern' in url:
        label = 'Temporal Saga 文章'
    elif 'durable_execution' in url:
        label = 'LangGraph Durable Execution'
    else:
        label = 'LangGraph Persistence' if 'langchain' in url else url.split('//')[-1]
    link = OxmlElement('w:hyperlink')
    link.set(qn('r:id'), paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True))
    run = OxmlElement('w:r')
    properties = OxmlElement('w:rPr')
    style = OxmlElement('w:rStyle')
    style.set(qn('w:val'), 'Hyperlink')
    properties.append(style)
    run.append(properties)
    text = OxmlElement('w:t')
    text.text = label
    run.append(text)
    link.append(run)
    paragraph._p.append(link)


def add_inline(paragraph, value, base_properties=None):
    pattern = re.compile(r'(https?://[^\s；。\)）]+|\*\*[^*]+\*\*|`[^`]+`)')

    def add(value, bold=False, code=False):
        if not value:
            return
        run = paragraph.add_run(value)
        if base_properties is not None:
            run._r.insert(0, deepcopy(base_properties))
        if bold:
            run.bold = True
        if code and 'Verbatim Char' in paragraph.part.document.styles:
            run.style = 'Verbatim Char'

    position = 0
    for match in pattern.finditer(value):
        add(value[position:match.start()])
        part = match.group()
        if part.startswith('http'):
            hyperlink(paragraph, part)
        elif part.startswith('**'):
            add(part[2:-2], bold=True)
        else:
            add(part[1:-1], code=True)
        position = match.end()
    add(value[position:])


def reset_paragraph(element):
    for child in list(element):
        if child.tag != qn('w:pPr'):
            element.remove(child)


class NativeFormat:
    """Clone paragraph and table properties; never restyle the attachment."""

    def __init__(self, path):
        self.path = path
        self.doc = Document(path)
        self.paragraphs = {}
        self.heading_sequence = []
        self.lists = {}
        numbering = self.doc.part.numbering_part.element
        abstracts = {a.get(qn('w:abstractNumId')): a for a in numbering.findall(qn('w:abstractNum'))}
        formats = {}
        for num in numbering.findall(qn('w:num')):
            abstract = abstracts[num.find(qn('w:abstractNumId')).get(qn('w:val'))]
            formats[num.get(qn('w:numId'))] = abstract.find(qn('w:lvl')).find(qn('w:numFmt')).get(qn('w:val'))
        for p in self.doc.paragraphs:
            self.paragraphs.setdefault(p.style.name, deepcopy(p._p))
            if p.style.name in ['Heading 1', 'Heading 2', 'Heading 3']:
                self.heading_sequence.append(p.style.name)
            num = p._p.pPr.find(qn('w:numPr')) if p._p.pPr is not None else None
            if num is not None:
                kind = formats[num.find(qn('w:numId')).get(qn('w:val'))]
                self.lists.setdefault(kind, deepcopy(p._p))
        self.tables = [deepcopy(t._tbl) for t in self.doc.tables]
        self.toc = deepcopy(self.doc._element.body.find(qn('w:sdt')))
        for element in list(self.doc._element.body):
            if element.tag != qn('w:sectPr'):
                self.doc._element.body.remove(element)

    def append(self, element):
        self.doc._element.body.insert(len(self.doc._element.body) - 1, element)

    def paragraph(self, style, value='', list_kind=None):
        source = self.lists[list_kind] if list_kind else self.paragraphs[style]
        element = deepcopy(source)
        reset_paragraph(element)
        self.append(element)
        paragraph = Paragraph(element, self.doc._body)
        add_inline(paragraph, value)
        return paragraph

    def table(self, index, rows):
        element = deepcopy(self.tables[index])
        template = Table(element, self.doc._body)
        if len(template.columns) != len(rows[0]):
            raise ValueError(f'Table {index + 1}: columns differ from attachment')
        head = deepcopy(template.rows[0]._tr)
        body = deepcopy(template.rows[1]._tr)
        for row in list(element.findall(qn('w:tr'))):
            element.remove(row)
        for i, record in enumerate(rows):
            row = deepcopy(head if i == 0 else body)
            # Keep one comparison record on one page without changing the
            # reference's column widths, fonts, borders, or table style.
            if row.get_or_add_trPr().find(qn('w:cantSplit')) is None:
                row.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
            for cell, value in zip(row.findall(qn('w:tc')), record):
                prototype = cell.find(qn('w:p'))
                first_run = prototype.find(qn('w:r'))
                properties = first_run.find(qn('w:rPr')) if first_run is not None else None
                properties = deepcopy(properties) if properties is not None else None
                for child in list(cell):
                    if child.tag != qn('w:tcPr'):
                        cell.remove(child)
                reset_paragraph(prototype)
                cell.append(prototype)
                add_inline(Paragraph(prototype, self.doc._body), value, properties)
            element.append(row)
        self.append(element)

    def title(self, search):
        title = self.paragraph('Title')
        title.add_run('现有技术检索报告' if search else '发明专利技术交底书').bold = True
        title.add_run().add_break()
        if search:
            title.add_run('Prior Art Search Report').add_break()
            title.add_run('研发智能体外部作业协调及完成控制').add_break()
            title.add_run('R&D Agent Job Reconciliation and Completion Control')
        else:
            title.add_run('一种研发智能体的外部作业协调及完成控制方法')
        self.paragraph('Author', '中国移动通信有限公司研究院')
        self.paragraph('Date', '2026-10-13')
        self.append(deepcopy(self.toc))


def preserve_format_parts(target, template):
    # Keep native format parts byte-identical despite XML serialization.
    with zipfile.ZipFile(target) as package:
        entries = {n: package.read(n) for n in package.namelist()}
    with zipfile.ZipFile(template) as source:
        for part in FORMAT_PARTS:
            entries[part] = source.read(part)
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as package:
        for name, content in entries.items():
            package.writestr(name, content)


def export(stem, destination, font):
    search = stem == SOURCES[1]
    native = NativeFormat(HERE / 'formats' / ('search.docx' if search else 'disclosure.docx'))
    native.title(search)
    lines = (HERE / (stem + '.md')).read_text().splitlines()
    position = next(i for i, line in enumerate(lines) if line.startswith('# '))
    headings = []
    figure = table_index = 0
    first = True
    while position < len(lines):
        line = lines[position].strip()
        position += 1
        if not line:
            continue
        if line.startswith('```mermaid'):
            while position < len(lines) and not lines[position].startswith('```'):
                position += 1
            position += 1
            figure += 1
            paragraph = native.paragraph('Captioned Figure')
            picture = paragraph.add_run().add_picture(diagram(figure, font), width=Inches(5.5))
            picture._inline.docPr.set('descr', FIGURES[figure])
            native.paragraph('Image Caption', FIGURES[figure])
            first = False
            continue
        if line.startswith('|'):
            block = [line]
            while position < len(lines) and lines[position].strip().startswith('|'):
                block.append(lines[position].strip())
                position += 1
            rows = [[cell.strip() for cell in record.strip('|').split('|')]
                    for record in block if not re.fullmatch(r'\|[\s:|\-]+\|', record)]
            if not all(len(row) == len(rows[0]) for row in rows):
                raise ValueError('Inconsistent Markdown table columns')
            native.table(table_index, rows)
            table_index += 1
            first = False
            continue
        heading = re.fullmatch(r'(#{1,3})\s+(.+)', line)
        if heading:
            style = f'Heading {len(heading.group(1))}'
            native.paragraph(style, heading.group(2))
            headings.append(style)
            first = True
            continue
        if line == '**行为对比**':
            native.paragraph('Table Caption', '行为对比')
            continue
        number = re.fullmatch(r'\d+\. (.+)', line)
        bullet = re.fullmatch(r'[-*] (.+)', line)
        if number or bullet:
            kind = 'decimal' if number else 'bullet'
            native.paragraph('Normal', (number or bullet).group(1), list_kind=kind)
        else:
            native.paragraph('First Paragraph' if first else 'Body Text', line)
        first = False
    if headings != native.heading_sequence:
        raise ValueError('Heading level/order differs from the supplied attachment')
    if table_index != len(native.tables) or figure != (0 if search else 3):
        raise ValueError('Table/figure structure differs from the supplied attachment')
    props = native.doc.core_properties
    props.author = props.last_modified_by = '许达、王飞'
    props.title = '现有技术检索报告' if search else '发明专利技术交底书'
    props.subject = '研发智能体外部作业协调及完成控制'
    props.comments = '中国移动通信有限公司研究院'
    props.created = props.modified = datetime(2026, 10, 13, tzinfo=timezone.utc)
    target = destination / (stem + '.docx')
    native.doc.save(target)
    preserve_format_parts(target, native.path)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=HERE)
    parser.add_argument('--font-file')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    font = font_path(args.font_file)
    for stem in SOURCES:
        print(export(stem, args.output_dir, font))


if __name__ == '__main__':
    main()
