#!/usr/bin/env bash
set -euo pipefail

header='{"alg":"RS256","typ":"JWT"}'
now="$(date +%s)"
exp="$((now + ${RELAYAUTH_TTL_SECONDS:-3600}))"
jti="dev-${now}-${RANDOM}"
subject="${RELAYAUTH_SUB:-agent_dev_admin}"
org="${RELAYAUTH_ORG:-org_dev}"
workspace="${RELAYAUTH_WORKSPACE:-ws_dev}"
sponsor="${RELAYAUTH_SPONSOR:-user_dev}"
scopes_json="${RELAYAUTH_SCOPES_JSON:-[\"*:*:*:*\"]}"
issuer="${RELAYAUTH_ISSUER:-relayauth:dev}"
audience_json="${RELAYAUTH_AUDIENCE_JSON:-[\"relayauth\",\"relayfile\"]}"
token_type="${RELAYAUTH_TOKEN_TYPE:-access}"
private_key_pem="${RELAYAUTH_SIGNING_KEY_PEM:-}"
if [[ -z "${private_key_pem}" ]]; then
  printf 'RELAYAUTH_SIGNING_KEY_PEM is required to generate RS256 dev tokens\n' >&2
  exit 1
fi
payload="{\"sub\":\"${subject}\",\"org\":\"${org}\",\"wks\":\"${workspace}\",\"scopes\":${scopes_json},\"sponsorId\":\"${sponsor}\",\"sponsorChain\":[\"${sponsor}\"],\"token_type\":\"${token_type}\",\"iss\":\"${issuer}\",\"aud\":${audience_json},\"iat\":${now},\"exp\":${exp},\"jti\":\"${jti}\"}"

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

header_b64="$(printf '%s' "${header}" | base64url)"
payload_b64="$(printf '%s' "${payload}" | base64url)"
unsigned="${header_b64}.${payload_b64}"
private_key_file="$(mktemp)"
trap 'rm -f "${private_key_file}"' EXIT
printf '%s' "${private_key_pem}" > "${private_key_file}"
signature="$(printf '%s' "${unsigned}" | openssl dgst -sha256 -sign "${private_key_file}" -binary | base64url)"

printf '%s.%s\n' "${unsigned}" "${signature}"
