#!/bin/sh
if [ -n "$FAKE_ARGS_FILE" ]; then
  {
    echo "ARGV: $*"
    echo "HOME: $HOME"
    echo "CLAUDE_CONFIG_DIR: $CLAUDE_CONFIG_DIR"
    echo "ANTHROPIC_API_KEY_SET: $([ -n "$ANTHROPIC_API_KEY" ] && echo yes || echo no)"
    echo "ANTHROPIC_AUTH_TOKEN_SET: $([ -n "$ANTHROPIC_AUTH_TOKEN" ] && echo yes || echo no)"
    echo "ANTHROPIC_BASE_URL: $ANTHROPIC_BASE_URL"
    echo "ANTHROPIC_CUSTOM_HEADERS_SET: $([ -n "$ANTHROPIC_CUSTOM_HEADERS" ] && echo yes || echo no)"
    echo "ANTHROPIC_MODEL: $ANTHROPIC_MODEL"
    echo "ANTHROPIC_DEFAULT_HAIKU_MODEL: $ANTHROPIC_DEFAULT_HAIKU_MODEL"
  } >> "$FAKE_ARGS_FILE"
fi

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MARKER="$CONFIG_DIR/.signed-in"

if [ "$1" = "--help" ]; then
  echo "Options:"
  echo "  --model <model>                       Model for the current session. Provide"
  echo "                                        an alias for the latest model (e.g."
  echo "                                        'fable', 'opus', or 'sonnet') or a"
  echo "                                        model's full name."
  exit 0
fi

if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$FAKE_CLAUDE_STATUS_DELAY" ]; then
    sleep "$FAKE_CLAUDE_STATUS_DELAY"
  fi
  if [ -f "$MARKER" ]; then
    echo '{"loggedIn":true,"authMethod":"claude.ai","email":"user@example.com","subscriptionType":"max"}'
  else
    echo '{"loggedIn":false,"authMethod":"none"}'
  fi
  exit 0
fi

if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.ai/login/oauth/12345"
  printf "Paste code here if prompted > "
  read code
  echo "Received code $code (debug token 4/0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789)"
  if [ "$code" = "good-code" ]; then
    mkdir -p "$CONFIG_DIR"
    touch "$MARKER"
    exit 0
  else
    echo "Invalid code"
    exit 1
  fi
fi

if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then
  if [ -n "$FAKE_ARGS_FILE" ]; then
    echo "LOGOUT: $CONFIG_DIR" >> "$FAKE_ARGS_FILE"
  fi
  if [ -f "$CONFIG_DIR/.logout-fail" ]; then
    echo "logout failed: the keychain is locked" >&2
    exit 1
  fi
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

MODE="${FAKE_CLAUDE_MODE:-stream}"
if [ -f "$CONFIG_DIR/.claude-replay" ]; then
  MODE="replay"
elif [ -f "$CONFIG_DIR/.claude-mode" ]; then
  MODE=$(cat "$CONFIG_DIR/.claude-mode")
fi

case "$MODE" in
  replay)
    if [ -f "$CONFIG_DIR/.claude-replay" ]; then
      cat "$CONFIG_DIR/.claude-replay"
      exit 0
    fi
    exit 1
    ;;
  stream)
    echo '{"type":"system","subtype":"init","session_id":"claude-session-987"}'
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test","description":"run tests"}}]}}'
    echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"all tests passed","is_error":false}]}}'
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Task completed successfully."}]}}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"Task completed successfully.","session_id":"claude-session-987","duration_ms":1234,"total_cost_usd":0.01,"permission_denials":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":20,"output_tokens":15,"output_tokens_details":{"thinking_tokens":5}}}'
    exit 0
    ;;
  quota)
    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793278800,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1793278800},"seven_day":{"utilization":0.26,"resetsAt":1793520000}}}}'
    echo '{"type":"system","subtype":"init","session_id":"claude-session-quota"}'
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Quota run complete."}]}}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"Quota run complete.","session_id":"claude-session-quota","duration_ms":1000,"total_cost_usd":0.155,"permission_denials":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":20,"output_tokens":15},"modelUsage":{"claude-opus-5-5":{"inputTokens":4,"outputTokens":299,"cacheReadInputTokens":59935,"cacheCreationInputTokens":17132,"costUSD":0.155039}}}'
    exit 0
    ;;
  usage-limit)
    echo '{"type":"result","subtype":"error","is_error":true,"result":"You have hit your limit for today. Rate limit exceeded.","error":"You have hit your limit for today"}'
    exit 1
    ;;
  denied)
    echo '{"type":"system","subtype":"init","session_id":"claude-session-denied"}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"claude-session-denied","duration_ms":500,"permission_denials":[{"tool_name":"Write"}],"usage":{"input_tokens":5,"output_tokens":5}}'
    exit 0
    ;;
  error)
    echo '{"type":"result","subtype":"error","is_error":true,"result":"Claude execution failed","error":"Something went wrong"}'
    exit 1
    ;;
  prose-final)
    echo '{"type":"result","subtype":"success","is_error":true,"result":"Users report the app says they are not logged in, and the staging server answers invalid api key.","session_id":"claude-session-prose-final","usage":{"input_tokens":5,"output_tokens":5}}'
    exit 1
    ;;
  prose-fail)
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"The login page still shows the user is not logged in after refresh; the API returns 401 Unauthorized."}]}}'
    echo '{"type":"result","subtype":"success","is_error":true,"result":"2 tests failed","session_id":"claude-session-prose","usage":{"input_tokens":5,"output_tokens":5}}'
    exit 1
    ;;
  auth-expired)
    echo '{"type":"result","subtype":"error","is_error":true,"result":"OAuth token has expired. Please run /login to sign in again.","error":"oauth token has expired"}'
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
