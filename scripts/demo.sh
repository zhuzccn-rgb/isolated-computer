#!/usr/bin/env bash
# Use system dependencies first; the current Codex Linux host also has local caches.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
resolve() {
  local program="$1" fallback="$2" result
  result="$(command -v "$program" || true)"
  if [[ -n "$result" ]]; then printf '%s\n' "$result"
  elif [[ -x "$fallback" ]]; then printf '%s\n' "$fallback"
  else printf 'Missing %s; install dependencies described in README.md.\n' "$program" >&2; return 1
  fi
}
demo_node="${IC_DEMO_NODE:-$(resolve node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")}"
if [[ "${1:-}" == --stop ]]; then exec "$demo_node" scripts/demo.mjs --stop; fi
export IC_TEST_XVFB="${IC_TEST_XVFB:-$(resolve Xvfb /tmp/ic-linux-deps/usr/bin/Xvfb)}"
export IC_XCLIP="${IC_XCLIP:-$(resolve xclip /tmp/ic-linux-deps/usr/bin/xclip)}"
export IC_TEST_OPENBOX="${IC_TEST_OPENBOX:-$(resolve openbox /tmp/ic-firefox-wm/usr/bin/openbox)}"
if [[ "$IC_TEST_OPENBOX" == /tmp/ic-firefox-wm/usr/bin/openbox ]]; then
  export IC_TEST_OPENBOX_LIB="${IC_TEST_OPENBOX_LIB:-/tmp/ic-firefox-wm/usr/lib/x86_64-linux-gnu}"
fi
exec "$demo_node" scripts/demo.mjs "$@"
