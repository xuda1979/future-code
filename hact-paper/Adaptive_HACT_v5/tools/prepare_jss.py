#!/usr/bin/env python3
"""Build two journal-format variants from one scientific manuscript source.

No scientific prose is independently maintained in these generated variants.
The flat source archive follows Elsevier's documented EM source-file layout.
"""
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PAPER = ROOT / 'paper'


def source(blinded=False):
    original = (PAPER / 'journal.tex').read_text()
    preamble = original[original.index('\\usepackage'):original.index('\\hypersetup')]
    abstract = original.split('\\begin{abstract}', 1)[1].split('\\end{abstract}', 1)[0]
    body = original[original.index('\\section{Introduction}'):]
    body = body.replace('\\begin{tikzpicture}', '\\resizebox{\\textwidth}{!}{\\begin{tikzpicture}')
    body = body.replace('\\end{tikzpicture}', '\\end{tikzpicture}}')
    title = 'Adaptive HACT: Information Limits and Safe Adaptation of Verification Evidence'
    authors = (r'\author{Anonymous authors}' if blinded else
               '\\author[cmri]{Da Xu\\corref{cor1}}\n'
               '\\ead{xudayj@chinamobile.com}\n'
               '\\author[cmri]{Fei Wang}\n'
               '\\address[cmri]{China Mobile Research Institute}\n'
               '\\cortext[cor1]{Corresponding author.}')
    if blinded:
        body = body.replace('Historical releases are available at\n\\url{https://github.com/xuda1979/future-code/tree/main/hact-paper/Adaptive_HACT_v5}.',
                            'The historical repository link is withheld in this blinded manuscript.\nThe accompanying review artifact supplies the referenced observations.')
    footer = r'''
\makeatletter
\def\ps@pprintTitle{\let\@oddhead\@empty\let\@evenhead\@empty
\def\@oddfoot{\hfil\thepage\hfil}\let\@evenfoot\@oddfoot}
\makeatother
'''
    return ('% Generated from journal.tex by tools/prepare_jss.py.\n'
            '\\documentclass[preprint,12pt]{elsarticle}\n\\usepackage{lmodern}\n' + preamble + footer +
            '\\hypersetup{pdftitle={' + title + '},pdfauthor={' +
            ('' if blinded else 'Da Xu and Fei Wang') + '}}\n'
            '\\journal{Journal of Systems and Software}\n'
            '\\begin{document}\n\\begin{frontmatter}\n\\title{' + title + '}\n' +
            authors + '\n\\begin{abstract}' + abstract + '\\end{abstract}\n'
            '\\begin{keyword}\nVerification evidence \\sep software agents \\sep '
            'completion hypergraphs \\sep adaptive data structures \\sep runtime assurance\n'
            '\\end{keyword}\n\\end{frontmatter}\n' + body)


def flatten(name, output):
    pending = [name]
    payload = {}
    while pending:
        rel = pending.pop()
        path = PAPER / rel
        if path.name in payload:
            continue
        raw = path.read_bytes()
        if path.suffix == '.tex':
            text = raw.decode()
            dependencies = re.findall(r'\\input\{([^}]+)\}', text)
            figures = re.findall(r'\\includegraphics(?:\[[^]]*\])?\{([^}]+)\}', text)
            for child in dependencies + figures:
                if not Path(child).suffix:
                    child += '.tex'
                pending.append(child)
                text = text.replace('{' + child + '}', '{' + Path(child).name + '}')
            raw = text.encode()
        payload[path.name] = raw
    payload['elsarticle.cls'] = (PAPER / 'elsarticle.cls').read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for filename, raw in sorted(payload.items()):
            archive.writestr(filename, raw)


def main():
    for blinded in (False, True):
        name = 'jss_blinded.tex' if blinded else 'jss.tex'
        (PAPER / name).write_text(source(blinded))
        flatten(name, ROOT / 'submission' / ('JSS_blinded_source.zip' if blinded else 'JSS_source.zip'))
    print('Generated attributed/blinded JSS sources and flat source archives.')


if __name__ == '__main__':
    main()
