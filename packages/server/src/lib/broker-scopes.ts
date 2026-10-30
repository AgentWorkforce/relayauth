/**
 * Broker scopes authorize minting credentials for an org other than the
 * caller's own (the RelayHistory assertion broker mints for every org it
 * fronts). Ordinary admin grants must never imply them: `manage` implies
 * `create` and `*` implies everything, so an org admin holding
 * `relayauth:*:manage:*` would otherwise satisfy a broker check and mint
 * assertions for another tenant.
 *
 * A broker scope is therefore satisfied only by the exact literal string, and
 * can only be delegated (for example onto a new API key) by a caller that holds
 * that exact literal itself.
 */
export function isBrokerScope(scope: string): boolean {
  const parts = scope.split(":");
  return parts[0] === "relayauth" && parts[1] === "assertion";
}

/** Scope matcher for broker routes: exact literal only, no implication. */
export function matchBrokerScopeExactly(
  requiredScope: string,
  grantedScopes: string[],
): boolean {
  return grantedScopes.includes(requiredScope);
}

/**
 * Returns the first requested broker scope the caller does not hold verbatim,
 * or undefined when every requested broker scope is held exactly.
 */
export function firstUndelegableBrokerScope(
  callerScopes: string[],
  requestedScopes: string[],
): string | undefined {
  return requestedScopes.find(
    (scope) => isBrokerScope(scope) && !callerScopes.includes(scope),
  );
}
