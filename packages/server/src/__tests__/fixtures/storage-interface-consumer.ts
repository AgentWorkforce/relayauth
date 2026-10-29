import type { ApiKeyKind } from "../../storage/interface.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() =>
    Value extends Right ? 1 : 2
    ? true
    : false;

type Assert<Condition extends true> = Condition;

export const apiKeyKindMatchesCanonicalUnion: Assert<
  Equal<ApiKeyKind, "api_key" | "workspace_token">
> = true;
