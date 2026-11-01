#!/bin/sh
if [ -n "$FAKE_ARGS_FILE" ]; then
  {
    echo "ARGV: $*"
    echo "HOME: $HOME"
    echo "CODEX_HOME: $CODEX_HOME"
    echo "OPENAI_API_KEY_SET: $([ -n "$OPENAI_API_KEY" ] && echo yes || echo no)"
    echo "CODEX_API_KEY_SET: $([ -n "$CODEX_API_KEY" ] && echo yes || echo no)"
    echo "A2A_PROVIDER_API_KEY_SET: $([ -n "$A2A_PROVIDER_API_KEY" ] && echo yes || echo no)"
  } >> "$FAKE_ARGS_FILE"
fi

CONFIG_DIR="${CODEX_HOME:-$HOME/.codex}"
MARKER="$CONFIG_DIR/.signed-in"

if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  echo '{"models":[{"slug":"gpt-test-mini","display_name":"GPT Test Mini","visibility":"list","priority":5},{"slug":"internal-review","display_name":"Internal Review","visibility":"hide","priority":1},{"slug":"gpt-test","display_name":"GPT Test","visibility":"list","priority":0},{"slug":"bad model; rm","display_name":"Bad","visibility":"list","priority":9}]}'
  exit 0
fi

if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  if [ -f "$MARKER" ]; then
    echo "Logged in using ChatGPT" >&2
  else
    echo "Not logged in" >&2
  fi
  exit 0
fi

if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  echo "Navigate to https://auth.openai.com/codex/device and enter code ABCD-EFGH2"
  if [ -n "$FAKE_CODEX_LOGIN_STUBBORN" ]; then
    sh -c 'trap "" TERM; exec sleep "$1"' sh "$FAKE_CODEX_LOGIN_STUBBORN" &
    wait
    exit 0
  fi
  sleep 300 &
  wait
  exit 0
fi

if [ "$1" = "login" ]; then
  echo "Starting local login server on http://localhost:1455."
  echo "If your browser did not open, navigate to this URL to authenticate:"
  echo "https://auth.openai.com/oauth/authorize?client_id=12345"
  sleep 300 &
  wait
  exit 0
fi

if [ "$1" = "logout" ]; then
  rm -f "$MARKER"
  exit 0
fi

if [ -t 0 ]; then
  STDIN_INPUT=""
else
  STDIN_INPUT=$(cat)
fi

if [ -n "$FAKE_ARGS_FILE" ] && [ -n "$STDIN_INPUT" ]; then
  echo "STDIN: $STDIN_INPUT" >> "$FAKE_ARGS_FILE"
fi

MODE="${FAKE_CODEX_MODE:-stream}"
if [ -f "$CONFIG_DIR/.codex-replay" ]; then
  MODE="replay"
elif [ -f "$CONFIG_DIR/.codex-mode" ]; then
  MODE=$(cat "$CONFIG_DIR/.codex-mode")
fi

case "$MODE" in
  replay)
    if [ -f "$CONFIG_DIR/.codex-replay" ]; then
      cat "$CONFIG_DIR/.codex-replay"
      exit 0
    fi
    exit 1
    ;;
  stream)
    echo '{"type":"thread.started","thread_id":"codex-thread-111"}'
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"ok","exit_code":0,"status":"completed"}}'
    echo '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Codex finished all tasks."}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":25,"reasoning_output_tokens":5}}'
    exit 0
    ;;
  quota)
    THREAD_ID="codex-thread-quota"
    echo "{\"type\":\"thread.started\",\"thread_id\":\"$THREAD_ID\"}"
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Codex done."}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":25,"reasoning_output_tokens":5}}'
    NOW_DIR="$CONFIG_DIR/sessions/$(date +%Y/%m/%d)"
    mkdir -p "$NOW_DIR"
    TS=$(date +%s)
    ROLLOUT_OWN="$NOW_DIR/rollout-$TS-$THREAD_ID.jsonl"
    ROLLOUT_OTHER="$NOW_DIR/rollout-$TS-codex-thread-other.jsonl"
    echo "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-thread-other\"}}" > "$ROLLOUT_OTHER"
    echo '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":99.0,"window_minutes":300,"resets_at":1780902442},"secondary":{"used_percent":99.0,"window_minutes":10080,"resets_at":1781421196},"credits":null,"plan_type":"plus","rate_limit_reached_type":null}}}' >> "$ROLLOUT_OTHER"
    echo "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$THREAD_ID\"}}" > "$ROLLOUT_OWN"
    echo '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":8.0,"window_minutes":300,"resets_at":1780902442},"secondary":{"used_percent":37.0,"window_minutes":10080,"resets_at":1781421196},"credits":null,"plan_type":"plus","rate_limit_reached_type":null}}}' >> "$ROLLOUT_OWN"
    exit 0
    ;;
  quota-limited)
    THREAD_ID="codex-thread-limited"
    echo "{\"type\":\"thread.started\",\"thread_id\":\"$THREAD_ID\"}"
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Codex limited."}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}'
    NOW_DIR="$CONFIG_DIR/sessions/$(date +%Y/%m/%d)"
    mkdir -p "$NOW_DIR"
    TS=$(date +%s)
    ROLLOUT_OWN="$NOW_DIR/rollout-$TS-$THREAD_ID.jsonl"
    echo "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$THREAD_ID\"}}" > "$ROLLOUT_OWN"
    echo '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":100.0,"window_minutes":300,"resets_at":1780902442},"secondary":{"used_percent":50.0,"window_minutes":10080,"resets_at":1781421196},"credits":null,"plan_type":"plus","rate_limit_reached_type":"primary"}}}' >> "$ROLLOUT_OWN"
    exit 0
    ;;
  error)
    echo '{"type":"thread.started","thread_id":"codex-thread-err"}'
    echo '{"type":"turn.started"}'
    echo '{"type":"turn.failed","error":{"message":"Codex syntax failure"}}'
    exit 1
    ;;
  auth-expired)
    echo '{"type":"error","message":"Your access token could not be refreshed. Please log out and sign in again."}'
    exit 1
    ;;
  stubborn)
    sh -c 'trap "" TERM; sleep 300' &
    wait
    ;;
  *)
    sleep 300 &
    wait
    ;;
esac
