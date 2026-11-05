# TSE Novelty Statement

**Manuscript:** Verified Context Retirement (Research manuscript v8.0)
**Target venue:** IEEE Transactions on Software Engineering — Regular (Journal First)
**Length:** 200 words

---

Criterion (a): This manuscript reports completely new research results, not
previously reported. It formalizes a question no prior software engineering
study has addressed: when can a long-horizon software agent stop remembering
its execution history without losing the evidence and obligations needed to
finish correctly, and in which cost regime does retirement pay? Prior
agent-memory work either retains history fully or compresses it heuristically,
offering neither an acceptance contract linking retention policy to
end-of-episode correctness nor a cost model for retirement. We contribute:
(1) a pre-registered, factorial, frozen-protocol mechanism study crossing
seven retention policies with a scheduler factor; (2) a conversion
heuristic---history into verified interface bindings, a typed
pending-obligation set, and declared dependencies---that provably suffices for
zero staleness and zero obligation loss, while lossy summary/reset policies
fail a frozen acceptance contract; (3) a closed-form break-even rule
(round-trip price of about 1,364 B) at which retirement pays; and (4)
regime-conditional payoffs: 44% fewer resubmitted operations, 29.6% lower
round-trip-regime cost, 87.5% makespan reduction, persisting at 4x horizon and
reproduced on a real repository trace replay. Criterion (b): This is not an
extension of prior work solely with proofs, algorithms, empirical results, or
minor variants; it introduces a new problem, formalism, and measured mechanism.

*(200 words)*
