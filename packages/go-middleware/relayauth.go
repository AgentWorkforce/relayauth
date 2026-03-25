package relayauth

import (
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

const defaultCacheTTL = 5 * time.Minute
const clockSkewLeeway = 30 * time.Second

var (
	ErrInvalidToken         = errors.New("invalid access token")
	ErrTokenExpired         = errors.New("token has expired")
	ErrMissingAuthorization = errors.New("missing authorization header")
	ErrInsufficientScope    = errors.New("insufficient scope")
)

// TokenBudget mirrors the optional token budget object.
type TokenBudget struct {
	MaxActionsPerHour *float64 `json:"maxActionsPerHour,omitempty"`
	MaxCostPerDay     *float64 `json:"maxCostPerDay,omitempty"`
	Remaining         *float64 `json:"remaining,omitempty"`
}

// Claims represents the JWT claims in a relayauth token.
type Claims struct {
	Sub           string            `json:"sub"`
	Org           string            `json:"org"`
	Wks           string            `json:"wks"`
	Scopes        []string          `json:"scopes"`
	SponsorID     string            `json:"sponsorId"`
	SponsorChain  []string          `json:"sponsorChain"`
	TokenType     string            `json:"token_type"`
	Iss           string            `json:"iss"`
	Aud           []string          `json:"aud"`
	Exp           int64             `json:"exp"`
	Iat           int64             `json:"iat"`
	Jti           string            `json:"jti"`
	Nbf           *int64            `json:"nbf,omitempty"`
	Sid           string            `json:"sid,omitempty"`
	Meta          map[string]string `json:"meta,omitempty"`
	ParentTokenID string            `json:"parentTokenId,omitempty"`
	Budget        *TokenBudget      `json:"budget,omitempty"`
}

// VerifyOptions configures the token verifier.
type VerifyOptions struct {
	JWKSUrl  string
	Issuer   string
	Audience []string
	CacheTTL time.Duration
}

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid"`
}

type jwk struct {
	Kty string `json:"kty"`
	Use string `json:"use,omitempty"`
	Alg string `json:"alg,omitempty"`
	Kid string `json:"kid,omitempty"`
	N   string `json:"n,omitempty"`
	E   string `json:"e,omitempty"`
	Crv string `json:"crv,omitempty"`
	X   string `json:"x,omitempty"`
}

type jwksResponse struct {
	Keys []jwk `json:"keys"`
}

type cachedJWKS struct {
	expiresAt time.Time
	keys      []jwk
}

type claimsContextKey struct{}

// Verifier verifies relayauth JWTs.
type Verifier struct {
	opts   VerifyOptions
	client *http.Client

	mu    sync.RWMutex
	cache *cachedJWKS
}

// NewVerifier creates a token verifier.
func NewVerifier(opts VerifyOptions) *Verifier {
	if opts.CacheTTL <= 0 {
		opts.CacheTTL = defaultCacheTTL
	}

	return &Verifier{
		opts: opts,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

// ClaimsFromContext extracts verified claims from the request context.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(claimsContextKey{}).(*Claims)
	return claims, ok
}

func isSupportedAlgorithm(alg string) bool {
	return alg == "RS256" || alg == "EdDSA"
}

// Verify validates the JWT signature and claims and returns the parsed claims.
func (v *Verifier) Verify(tokenString string) (*Claims, error) {
	parts := strings.Split(tokenString, ".")
	if len(parts) != 3 {
		return nil, ErrInvalidToken
	}

	header, err := decodeHeader(parts[0])
	if err != nil {
		return nil, ErrInvalidToken
	}
	if header.Typ != "JWT" || !isSupportedAlgorithm(header.Alg) {
		return nil, ErrInvalidToken
	}

	claims, err := decodeClaims(parts[1])
	if err != nil {
		return nil, ErrInvalidToken
	}

	key, err := v.findKey(header.Kid, header.Alg)
	if err != nil {
		return nil, err
	}

	signature, err := decodeBase64URL(parts[2])
	if err != nil {
		return nil, ErrInvalidToken
	}

	message := []byte(parts[0] + "." + parts[1])

	switch header.Alg {
	case "RS256":
		rsaKey, ok := key.(*rsa.PublicKey)
		if !ok {
			return nil, ErrInvalidToken
		}
		sum := sha256.Sum256(message)
		if err := rsa.VerifyPKCS1v15(rsaKey, crypto.SHA256, sum[:], signature); err != nil {
			return nil, ErrInvalidToken
		}
	case "EdDSA":
		edKey, ok := key.(ed25519.PublicKey)
		if !ok {
			return nil, ErrInvalidToken
		}
		if !ed25519.Verify(edKey, message, signature) {
			return nil, ErrInvalidToken
		}
	default:
		return nil, ErrInvalidToken
	}

	if err := v.validateClaims(claims); err != nil {
		return nil, err
	}

	return claims, nil
}

// Middleware verifies the bearer token and stores claims in the request context.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, err := bearerToken(r.Header.Get("Authorization"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}

		claims, err := v.Verify(token)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), claimsContextKey{}, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireScope ensures the verified claims include a matching scope.
func RequireScope(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFromContext(r.Context())
			if !ok || claims == nil {
				http.Error(w, ErrInvalidToken.Error(), http.StatusUnauthorized)
				return
			}

			if !HasScope(claims.Scopes, scope) {
				http.Error(w, ErrInsufficientScope.Error(), http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func (v *Verifier) validateClaims(claims *Claims) error {
	if claims == nil {
		return ErrInvalidToken
	}

	if claims.Sub == "" ||
		claims.Org == "" ||
		claims.Wks == "" ||
		len(claims.Scopes) == 0 ||
		claims.SponsorID == "" ||
		len(claims.SponsorChain) == 0 ||
		(claims.TokenType != "access" && claims.TokenType != "refresh") ||
		claims.Iss == "" ||
		len(claims.Aud) == 0 ||
		claims.Exp == 0 ||
		claims.Iat == 0 ||
		claims.Jti == "" {
		return ErrInvalidToken
	}

	now := time.Now()
	leeway := int64(clockSkewLeeway.Seconds())
	nowUnix := now.Unix()
	if claims.Nbf != nil && *claims.Nbf > nowUnix+leeway {
		return ErrInvalidToken
	}
	if claims.Exp <= nowUnix-leeway {
		return ErrTokenExpired
	}
	if v.opts.Issuer != "" && claims.Iss != v.opts.Issuer {
		return ErrInvalidToken
	}
	if len(v.opts.Audience) > 0 && !containsAny(claims.Aud, v.opts.Audience) {
		return ErrInvalidToken
	}

	return nil
}

func (v *Verifier) fetchJWKS(forceRefresh bool) ([]jwk, error) {
	if v.opts.JWKSUrl == "" {
		return nil, fmt.Errorf("jwks url is required")
	}

	now := time.Now()
	if !forceRefresh {
		v.mu.RLock()
		cache := v.cache
		if cache != nil && cache.expiresAt.After(now) {
			keys := append([]jwk(nil), cache.keys...)
			v.mu.RUnlock()
			return keys, nil
		}
		v.mu.RUnlock()
	}

	req, err := http.NewRequest(http.MethodGet, v.opts.JWKSUrl, nil)
	if err != nil {
		return nil, err
	}

	resp, err := v.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("jwks fetch failed: %s", resp.Status)
	}

	var payload jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}

	keys := append([]jwk(nil), payload.Keys...)

	v.mu.Lock()
	v.cache = &cachedJWKS{
		expiresAt: now.Add(v.opts.CacheTTL),
		keys:      keys,
	}
	v.mu.Unlock()

	return append([]jwk(nil), keys...), nil
}

func (v *Verifier) findKey(kid, alg string) (crypto.PublicKey, error) {
	keys, err := v.fetchJWKS(false)
	if err != nil {
		return nil, err
	}

	match := selectJWK(keys, kid, alg)
	if match == nil {
		refreshed, err := v.fetchJWKS(true)
		if err != nil {
			return nil, err
		}
		match = selectJWK(refreshed, kid, alg)
	}
	if match == nil {
		return nil, ErrInvalidToken
	}

	switch alg {
	case "RS256":
		return match.rsaPublicKey()
	case "EdDSA":
		return match.ed25519PublicKey()
	default:
		return nil, ErrInvalidToken
	}
}

func decodeHeader(value string) (*jwtHeader, error) {
	var header jwtHeader
	if err := decodeBase64URLJSON(value, &header); err != nil {
		return nil, err
	}
	return &header, nil
}

func decodeClaims(value string) (*Claims, error) {
	var claims Claims
	if err := decodeBase64URLJSON(value, &claims); err != nil {
		return nil, err
	}
	return &claims, nil
}

func decodeBase64URLJSON(value string, target any) error {
	decoded, err := decodeBase64URL(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(decoded, target)
}

func decodeBase64URL(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(value)
}

func bearerToken(header string) (string, error) {
	if header == "" {
		return "", ErrMissingAuthorization
	}
	if !strings.HasPrefix(header, "Bearer ") {
		return "", ErrMissingAuthorization
	}

	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if token == "" {
		return "", ErrMissingAuthorization
	}
	return token, nil
}

func containsAny(actual []string, required []string) bool {
	for _, want := range required {
		for _, got := range actual {
			if got == want {
				return true
			}
		}
	}
	return false
}

func selectJWK(keys []jwk, kid, alg string) *jwk {
	var matches []jwk
	for _, key := range keys {
		if key.matches(kid, alg) {
			matches = append(matches, key)
		}
	}

	if kid != "" {
		if len(matches) == 0 {
			return nil
		}
		return &matches[0]
	}

	if len(matches) == 1 {
		return &matches[0]
	}

	return nil
}

func (j jwk) matches(kid, alg string) bool {
	if kid != "" && j.Kid != kid {
		return false
	}
	if alg != "" && j.Alg != "" && j.Alg != alg {
		return false
	}
	if j.Use != "" && j.Use != "sig" {
		return false
	}
	switch alg {
	case "RS256":
		return j.Kty == "RSA"
	case "EdDSA":
		return j.Kty == "OKP" && j.Crv == "Ed25519"
	default:
		return false
	}
}

func (j jwk) rsaPublicKey() (*rsa.PublicKey, error) {
	modulusBytes, err := decodeBase64URL(j.N)
	if err != nil {
		return nil, err
	}
	exponentBytes, err := decodeBase64URL(j.E)
	if err != nil {
		return nil, err
	}
	if len(modulusBytes) == 0 || len(exponentBytes) == 0 {
		return nil, ErrInvalidToken
	}

	n := new(big.Int).SetBytes(modulusBytes)
	e := 0
	for _, b := range exponentBytes {
		e = (e << 8) | int(b)
	}
	if e <= 0 {
		return nil, ErrInvalidToken
	}

	return &rsa.PublicKey{N: n, E: e}, nil
}

func (j jwk) ed25519PublicKey() (ed25519.PublicKey, error) {
	xBytes, err := decodeBase64URL(j.X)
	if err != nil {
		return nil, err
	}
	if len(xBytes) != ed25519.PublicKeySize {
		return nil, ErrInvalidToken
	}
	return ed25519.PublicKey(xBytes), nil
}

func rsaPublicJWK(key *rsa.PrivateKey, kid string) (jwk, error) {
	encoded, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return jwk{}, err
	}

	pubAny, err := x509.ParsePKIXPublicKey(encoded)
	if err != nil {
		return jwk{}, err
	}
	pub, ok := pubAny.(*rsa.PublicKey)
	if !ok {
		return jwk{}, ErrInvalidToken
	}

	e := big.NewInt(int64(pub.E)).Bytes()
	return jwk{
		Kty: "RSA",
		Use: "sig",
		Alg: "RS256",
		Kid: kid,
		N:   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString(e),
	}, nil
}
