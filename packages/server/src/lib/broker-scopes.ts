/**
 * Broker scopes authorize minting credentials for an org other than the
 * caller's own (the RelayHistory assertion broker mints for every org it
 * fronts). Ordinary admin grants must never imply them: `manage` implies
 * `create` and `*` implies everything, so an org admin holding
 * `relayauth:*:manage:*` would otherwise satisfy a broker check and mint
 * assertions for another tenant.
 *
 * A broker scope is therefore satisfied only by the exact literal string, and
 * can only be delegated (for example onto a new API key) by a plain API key
 * that holds that exact literal itself.
 */
export function isBrokerScope(scope: string): boolean {
  const parts = scope.split(":");
  return parts[0] === "relayauth" && parts[1] === "assertion";
}

/**
 * Platform scopes (`relayauth:platform:*`) are held by operator-provisioned
 * keys only. Like broker scopes they are satisfied only by the exact literal,
 * and unlike broker scopes they are never delegable through the API, not even
 * by a key that holds them: the operator step is the only way to create one.
 */
export function isPlatformScope(scope: string): boolean {
  const parts = scope.split(":");
  return parts[0] === "relayauth" && parts[1] === "platform";
}

/** Scope matcher for broker routes: exact literal only, no implication. */
export function matchBrokerScopeExactly(
  requiredScope: string,
  grantedScopes: string[],
): boolean {
  return grantedScopes.includes(requiredScope);
}

/**
 * Returns the first requested broker scope the caller may not delegate, or
 * undefined when every requested broker scope is delegable.
 *
 * Only a plain API key holding the exact literal may delegate a broker scope.
 * Bearer tokens do not count: identity scopes are freely assignable within an
 * org, so a JWT carrying the literal proves nothing about broker authority.
 * Workspace tokens do not count either, for the same reason.
 *
 * Platform scopes are never delegable, whoever the caller is.
 */
export function firstUndelegableBrokerScope(
  caller: { scopes: string[]; isPlainApiKey: boolean },
  requestedScopes: string[],
): string | undefined {
  return requestedScopes.find(
    (scope) =>
      isPlatformScope(scope) ||
      isBrokerScope(scope) &&
      !(caller.isPlainApiKey && caller.scopes.includes(scope)),
  );
}
