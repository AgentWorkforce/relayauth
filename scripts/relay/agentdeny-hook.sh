#!/usr/bin/env bash
# Sourced by relay run into the agent's shell.
# Checks commands against .agentdeny before execution.

_relay_deny_file="${RELAY_WORKSPACE:-$(pwd)}/.agentdeny"
if [[ ! -f "${_relay_deny_file}" ]]; then
  _relay_deny_file="$(pwd)/../.agentdeny"  # check project root
fi

_relay_glob_to_regex() {
  # Properly convert a glob pattern to regex by escaping all regex
  # metacharacters first, then converting glob wildcards.
  local glob="$1"
  # Escape regex metacharacters individually for portability
  local escaped
  escaped="$(printf '%s' "${glob}" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/\./\\./g' \
    -e 's/+/\\+/g' \
    -e 's/?/\\?/g' \
    -e 's/\[/\\[/g' \
    -e 's/\]/\\]/g' \
    -e 's/(/\\(/g' \
    -e 's/)/\\)/g' \
    -e 's/{/\\{/g' \
    -e 's/}/\\}/g' \
    -e 's/|/\\|/g' \
    -e 's/\^/\\^/g' \
    -e 's/\$/\\$/g' \
  )"
  # Convert glob * to .* and glob ? (now \?) back to single-char match
  escaped="$(printf '%s' "${escaped}" | sed -e 's/\*/.*/g' -e 's/\\?/./g')"
  printf '%s' "^${escaped}$"
}

_relay_extract_inner_commands() {
  # Extract commands that may be hidden inside subshells, command
  # substitution, or backgrounded invocations so they can also be checked.
  local cmd="$1"
  # bash -c '...' / sh -c '...'
  if printf '%s' "${cmd}" | grep -qE '(ba)?sh\s+-c\s+'; then
    printf '%s' "${cmd}" | sed -n "s/.*sh[[:space:]]*-c[[:space:]]*['\"]\\{0,1\\}\([^'\"]*\\)['\"]\\{0,1\\}.*/\1/p"
  fi
  # $(...) command substitution
  if printf '%s' "${cmd}" | grep -qF '$('; then
    printf '%s' "${cmd}" | grep -oE '\$\([^)]+\)' | sed 's/^\$(\(.*\))$/\1/'
  fi
  # `...` backtick substitution
  if printf '%s' "${cmd}" | grep -qF '`'; then
    printf '%s' "${cmd}" | grep -oE '`[^`]+`' | sed 's/^`\(.*\)`$/\1/'
  fi
  # Backgrounded command (strip trailing &)
  if printf '%s' "${cmd}" | grep -qE '&\s*$'; then
    printf '%s' "${cmd}" | sed 's/[[:space:]]*&[[:space:]]*$//'
  fi
}

_relay_check_deny() {
  local cmd="$1"
  [[ -f "${_relay_deny_file}" ]] || return 0

  # Build list of commands to check: the original plus any inner commands
  local -a cmds_to_check=("${cmd}")
  local inner
  while IFS= read -r inner; do
    [[ -n "${inner}" ]] && cmds_to_check+=("${inner}")
  done < <(_relay_extract_inner_commands "${cmd}")

  while IFS= read -r pattern; do
    # Skip comments and empty lines
    [[ -z "${pattern}" || "${pattern}" == \#* ]] && continue
    pattern="$(printf '%s' "${pattern}" | sed 's/^ *//;s/ *$//')"

    local regex
    regex="$(_relay_glob_to_regex "${pattern}")"
    local check_cmd
    for check_cmd in "${cmds_to_check[@]}"; do
      if printf '%s' "${check_cmd}" | grep -qE "${regex}" 2>/dev/null; then
        echo "relay: command denied by .agentdeny: ${cmd}" >&2
        echo "relay: matching rule: ${pattern}" >&2
        return 1
      fi
    done
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
