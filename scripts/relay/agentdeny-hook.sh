#!/usr/bin/env bash
# Sourced by relay run into the agent's shell.
# Checks commands against .agentdeny before execution.

_relay_deny_file="${RELAY_WORKSPACE:-$(pwd)}/.agentdeny"
if [[ ! -f "${_relay_deny_file}" ]]; then
  _relay_deny_file="$(pwd)/../.agentdeny"  # check project root
fi

_relay_check_deny() {
  local cmd="$1"
  [[ -f "${_relay_deny_file}" ]] || return 0

  while IFS= read -r pattern; do
    # Skip comments and empty lines
    [[ -z "${pattern}" || "${pattern}" == \#* ]] && continue
    pattern="$(echo "${pattern}" | sed 's/^ *//;s/ *$//')"

    # Convert glob pattern to regex
    local regex="^$(echo "${pattern}" | sed 's/*/.*/g')$"
    if echo "${cmd}" | grep -qE "${regex}" 2>/dev/null; then
      echo "relay: command denied by .agentdeny: ${cmd}" >&2
      echo "relay: matching rule: ${pattern}" >&2
      return 1
    fi
  done < "${_relay_deny_file}"
  return 0
}

# Install hook based on shell
if [[ -n "${ZSH_VERSION:-}" ]]; then
  autoload -Uz add-zsh-hook
  _relay_preexec() { _relay_check_deny "$1" || { kill -INT $$; return 1; } }
  add-zsh-hook preexec _relay_preexec
elif [[ -n "${BASH_VERSION:-}" ]]; then
  _relay_debug_trap() {
    [[ "${BASH_COMMAND}" == "_relay_debug_trap" ]] && return
    _relay_check_deny "${BASH_COMMAND}" || return 1
  }
  trap '_relay_debug_trap' DEBUG
fi
