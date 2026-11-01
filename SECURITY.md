# Security

## What a2a-panel does with your machine

a2a-panel starts agent CLIs in headless/automated modes without interactive confirmation prompts. Delegated tasks can read and write files and run shell commands in the workspace you give them, without a prompt. Only delegate work, and only open workspaces, that you would let an unattended script touch:

- **Google Antigravity (`agy`)**: Starts with `--dangerously-skip-permissions` in edit mode, or `--mode plan` when planning.
- **Claude Code (`claude`)**: Starts with `--dangerously-skip-permissions` in edit mode, or `--permission-mode dontAsk` with read-only tools (`Read`, `Glob`, `Grep`, `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(ls:*)`) in plan mode.
- **Codex (`codex`)**: Starts with `--dangerously-bypass-approvals-and-sandbox` in edit mode, or `-s read-only` in plan mode.

Use `--mode plan` for work that must not change anything.

## Account credentials and isolation

- The accounts directory (`A2A_ACCOUNTS_DIR` or `<DATA_DIR>/accounts`) stores CLI credentials and session tokens. It is created with permission mode `0700` so only the owner can read or write to it.
- **Claude Code**: Uses `CLAUDE_CONFIG_DIR` per account and strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` from the task process environment so stored profile credentials take effect.
- **Codex**: Uses `CODEX_HOME` per account.
- **Antigravity**: each account has its own home that links to your real home except `.gemini` and `Library`; its `Library` excludes `Keychains` and has its own `Preferences` without `com.apple.security.plist`. On macOS each account gets its own keychain file with an empty password inside the `0700` account folder, so its sign-in is protected by file permissions only (like Codex's `auth.json`). agy may also store the sign-in in `.gemini/antigravity-cli/antigravity-oauth-token` inside the account home. Your real keychain, search list and keychain settings are never modified. Verified on macOS; on Linux, check that a new account shows signed out before signing in.

## API key accounts

- An API key is stored in `api-key` inside that account's folder (mode `0600`, folder `0700`). It is never written to `accounts.json`, never returned by the API (only its last 4 characters are shown), and never accepted on the command line, where other users could see it in the process list.
- When a task runs, the key is passed to Claude Code or Codex in an environment variable (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY` or `A2A_PROVIDER_API_KEY`). The agent process can read its own environment, like any tool you give a key to. Key variables from your shell (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, …) are removed from those tasks so they cannot leak to another provider.
- To check a key, the server sends it only to that provider's own model or key endpoint over HTTPS. Base URLs must be `https://`, except `http://localhost` for a local gateway.

## Account names and photos

- To show real names and photos, a2a-panel reads the sign-in each tool stored for that account: the id_token claims in Codex's `auth.json` (read locally), the `oauthAccount` display name in Claude Code's `.claude.json` (no tokens), and agy's stored token (keychain item `gemini` or the account's token file, whichever is newer), whose access token is sent only to `https://www.googleapis.com/oauth2/v3/userinfo`.
- Tokens are never logged, copied, or returned by any API. Only name, email, plan and the photo are saved.
- Photos are downloaded only over HTTPS from `*.googleusercontent.com`, without credentials or redirects, limited to 512 KB and type-checked by their bytes like uploads.
- The access token is never refreshed by a2a-panel; when it has expired, the name saved earlier is kept.

## Update check

- To show the Update button, the server asks `https://registry.npmjs.org/a2a-panel/latest` (or `A2A_NPM_REGISTRY`) for the newest version, at most every 6 hours. The request carries no account, token or task data. Set `A2A_UPDATE_CHECK=0` to turn it off.
- Update now (`POST /api/update`) needs the panel token like every other change. It only runs for a global npm install, installs the exact version the registry reported (checked against a semver pattern) with `npm install -g`, is refused while tasks or team runs are running, and then restarts the server through its login service or `a2a-panel server start`.

## Profile pictures and media security

- Account profile pictures uploaded to the panel (`PUT /api/accounts/:id/avatar`) are type-checked by their magic byte signatures (PNG, JPEG, WebP) rather than file extensions or client-provided MIME types.
- Decoded image payload size is restricted to a maximum of 512 KB, and executable or scriptable formats (such as SVG) are strictly forbidden.
- Avatars are served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'` to prevent browser MIME-sniffing and cross-site script execution.
- Deleting an account immediately removes its associated profile image.

## Task session isolation and quota tracking

- Codex quota snapshots are parsed exclusively from the task's own session rollout file (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<session_id>.jsonl`) matching the thread ID from `thread.started`. Rollout files for other sessions or thread IDs are never read or attributed to the task.

## Team runs

Leader plans are untrusted text: a leader model reads repository content that could contain prompt injection. Plan-first mode shows every instruction and check command for review before execution. The bridge executes leader-written verification commands only after you explicitly approve a plan; in unapproved or accept-edits runs, verification commands are not run directly by the bridge on the host and are instead passed to the developer task as instructions.

## Settings and Telegram remote control

- Settings changed in the panel are saved in `settings.json` in the data folder with mode `0600`. `PUT /api/settings` needs the panel token. An environment variable with the same name wins and cannot be changed from the panel.
- The Telegram bot token is never returned by `GET /api/settings` or any other endpoint (the panel only learns whether one is saved), and Telegram errors are reported without the request URL that contains it.
- The server reaches Telegram by long polling `api.telegram.org`; it opens no port and accepts no webhook. It refuses a bot that has a webhook set.
- Messages and button taps are acted on only when they come from the configured chat id, from a person (not a bot), and from one of the allowed user ids. With no allowed ids, only a private chat with the bot is answered; a group chat is ignored until you add ids. Everything else is ignored and counted. Commands older than 10 minutes are ignored.
- Starting work (`/run`, `/team`, the Build button) is off until you turn on "Allow starting work from Telegram". `/run` uses only the workspace set in Settings; `/team` plans first and builds only after Build is pressed. Anyone who can write in that chat as an allowed user can then start agents with the same permissions as the panel, so keep the chat private and the allowed ids short. Messages for the team leader (`/do`, free text, answer buttons) are delivered whether or not starting work is on; your leader has its own tools to start agents, so treat those messages like instructions you type yourself.
- Messages you send to the team leader are stored in `telegram-inbox.json` (mode `0600`, at most 50) until the leader reads them through `a2a_wait_for_user`, which, like `a2a_notify_user`, needs the panel token.

## The local HTTP server

- It listens on `127.0.0.1` only and rejects requests whose `Host` header is not local.
- It sends no CORS headers.
- Every non-GET request needs the token in the `token` file in the data folder (mode 0600, created on first start).
- The server refuses to start on any address except loopback (`127.0.0.1`, `localhost`, `::1`).
- Do not forward the port to a network or the internet.

### Not safe on a shared machine

The web panel is served with its token embedded, and `GET` requests need no token. Any process or user on the same machine that can reach `127.0.0.1:5188` can load `/dashboard`, read the token, and start agents as you. Browsers on other sites are blocked (Host check, no CORS, same-origin check), but other local users are not. Do not run the HTTP server on a machine you share with people you do not trust. The MCP server that Claude Code starts does not open a port, so it is not affected.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue. Include the version, what you did, and what happened.
