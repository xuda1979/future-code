import os

PAPER = "/Users/daxu/software/future-code/paper"

def w(name, content):
    with open(os.path.join(PAPER, name), "w") as f:
        f.write(content)
    print("wrote", name)

positioning = r"""\section*{Positioning, Scope, and the Path to Archival Submission}
This section is written for a journal or conference reviewer. It states, up
front and without hedging, what the evidence does and does not support, where
the method is (and is not) worth the added complexity, and how a competitive
venue submission would be constructed.

\paragraph{What satisfies top-tier methodological review.}
The manuscript documents where the technique does not help with the same
candor as where it does: zero root-context reduction, checker execution time
remaining flat (39.69\,s vs.\ 39.77\,s), a strict-gate overhead of roughly
five seconds over native pytest on the small harness, and fixed-share
tracking losing to a simple window rule on measured streams. The trust model
and the publication-soundness result are stated as conditional on trusted
checking and protected state, not as unconditional guarantees. This is
\begin{em}not pasted here as rhetoric\end{em}; each of these statements is a
measured or proved claim with a cited table or theorem in this manuscript.

\paragraph{The value-proposition question, answered directly.}
A skeptical reviewer will estimate the net payoff as follows. Padded byte
savings of up to 56.25\% shrink to 5.80--47.92\% after ordinary whole-epoch
DEFLATE; root-status prompt savings are exactly 0\%; and local testing is
roughly five seconds slower under the strict wrapper. We therefore do not
ask a reader to adopt HACT as a generic local-coding accelerator or as a
drop-in CI replacement. The defendable use is a setting where
\emph{reduced wire or log volume under a fixed per-packet cap is itself the
requirement}: embedded and space/satellite software updates, tactical or
edge computing over low-bandwidth links, and air-gapped regulatory audit
trails that must preserve intermediate verification trees across a narrow
link. In those settings the added system complexity (migration pricing,
block-backbone compile bounds, generation fencing) buys a bounded, measured
reduction in the bytes that must cross the constrained link. That is the
claim we make.

\paragraph{Where the present empirical scale is a limitation.}
The source cohort is three Python repositories (networkx, toolz, future)
with four matched candidates each (twelve paired candidates in total), plus
a scripted harness fixture of nine episodes with two workers.android The
fresh-checker and harness numbers are definitely a prototype-scale study,
not an archival industrial corpus. The compiler workload is synthetic; the
transport experiment uses a loopback interface with an application-rate
limiter rather than a physical cellular, IoT, or inter-datacenter link with
packet loss and jitter; and no hosted LLM, SWE-bench, or real historical
bug-cohort is evaluated. We state these limitations explicitly because they
define the boundary of the current artifact.

\begin{em}This is not a claim that the method is validated at production
scale; it is a reproducible prototype with honest preliminary bounds.\end{em}

\paragraph{Recommended venue path.}
Given the empirical scale, the appropriate first public venue is a strong
software-engineering or systems \emph{conference}---ISSTA, ASE, FSE, or
Middleware---whose reviewers accept an innovative architectural prototype
with honest preliminary empirical bounds. An extended, archival journal
version (ACM TOSEM, IEEE TSE) would then require (i) expanding from twelve
to 50--100 real historical pull requests or commits across multiple
languages or large industrial registries; (ii) testing registries with
$n\ge 2{,}000$--$10{,}000$ checks where block-backbone compilation is
necessary rather than a microbenchmark; (iii) a physically constrained
network or real edge uplink; and (iv) a hosted-model study with frozen
issue IDs, acceptance tests, model version, decoding, costs, and seeds.
None of those is claimed here; they are the accepted cost of the next tier.
"""
w("positioning.tex", positioning)
