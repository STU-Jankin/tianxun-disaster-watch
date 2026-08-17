export const evidenceReassignmentSql = {
  copy: `INSERT OR IGNORE INTO event_evidence (master_event_id, source, source_url, source_event_id, observed_at, role)
    SELECT ?, source, source_url, source_event_id, observed_at, role FROM event_evidence WHERE master_event_id = ?`,
  removeSource: `DELETE FROM event_evidence WHERE master_event_id = ?`,
};
