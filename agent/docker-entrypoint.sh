#!/bin/sh
set -eu

ENV_FILE="${TUNEX_AGENT_ENV_FILE:-/run/tunex-agent/agent.env}"
if [ ! -r "$ENV_FILE" ]; then
  echo "tunex-agent: missing readable env file: $ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

exec /usr/local/bin/tunex-agent "$@"
