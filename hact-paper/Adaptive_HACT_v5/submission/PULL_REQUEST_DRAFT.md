# Prepare the IEEE TSE submission packet for author review

This revision turns the reviewed HACT paper into a clean TSE-format submission
packet. It tightens the abstract to 186 words under current IEEE Computer
Society guidance, keeps the attributed 12-page article focused, and places the
complete supporting derivations and reproduction guide in a seven-page
supplement. A one-page editor-facing cover letter, flat deterministic LaTeX
source archive with a SHA-256 inventory, upload map and explicit author-fact
metadata accompany the PDFs. The JSS variants are regenerated from the same
article source.

Scientific observations, claims, results, exclusions, and source evidence are
preserved. The full historical `main.pdf` is identified as supporting history,
not another manuscript to upload. Public artifact provenance is recorded for
disclosure if the journal asks about public or related versions. The known author names, order, affiliations and both email addresses are recorded.
ORCIDs and factual declarations remain null; no consent, originality,
exclusivity, funding or conflict statement is invented.

All five PDFs compile in clean directories without overfull, undefined-reference
or citation warnings and were visually reviewed. The TSE source archive was
extracted into a fresh directory and all three entry points clean-built; its
file hashes and deterministic rebuild were checked. The worked optimizer
example independently reproduces 9,600 versus 9,984 expected bytes. The full
818-test regression passed in 42.51 seconds. The v11–v14 audit and manuscript
projection checks also pass; the refreshed manifest verifies 3,462 files and
all 522 observation records remain byte-identical.

The IEEE Publishing Portal reached its login/identity-provider step. No draft,
upload, submission ID or final journal submission exists. The corresponding
author must sign in, complete the remaining facts, review the exact files and
portal declarations, then make the final submission decision. This PR is for
repository review; it is not a claim of journal acceptance or submission.
