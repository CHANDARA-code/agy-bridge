#!/bin/sh
if [ -n "$FAKE_ARGS_FILE" ]; then
  printf 'ARGV: %s\nHOME: %s\nAGY_ADC_AUTH_SET: %s\n' "$*" "$HOME" "$([ -n "$AGY_ADC_AUTH" ] && echo yes || echo no)" >> "$FAKE_ARGS_FILE"
fi

if [ "$1" = "models" ]; then
  if [ -f "$HOME/.gemini/antigravity-cli/.signed-in" ]; then
    printf 'gemini-1.5-pro\tGemini 1.5 Pro\ngemini-1.5-flash\tGemini 1.5 Flash\n'
    exit 0
  else
    echo "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."
    exit 1
  fi
fi

MODE="$FAKE_AGY_MODE"
if [ -f "$HOME/.agy-replay" ]; then
  MODE="replay"
elif [ -f "$HOME/.agy-mode" ]; then
  MODE=$(cat "$HOME/.agy-mode")
fi

case "$MODE" in
  replay)
    if [ -f "$HOME/.agy-replay" ]; then
      cat "$HOME/.agy-replay"
      exit 0
    fi
    exit 1
    ;;
  stubborn)
    sh -c 'trap "" TERM; sleep 300' &
    wait
    ;;
  signin-stdout)
    echo 'Authentication required. Please visit the URL to log in:'
    sleep 300 &
    wait
    exit 0
    ;;
  signin-crash)
    echo 'Authentication required. Please visit the URL to log in:' >&2
    echo '  https://accounts.google.com/o/oauth2/auth?client_id=fake' >&2
    printf 'Or, paste the authorization code here and press Enter: ' >&2
    read code
    echo 'fatal: token exchange failed' >&2
    exit 3
    ;;
  signin)
    echo 'Authentication required. Please visit the URL to log in:' >&2
    echo '  https://accounts.google.com/o/oauth2/auth?client_id=fake&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback' >&2
    printf 'Or, paste the authorization code here and press Enter: ' >&2
    if ! read code; then
      sleep 300 &
      wait
      exit 0
    fi
    if [ "$code" = "good-code" ]; then
      mkdir -p "$HOME/.gemini/antigravity-cli"
      touch "$HOME/.gemini/antigravity-cli/.signed-in"
      echo '{"event":"result","result":{"status":"SUCCESS","response":"OK","usage":{"total_tokens":3}}}'
      exit 0
    fi
    echo '{"event":"result","result":{"status":"ERROR","response":"","error":"authentication failed or timed out","usage":{"total_tokens":0}}}'
    exit 0
    ;;
  detached-child)
    sleep 300 &
    exit 0
    ;;
  stream)
    if [ -n "$FAKE_AGY_STREAM_DELAY" ]; then
      sleep "$FAKE_AGY_STREAM_DELAY"
    fi
    echo '{"event":"init","conversation_id":"conv-12345678","init":{"cwd":"/x"}}'
    echo '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello "}}'
    echo '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"run_command"}}'
    echo '{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"world"}}'
    echo 'plain passthrough line'
    echo '{"event":"result","result":{"conversation_id":"conv-12345678","status":"SUCCESS","response":"Hello world","duration_seconds":1.5,"usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":0,"cache_read_tokens":50,"total_tokens":120}}}'
    exit 0
    ;;
  tools)
    echo '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"npm test"}}}}'
    printf '%s\n' '{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"},"error":{"type":"TOOL_ERROR","message":"user denied permission to run command:\nls -la"}}}}'
    echo '{"event":"result","result":{"status":"SUCCESS","response":"done","usage":{"total_tokens":7},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}'
    exit 0
    ;;
  failed)
    echo '{"event":"result","result":{"status":"ERROR","response":"","usage":{"total_tokens":5}}}'
    exit 0
    ;;
  quota)
    echo '{"event":"result","result":{"status":"ERROR","response":"","error":"Resource has been exhausted (check quota or rate limit, resets in 1h)","usage":{"total_tokens":5}}}'
    exit 1
    ;;
  busy)
    i=0
    while [ $i -lt "${FAKE_AGY_BUSY_LINES:-600}" ]; do
      echo '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"working on the change, reading files and running the tests "}}'
      sleep 0.05
      i=$((i+1))
    done
    echo '{"event":"result","result":{"status":"SUCCESS","response":"done","usage":{"total_tokens":10}}}'
    exit 0
    ;;
  chatty)
    yes 'line of agent output' | head -n 5000
    exit 0
    ;;
  echo-home)
    echo "HOME=$HOME"
    exit 0
    ;;
  *)
    sleep 300 &
    wait
    ;;
esac
