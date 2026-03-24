export interface VerifyOptions {
  jwksUrl?: string;
  issuer?: string;
  audience?: string[];
  maxAge?: number;
}

export class TokenVerifier {
  readonly options?: VerifyOptions;

  constructor(options?: VerifyOptions) {
    this.options = options;
  }

  // Methods added by workflow 013
}
