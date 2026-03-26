declare global {
  interface JsonWebKey {
    alg?: string;
    crv?: string;
    kid?: string;
    use?: string;
  }
}

export {};
