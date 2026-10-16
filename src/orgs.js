// Configured orgs and their runtime validity. An org marked invalid (the agent left it) stays invalid until the
// operator clears it; no other org is used in its place.
export function createOrgs({ config, state, auth, logger, now = Date.now }) {
  const configured = config.orgs;
  const invalid = () => state.read('orgs', {});

  return {
    primary: config.org_id,
    ids: () => Object.keys(configured),
    isConfigured: (orgId) => Object.hasOwn(configured, orgId),
    isInvalid: (orgId) => Object.hasOwn(invalid(), orgId),

    markInvalid(orgId, code) {
      if (!Object.hasOwn(configured, orgId) || Object.hasOwn(invalid(), orgId)) return;
      state.update('orgs', {}, (d) => { d[orgId] = { reason: code, since: new Date(now()).toISOString() }; });
      const msg = orgId === config.org_id
        ? `primary org ${orgId} is invalid (${code}); pulling has stopped for ALL orgs; change the primary org in config to resume`
        : `org ${orgId} rejected this agent (${code}); its orders are no longer pulled or executed`;
      state.setAlert(`org_invalid:${orgId}`, msg);
      logger.warn(`${msg}; installed content is left as is`);
    },

    // The agent's member id in that org: from config, else from the org-scoped token.
    async agentId(orgId) {
      const id = configured[orgId]?.member_id ?? await auth.memberId(orgId);
      if (!id) throw new Error(`no member_id for org ${orgId}`);
      return id;
    },
  };
}
