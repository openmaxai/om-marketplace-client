export const SUSPENDED_PROBE_MS = 60 * 60 * 1000;
export const REASON_SUSPENDED = 'member_suspended';
export const REASON_DEPARTED = 'member_departed';

export function membershipMessage(orgId, state, primary) {
  const where = primary ? `primary org ${orgId}` : `org ${orgId}`;
  const impact = primary ? 'pulling has stopped for ALL orgs' : 'its orders are no longer pulled or executed';
  return state === 'suspended'
    ? `This agent's membership in ${where} is suspended; ${impact}. Retrying hourly and resuming automatically once restored. To restore sooner, contact the org admin.`
    : `This agent has left ${where}; ${impact}. Ask the org admin to re-add it, or change the primary org in config (this drops the original org's revocation set and queue).`;
}

// Configured orgs and their membership state. MEMBER_LEFT_ORG with reason member_suspended marks the org suspended:
// it is re-probed hourly and cleared on success. Any other reason marks it invalid: it is probed once per process
// start only. No other org is ever used in its place.
export function createOrgs({ config, state, auth, logger, now = Date.now }) {
  const configured = config.orgs;
  const marks = () => state.read('orgs', {});
  const startupProbe = new Set();
  const iso = (t) => new Date(t).toISOString();
  const alertKey = (orgId) => `org_membership:${orgId}`;
  // Entries written before suspension was tracked carry no state and count as invalid.
  const stateOf = (orgId) => {
    const m = marks();
    if (!Object.hasOwn(m, orgId)) return null;
    return m[orgId].state === 'suspended' ? 'suspended' : 'invalid';
  };

  return {
    primary: config.org_id,
    ids: () => Object.keys(configured),
    isConfigured: (orgId) => Object.hasOwn(configured, orgId),
    // null (usable), 'suspended' or 'invalid'.
    membership: stateOf,
    isBlocked: (orgId) => stateOf(orgId) !== null,

    // True when a request through orgId may be sent now; a due probe of a blocked org is consumed by the call.
    mayContact(orgId) {
      const m = marks()[orgId];
      if (!m) return true;
      const t = now();
      if (m.state === 'suspended') {
        if (t < Date.parse(m.next_probe_at ?? '')) return false;
      } else if (startupProbe.has(orgId)) {
        return false;
      }
      startupProbe.add(orgId);
      state.update('orgs', {}, (d) => { if (d[orgId]) d[orgId].next_probe_at = iso(t + SUSPENDED_PROBE_MS); });
      return true;
    },

    markLeft(orgId, reason) {
      if (!Object.hasOwn(configured, orgId)) return;
      const next = reason === REASON_SUSPENDED ? 'suspended' : 'invalid';
      const prev = stateOf(orgId);
      const t = now();
      startupProbe.add(orgId);
      state.update('orgs', {}, (d) => {
        d[orgId] = {
          state: next,
          reason: reason || null,
          since: prev === next ? d[orgId].since : iso(t),
          next_probe_at: iso(t + SUSPENDED_PROBE_MS),
        };
      });
      if (prev === next) return;
      const msg = membershipMessage(orgId, next, orgId === config.org_id);
      state.setAlert(alertKey(orgId), msg);
      logger.warn(msg);
    },

    markActive(orgId) {
      const prev = stateOf(orgId);
      if (!prev) return;
      state.update('orgs', {}, (d) => { delete d[orgId]; });
      state.clearAlert(alertKey(orgId));
      logger.info(`membership in org ${orgId} is active again; pulling resumes`);
    },

    // The agent's member id in that org: from config, else from the org-scoped token.
    async agentId(orgId) {
      const id = configured[orgId]?.member_id ?? await auth.memberId(orgId);
      if (!id) throw new Error(`no member_id for org ${orgId}`);
      return id;
    },
  };
}
