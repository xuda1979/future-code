# V11 primary-source reference metadata verification

Checked 2026-10-21 against the eight specifically requested entries in
`paper/references.tex`. This gate verifies bibliographic identity and the
stated publication form. It does not certify each paper's scientific claims,
peer-review quality, or completeness of HACT's literature search.

**Result: all eight title/author identities are supported by primary metadata.
No requested entry requires removal for an unsupported identity.** Keep the
preprint citations labeled as such; do not infer proceedings pages or journal
acceptance from an arXiv identifier.

| Key | Confirmed title and authors, in order | Supported publication form | Primary evidence and check result |
|---|---|---|---|
| `hmt` | *Authenticated Data Structures for Dynamic Workloads*. Ziheng Shangguan; Aviv Yaish; Dahlia Malkhi. | arXiv:2608.25206v1, August 2026; initial submission August 25. | [Official arXiv abstract](https://arxiv.org/abs/2608.25206) and [official PDF](https://arxiv.org/pdf/2608.25206). The indexed primary abstract supplies title/authors/date; indexed PDF metadata explicitly identifies v1. **CONFIRMED**, with direct-fetch limitation below. No journal venue asserted. |
| `namerts` | *Names Are All You Need: Effective and Safe Regression Test Selection for Python*. You Wang; Michael Pradel; Zhongxin Liu. | arXiv:2605.25356v1, May 25, 2026. | [Directly retrieved official record](https://arxiv.org/abs/2605.25356v1). **CONFIRMED**. The arXiv author comment says accepted at ISSTA 2026; this gate did not verify an ACM proceedings record or pagination, so retaining the arXiv citation is appropriate. |
| `pcaa` | *Proof-Carrying Agent Actions: Model-Agnostic Runtime Governance for Heterogeneous Agent Systems*. Zexun Wang. | arXiv:2606.04104v1, June 2, 2026. | [Directly retrieved official record](https://arxiv.org/abs/2606.04104v1). **CONFIRMED** as an arXiv preprint; no journal/proceedings venue established here. |
| `vpcontrol` | *Engineering Reliable Commit Gates for Agentic AI: Cost-Aware Verification Portfolios under Common-Mode Data Failures*. Zihao Zheng; Baichuan Li; Junyi Yao; Jiayu Long. | arXiv:2609.10969v1, September 10, 2026. | [Directly retrieved official record](https://arxiv.org/abs/2609.10969v1). **CONFIRMED** as an arXiv preprint; no journal/proceedings venue established here. |
| `aiware` | *Engineering Agentic Systems: Toward Verification-First AIware Engineering*. Qinghua Lu; Ahmed E. Hassan; David Lo; Thomas Zimmermann. | *IEEE Software*, 43(5):22–29, September–October 2026. DOI: 10.1109/MS.2026.3697911. | [Publisher document 11679552](https://ieeexplore.ieee.org/abstract/document/11679552/) supplies indexed title, volume, issue, pages, DOI and September 7 publication date. [Author's institutional publication list](https://www.unsw.edu.au/staff/qinghua-lu) independently supplies the ordered Lu/Hassan/Lo/Zimmermann author initials, title, journal, volume, pages and same DOI. **CONFIRMED**, with direct publisher-fetch limitation below. The title uses “Toward”. |
| `traceassurance` | *A Trace-Based Assurance Framework for Agentic AI Orchestration: Contracts, Testing, and Governance*. Ciprian Paduraru; Petru-Liviu Bouruc; Alin Stefanescu. | arXiv:2603.18096v1, March 18, 2026. | [Directly retrieved official record](https://arxiv.org/abs/2603.18096). **CONFIRMED**. The existing authors and title are correct. No ENASE proceedings pagination is inferred or restored. |
| `verificationdriven` | *Verification-Driven AI Engineering: Workflows and Reference Architecture*. Qinghua Lu; Liming Zhu; Suyu Ma; Helen Power; Robert Speight. | SSRN 6430979, 2026. DOI: 10.2139/ssrn.6430979. | [Official SSRN record](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6430979), retrieved through its indexed primary-page content, supplies all five authors and the DOI in its suggested citation. It distinguishes March 17 writing date from April 6 posting. **CONFIRMED** as an SSRN paper, not a verified peer-reviewed venue. |
| `sweevo` | *SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution Scenarios*. Tue Le; Minh V. T. Thai; Dung Nguyen Manh; Huy Phan Nhat; Nghi D. Q. Bui. | arXiv:2512.18470; v1 December 20, 2025; retrieved latest record is v6, May 22, 2026. | [Directly retrieved official record](https://arxiv.org/abs/2512.18470), with [explicit v6 link](https://arxiv.org/abs/2512.18470v6). **CONFIRMED**. “Revised 2026” is supported. Pinning v6 is an optional reproducibility improvement; no proceedings venue was verified. |

## Retrieval boundaries

Direct opens of the HMT arXiv URLs returned a disabled-fetch error, although
search retrieval returned the official abstract's complete metadata and the
official PDF's arXiv/version metadata. Direct IEEE publisher opens returned
HTTP 418, while the indexed publisher document supplied publication fields;
the author's institutional page was directly retrieved. SSRN direct opens
returned HTTP 403 or a blocked redirect; indexed retrieval of the original
SSRN page supplied its full bibliographic header and suggested DOI citation.
These access failures are recorded without interpreting them as evidence
that a paper does not exist. No commercial aggregator, Wikipedia, guessed
proceedings entry, or unrelated search result is used as decisive metadata.

The referenced exact titles and author lists match the current eight LaTeX
entries. The most useful optional cleanup is to pin `sweevo` to v6 and to
use the explicit SSRN abstract URL alongside its DOI if desired. No unsupported
proceedings details should be added. The separate journal build may omit
unused entries; that omission does not invalidate the historical full-manuscript
citations whose identities are verified here.
