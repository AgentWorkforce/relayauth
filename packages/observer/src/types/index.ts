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
      type: "identity.updated";
      timestamp: string;
      payload: {
        id: string;
        org: string;
        name?: string;
      };
    }
  | {
      type: "identity.deleted";
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
        reason?: string;
      };
    }
  | {
      type: "budget.suspended";
      timestamp: string;
      payload: {
        id: string;
        org: string;
        usage: number;
        limit: number;
        reason?: string;
      };
    };

type ScopeEvaluation = {
  plane: string;
  resource: string;
  action: string;
  path: string;
};
