# Address HACT review with sparse replay and transfer diagnostics

The review identified a dense-ordering resource barrier, an unexplained
cap32/compact8 interaction and missing transfer and CPU diagnostics. This
revision adds a separately frozen sparse compact replay on Packaging's full
26,948-check registry, rescores all 30 admitted dispatch traces with frozen
cap64 layouts, and profiles both observer-disabled service arms on all ten
admitted cases. It also adds witness diagrams and explains why a standard
empirical-Bernstein alternative does not establish practical calibration at
50 epochs for the constructed example.

The sparse child stays within a 2 GiB address-space limit at 319.6 MiB peak
RSS and reduces padded bytes by 36.95% on each of two repeated-pattern
holdouts. Cap64 wins all 15 file-group comparisons and loses all 15
item-shuffled comparisons against the symmetric baseline. These findings do
not establish a natural hierarchical consumer, workflow generalization or a
service speedup; the maintained-counter service advantage remains explicit.
The original 522 observations, exclusions and unfavorable results are
unchanged. The observer table consistently presents Off/On ratios, with
its independent audit and derived receipt updated to match; no raw timing
is corrected or replaced.

The refreshed review packet includes a 13-page IEEEtran article, a 9-page
supplement, a 1-page cover letter, synchronized metadata and a deterministic
27-file source archive. The point-by-point response, protocol, reproduction
instructions and validation record are under `docs/V15_*.md`. Historical
model-snapshot gaps and AI assistance remain disclosed. Journal submission
is paused for author review of this revision.

Validation: **843 tests passed**; all **25 audit/control commands passed**;
all three source-package entry points clean-built with matching extracted
PDF text and no layout/reference warnings; all 23 PDF pages were visually
reviewed. The release manifest and exact observation inventory were verified.
CI retains every earlier gate and adds v15 literal replay, evidence audit
and projection checks. No shared runtime or acceptance-boundary code changes.
