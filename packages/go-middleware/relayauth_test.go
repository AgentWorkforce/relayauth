package relayauth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestVerifyToken_Valid(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, _ := newJWKSServer(t, privateKey, "kid-valid")
	defer jwksServer.Close()

	now := time.Now().Unix()
	remaining := 42.0
	claims := validClaims(now)
	claims.Meta = map[string]string{"env": "test"}
	claims.Budget = &TokenBudget{Remaining: &remaining}

	token := mustSignToken(t, privateKey, "kid-valid", claims)
	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		Issuer:   claims.Iss,
		Audience: []string{"relay-api"},
	})

	got, err := verifier.Verify(token)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if got.Sub != claims.Sub {
		t.Fatalf("Verify() sub = %q, want %q", got.Sub, claims.Sub)
	}
	if got.Meta["env"] != "test" {
		t.Fatalf("Verify() meta env = %q, want test", got.Meta["env"])
	}
	if got.Budget == nil || got.Budget.Remaining == nil || *got.Budget.Remaining != remaining {
		t.Fatalf("Verify() budget remaining = %#v, want %v", got.Budget, remaining)
	}
}

func TestVerifyToken_Expired(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, _ := newJWKSServer(t, privateKey, "kid-expired")
	defer jwksServer.Close()

	now := time.Now().Unix()
	claims := validClaims(now)
	claims.Exp = now - 1
	token := mustSignToken(t, privateKey, "kid-expired", claims)

	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		Issuer:   claims.Iss,
		Audience: []string{"relay-api"},
	})

	_, err := verifier.Verify(token)
	if !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("Verify() error = %v, want %v", err, ErrTokenExpired)
	}
}

func TestVerifyToken_InvalidSignature(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, _ := newJWKSServer(t, privateKey, "kid-invalid-sig")
	defer jwksServer.Close()

	now := time.Now().Unix()
	claims := validClaims(now)
	token := mustSignToken(t, privateKey, "kid-invalid-sig", claims)
	tampered := tamperPayload(token)

	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		Issuer:   claims.Iss,
		Audience: []string{"relay-api"},
	})

	_, err := verifier.Verify(tampered)
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("Verify() error = %v, want %v", err, ErrInvalidToken)
	}
}

func TestVerifyToken_WrongAudience(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, _ := newJWKSServer(t, privateKey, "kid-wrong-aud")
	defer jwksServer.Close()

	now := time.Now().Unix()
	claims := validClaims(now)
	claims.Aud = []string{"something-else"}
	token := mustSignToken(t, privateKey, "kid-wrong-aud", claims)

	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		Issuer:   claims.Iss,
		Audience: []string{"relay-api"},
	})

	_, err := verifier.Verify(token)
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("Verify() error = %v, want %v", err, ErrInvalidToken)
	}
}

func TestVerifyToken_WrongIssuer(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, _ := newJWKSServer(t, privateKey, "kid-wrong-issuer")
	defer jwksServer.Close()

	now := time.Now().Unix()
	claims := validClaims(now)
	claims.Iss = "https://wrong.example.test"
	token := mustSignToken(t, privateKey, "kid-wrong-issuer", claims)

	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		Issuer:   "https://relayauth.example.test",
		Audience: []string{"relay-api"},
	})

	_, err := verifier.Verify(token)
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("Verify() error = %v, want %v", err, ErrInvalidToken)
	}
}

func TestFetchJWKS(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, hits := newJWKSServer(t, privateKey, "kid-fetch")
	defer jwksServer.Close()

	verifier := NewVerifier(VerifyOptions{JWKSUrl: jwksServer.URL})
	keys, err := verifier.fetchJWKS(false)
	if err != nil {
		t.Fatalf("fetchJWKS() error = %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("fetchJWKS() len(keys) = %d, want 1", len(keys))
	}
	if keys[0].Kid != "kid-fetch" {
		t.Fatalf("fetchJWKS() kid = %q, want kid-fetch", keys[0].Kid)
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Fatalf("fetchJWKS() server hits = %d, want 1", got)
	}
}

func TestJWKSCaching(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, hits := newJWKSServer(t, privateKey, "kid-cache")
	defer jwksServer.Close()

	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		CacheTTL: time.Minute,
	})

	if _, err := verifier.fetchJWKS(false); err != nil {
		t.Fatalf("first fetchJWKS() error = %v", err)
	}
	if _, err := verifier.fetchJWKS(false); err != nil {
		t.Fatalf("second fetchJWKS() error = %v", err)
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Fatalf("fetchJWKS() server hits = %d, want 1", got)
	}
}

func TestMiddleware(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, _ := newJWKSServer(t, privateKey, "kid-middleware")
	defer jwksServer.Close()

	now := time.Now().Unix()
	claims := validClaims(now)
	token := mustSignToken(t, privateKey, "kid-middleware", claims)

	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		Issuer:   claims.Iss,
		Audience: []string{"relay-api"},
	})

	var nextCalled bool
	handler := verifier.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		got, ok := ClaimsFromContext(r.Context())
		if !ok || got == nil {
			t.Fatalf("ClaimsFromContext() = %v, %v, want non-nil claims", got, ok)
		}
		if got.Sub != claims.Sub {
			t.Fatalf("ClaimsFromContext() sub = %q, want %q", got.Sub, claims.Sub)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if !nextCalled {
		t.Fatal("Middleware() did not call next handler")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("Middleware() status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestRequireScope(t *testing.T) {
	privateKey := mustGenerateRSAKey(t)
	jwksServer, _ := newJWKSServer(t, privateKey, "kid-scope")
	defer jwksServer.Close()

	baseClaims := validClaims(time.Now().Unix())
	verifier := NewVerifier(VerifyOptions{
		JWKSUrl:  jwksServer.URL,
		Issuer:   baseClaims.Iss,
		Audience: []string{"relay-api"},
	})

	t.Run("allowed", func(t *testing.T) {
		claims := baseClaims
		claims.Scopes = []string{"relayauth:token:read:*"}
		token := mustSignToken(t, privateKey, "kid-scope", claims)

		var nextCalled bool
		handler := verifier.Middleware(RequireScope("relayauth:token:read:*")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		})))

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if !nextCalled {
			t.Fatal("RequireScope() did not call next handler for allowed scope")
		}
		if rec.Code != http.StatusNoContent {
			t.Fatalf("RequireScope() status = %d, want %d", rec.Code, http.StatusNoContent)
		}
	})

	t.Run("denied", func(t *testing.T) {
		claims := baseClaims
		claims.Scopes = []string{"relayauth:token:read:*"}
		token := mustSignToken(t, privateKey, "kid-scope", claims)

		var nextCalled bool
		handler := verifier.Middleware(RequireScope("relayauth:token:manage:*")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusNoContent)
		})))

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if nextCalled {
			t.Fatal("RequireScope() called next handler for denied scope")
		}
		if rec.Code != http.StatusForbidden {
			t.Fatalf("RequireScope() status = %d, want %d", rec.Code, http.StatusForbidden)
		}
	})
}

func TestScopeMatching(t *testing.T) {
	if !MatchScope("relaycast:channel:read:general", "relaycast:*:*:*") {
		t.Fatal("MatchScope() = false, want true")
	}
	if MatchScope("cloud:workflow:run:*", "relaycast:*:*:*") {
		t.Fatal("MatchScope() = true, want false")
	}
}

func mustGenerateRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey() error = %v", err)
	}
	return key
}

func validClaims(now int64) Claims {
	nbf := now - 60
	maxActions := 100.0
	return Claims{
		Sub:           "agent_test_123",
		Org:           "org_test_123",
		Wks:           "ws_test_123",
		Scopes:        []string{"relaycast:channel:read:*"},
		SponsorID:     "user_test_123",
		SponsorChain:  []string{"user_test_123", "agent_test_123"},
		TokenType:     "access",
		Iss:           "https://relayauth.example.test",
		Aud:           []string{"relay-api", "relaycast"},
		Exp:           now + 3600,
		Iat:           now - 60,
		Jti:           "tok_test_123",
		Nbf:           &nbf,
		Sid:           "session_test_123",
		Meta:          map[string]string{"team": "sdk"},
		ParentTokenID: "tok_parent_123",
		Budget:        &TokenBudget{MaxActionsPerHour: &maxActions},
	}
}

func newJWKSServer(t *testing.T, privateKey *rsa.PrivateKey, kid string) (*httptest.Server, *int32) {
	t.Helper()

	publicJWK, err := rsaPublicJWK(privateKey, kid)
	if err != nil {
		t.Fatalf("rsaPublicJWK() error = %v", err)
	}

	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(jwksResponse{Keys: []jwk{publicJWK}}); err != nil {
			t.Fatalf("json.Encode() error = %v", err)
		}
	}))

	return server, &hits
}

func mustSignToken(t *testing.T, privateKey *rsa.PrivateKey, kid string, claims Claims) string {
	t.Helper()

	headerJSON, err := json.Marshal(map[string]string{
		"alg": "RS256",
		"typ": "JWT",
		"kid": kid,
	})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}

	encodedHeader := base64.RawURLEncoding.EncodeToString(headerJSON)
	encodedPayload := base64.RawURLEncoding.EncodeToString(payloadJSON)
	signingInput := encodedHeader + "." + encodedPayload
	sum := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("rsa.SignPKCS1v15() error = %v", err)
	}

	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func tamperPayload(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return token
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) == 0 {
		return token
	}
	payload[0] ^= 1
	parts[1] = base64.RawURLEncoding.EncodeToString(payload)
	return strings.Join(parts, ".")
}
