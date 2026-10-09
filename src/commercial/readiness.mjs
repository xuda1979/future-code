/** Human-reviewed business readiness checklist, never a legal certification. */
export const REQUIRED_GATES = Object.freeze([
  ['source-rights', 'Provenance and ownership reviewed by qualified counsel'],
  ['dependency-rights', 'Dependency and imported-source distribution rights reviewed'],
  ['security', 'Untrusted execution, secrets and approval boundaries reviewed'],
  ['live-evidence', 'Live-model trials with independent acceptance and cost disclosure'],
  ['customer-pilot', 'External design partner has accepted a verified pilot outcome'],
]);
export function checkReadiness(manifest) {
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.gates)) throw new Error('invalid release checklist');
  const seen = new Set();
  const gates = REQUIRED_GATES.map(([id, description]) => {
    const entries = manifest.gates.filter(x => x && x.id === id);
    if (entries.length !== 1) throw new Error(`release checklist requires one ${id} gate`);
    seen.add(id);
    const { status, reviewer, reviewedAt, evidence } = entries[0];
    if (!['PENDING', 'REVIEWED'].includes(status)) throw new Error(`invalid ${id} status`);
    const complete = status === 'REVIEWED' && typeof reviewer === 'string' && reviewer.trim() !== '' &&
      typeof evidence === 'string' && evidence.trim() !== '' && typeof reviewedAt === 'string' &&
      !Number.isNaN(Date.parse(reviewedAt));
    return { id, description, status: complete ? 'REVIEWED' : 'PENDING', evidence: complete ? evidence : null };
  });
  if (manifest.gates.some(x => !seen.has(x?.id))) throw new Error('unknown or duplicate checklist gate');
  return { schema: 1, advisory: true, status: gates.every(g => g.status === 'REVIEWED') ? 'REVIEWED_NOT_CERTIFIED' : 'BLOCKED',
    gates, notice: 'Self-attested readiness metadata is not legal approval, security certification, or permission to redistribute imported code.' };
}
