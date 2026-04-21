export type ObserverEvent =
  | {
      type: "token.verified";
      timestamp: string;
      payload: {
        sub: string;
        org: string;
        scopes: string[];
        expiresIn: number;
      };
    }
  | {
      type: "token.invalid";
      timestamp: string;
      payload: {
        reason: string;
        sub?: string;
        org?: string;
      };
    }
  | {
      type: "scope.check";
      timestamp: string;
      payload: {
        agent: string;
        requestedScope: string;
        grantedScopes: string[];
        result: "allowed" | "denied";
        matchedScope?: string;
        evaluation: ScopeEvaluation;
      };
    }
  | {
      type: "scope.denied";
      timestamp: string;
      payload: {
        agent: string;
        requestedScope: string;
        grantedScopes: string[];
        result: "denied";
        matchedScope?: string;
        evaluation: ScopeEvaluation;
        reason: string;
      };
    }
  | {
      type: "identity.created";
      timestamp: string;
      payload: {
        id: string;
        org: string;
        name?: string;
      };
    }
  | {
      type: "budget.alert";
      timestamp: string;
      payload: {
        id: string;
        org: string;
        usage: number;
        limit: number;
      };
    };

type ScopeEvaluation = {
  plane: string;
  resource: string;
  action: string;
  path: string;
};

type ObserverListener = (event: ObserverEvent) => void;

type ObserverEventFilter = {
  orgId?: string;
  types?: string[];
};

type Subscription = {
  listener: ObserverListener;
  filter?: ObserverEventFilter;
};

export function now(): string {
  return new Date().toISOString();
}

export class ObserverEventBus {
  readonly #subscriptions = new Set<Subscription>();

  subscribe(listener: ObserverListener, filter?: ObserverEventFilter): () => void {
    const subscription: Subscription = {
      listener,
      filter: normalizeFilter(filter),
    };

    this.#subscriptions.add(subscription);

    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  emit(event: ObserverEvent): void {
    for (const subscription of this.#subscriptions) {
      if (!matchesFilter(event, subscription.filter)) {
        continue;
      }

      try {
        subscription.listener(event);
      } catch (error) {
        console.error("Observer event listener failed", error);
      }
    }
  }

  listenerCount(): number {
    return this.#subscriptions.size;
  }
}

export const observerBus = new ObserverEventBus();

export function emitObserverEvent(event: ObserverEvent): void {
  try {
    observerBus.emit(event);
  } catch {
    // Observer failures must not affect request handling.
  }
}

function normalizeFilter(filter: ObserverEventFilter | undefined): ObserverEventFilter | undefined {
  if (!filter) {
    return undefined;
  }

  return {
    orgId: filter.orgId,
    types: filter.types ? [...filter.types] : undefined,
  };
}

function matchesFilter(event: ObserverEvent, filter: ObserverEventFilter | undefined): boolean {
  if (!filter) {
    return true;
  }

  if (filter.types && !filter.types.includes(event.type)) {
    return false;
  }

  if (filter.orgId !== undefined && eventOrg(event) !== filter.orgId) {
    return false;
  }

  return true;
}

function eventOrg(event: ObserverEvent): string | undefined {
  const payload = event.payload as Partial<{
    org: string;
    orgId: string;
    organization: string;
  }>;

  return payload.org ?? payload.orgId ?? payload.organization;
}
