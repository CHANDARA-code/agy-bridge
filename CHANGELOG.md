# Changelog

All notable changes to a2a-panel are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Team templates: web app, iOS, Android, Flutter, backend API, bug fix squad, review and audit, and release preparation. Pick one under Teams → New team or with `a2a-panel teams new <id> --template <template>`; the leader goes to an account of the suggested CLI that leads no other team yet, and each member gets its own signed-in account. `GET /api/team-templates`, `GET /api/team-templates/:id/draft`, `a2a-panel teams templates`.

### Fixed

- `npm run check` checks the syntax of the files in `src/` again (it only looked at the top-level entry files since the move).

## [0.3.0] - 2026-10-31

### Added

- Multiple accounts per agent CLI: Antigravity (`agy`), Claude Code (`claude`) and Codex (`codex`), each isolated in its own folder (per-account `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Your existing sign-ins appear as the built-in default accounts, and adding an account never replaces one.
- Sign-in from the panel: Codex browser or device code, Claude browser with paste-code, Antigravity Google link with paste-code (run in a pseudo-terminal), and a Terminal-window fallback for all.
- Tasks run on any account (`account` on the MCP dispatch tool, `/tasks/send`, JSON-RPC, the panel and `a2a-panel run --account`), with Claude Code and Codex stream parsing, per-account token usage, and accounts marked signed out when a task proves the sign-in is gone.
- Per-account keychain and keychain settings for Antigravity accounts on macOS, so signing in never asks to reset your keychain.
- Real names and photos on account cards: Google name and photo for Antigravity, name, email and plan from the Codex sign-in, email for Claude.
- Add account with provider logos: one click creates the account and starts sign-in; unfinished sign-ins are removed. Antigravity and Codex logos come from their editor extensions on your machine (`GET /api/providers/:id/icon`); Claude's logo is the Simple Icons glyph (CC0).
- Teams: a leader account plans a goal into tasks for member accounts and roles, with plan-first review (instructions and check commands shown before you build), dependencies, a parallel limit, optional leader review, MCP tools `a2a_list_teams`, `a2a_run_team`, `a2a_get_team_run`, `a2a_cancel_team_run` and `a2a-panel teams` commands.
- MCP tool `a2a_list_accounts`; CLI `a2a-panel accounts` commands.
- Role `release-manager`: semver bumps, version consistency, changelogs and package contents; it runs dry-runs and stops before any irreversible publish, tag push or production deploy. `devops-engineer` now covers CI/CD, deployment and operations.
- Model picker: the account and team leader model fields list the models that account can use (`agy models`, `codex debug models`, Claude Code's aliases) instead of asking for a model id; any id can still be typed. `GET /api/accounts/:id/models`.
- Update button: the panel header shows "Update to x.y.z" when npm has a newer version. Update now installs it with `npm install -g` and restarts the server (refused while work is running), and the page reloads on the new version; git clones get the commands instead. `GET /api/version`, `POST /api/update`, a `version` event on the stream, and `A2A_UPDATE_CHECK=0` to turn the check off.
- Preset template `engineering-practices`: a core working-discipline file for every role plus one guide per area (web, API, mobile, desktop, testing, debugging, security, git), each sent only to the roles that need it.
- Per-account Usage Monitor (`src/usage.js`) tracking token budgets, usage records with models breakdown, and provider plan quota snapshots.
- Quota snapshot extraction for Claude Code (`rate_limit_event` and `modelUsage`), Codex (`rate_limits` from task's own rollout file), and Antigravity (capacity exhaustion failure detection).
- Account budgets with period windows (`day`, `week`, `month`) starting at 00:00 local time, and optional hard stop enforcement refusing tasks before spawn.
- Account profile pictures (`PUT/GET/DELETE /api/accounts/:id/avatar`) with byte signature verification (PNG, JPEG, WebP, max 512 KB), isolated storage, strict security headers, and automatic deletion on account removal.
- HTTP API endpoints `GET /api/usage/accounts`, `PUT /api/accounts/:id/budget`, `DELETE /api/accounts/:id/budget`, and avatar endpoints.
- MCP tool `a2a_account_usage` reporting single-line account capacity and quota status.
- CLI commands: `a2a-panel usage [--days N]` per-account breakdown and `a2a-panel accounts budget <id> (--period ... --tokens ... [--stop] | --clear)`.

### Changed

- The panel gets updates pushed over one event stream (`GET /api/events`) instead of polling, so an idle panel makes no repeating requests.
- The web, API, mobile, desktop, bug-triager and code-reviewer personas spell out what to check before, during and after the work, and how to report it.
- The `nestjs-react`, `nextjs-fullstack` and `flutter-mobile` preset templates follow the versions already in the project (`package.json`, `pubspec.lock`) and name the current majors for new projects (Ant Design 6, Next.js 16, NestJS 12, PostgreSQL 18, Riverpod 3, Freezed 3 or later) instead of older pinned ones. Each adds a `security.md` for its stack, a "Done means" check list, the stack pitfalls agents get wrong most often (unregistered NestJS modules, unauthenticated server actions, stale generated Dart code, Freezed 3 without `.when()`), and targets `release-manager`. Existing project conventions now take precedence over a template's style rules.
- Source files moved into `src/`. `cli.js`, `server.js` and `mcp-server.js` stay at the top level as entry points that load `src/`, so existing start-at-login services, Claude Code MCP registrations and `node cli.js` commands keep working unchanged.

### Fixed

- A team plan approved in one place (panel, CLI or Claude Code) shows as built everywhere and can only be built once; cancelling and building the same plan at the same moment cannot both win.
- Deleting a team that is running is refused, and a run no longer crashes its process when its team changes or an error happens while a task finishes.
- A run finishes only after its review ends, and the parallel limit holds even when a task cannot start.
- Cancelling a run from another process keeps all of its tasks cancelled.
- Unknown task modes and efforts are refused everywhere (REST, JSON-RPC, MCP, CLI) instead of running Claude or Codex with full permissions; an account's saved model is validated too.
- Signing a built-in account in again asks for confirmation in the panel and `--yes` in the CLI, because it replaces the sign-in that tool uses on this computer; never-checked accounts are checked when the Accounts page opens.
- Deleting a Claude or Codex account signs it out first, so Claude's keychain entry for that account is removed too.
- A status check no longer overwrites a rename or budget made while it ran; `a2a-panel accounts login` keeps the new status.
- Sign-out reports a failure instead of marking the account signed out, and no longer blocks the server.
- Usage recorded before accounts existed counts for the default Antigravity account in the Usage page and budgets; Codex quota is read from the account's folder even when `CODEX_HOME` is set.
- Sign-in processes are stopped when the server stops; closing the dialog during a Terminal-window sign-in keeps the new account.
- Claude sign-in failures are recognised only by Claude's own error wording, so a task's text cannot sign an account out.
- A task on a signed-out Antigravity account no longer waits at agy's sign-in prompt until the time limit.
- A running verification command can be cancelled.
- Antigravity sign-in from the panel runs agy's local `/help` command instead of a model prompt, so it uses no tokens and finishes a few seconds after the code is pasted; the dialog shows that the code was sent and can't send it twice.
- Antigravity accounts show the Google name and photo: the sign-in is read from the keychain entry agy really uses, and the newest stored sign-in wins over an old token file; a later check with an expired token keeps the name.
- Claude Code accounts show the Claude display name from their own `.claude.json`.
- Token totals mean the same for every CLI (new input plus output, cache reads separate); Claude Code and Codex totals no longer include cache reads.
- An account that reuses a deleted account's id no longer inherits its usage or budget spend.
- Closing the sign-in window while a finished sign-in is being checked no longer deletes the new account; cancelling a finished sign-in no longer rewrites its result.
- Leader and member pickers, team cards, run details, usage cards and dialogs show each account's profile name (a custom label still wins), and the Accounts page and avatars share one account request.
- A leader plan whose task prompts contain code blocks is read correctly; before, a ``` inside a prompt failed the run with "Invalid JSON in leader output".
- The team run details drawer is wider and gives task titles room instead of wrapping them one letter per line.
- Sign-in codes are hidden from sign-in output for every provider; a sign-in that ignores SIGTERM is killed; a missing CLI no longer stops the server.
- Codex keeps showing signed out after a task proves its stored sign-in was rejected, until you sign in again.
- Leader-written verification commands run on the host only after explicit plan approval in plan-first mode, preventing untrusted command execution.
- Path traversal through run IDs by validating `^run_\d+_[a-z0-9]+$` on all run endpoints and operations.
- Scheduler deadlock by propagating skipped task dependencies until reaching a fixed point.
- Stale overwrites in parallel task execution by maintaining a single active in-memory run state per process.
- Team and run listings failing completely when any single file contains malformed JSON by skipping corrupt files in list functions.

## [0.2.0] - 2026-10-26

### Added

- Start at login: `a2a-panel autostart enable | disable | status`. It installs a per-user LaunchAgent on macOS, or a systemd user service on Linux, so the server and web dashboard come back after a restart and after a crash. It saves your `PATH` and any `A2A_*` / `AGY_BIN` variables, so tasks still find `agy`, Node.js and git. `enable --dry-run` prints the service file without installing it.
- On macOS, start-at-login logs go to `~/Library/Logs/a2a-panel/`.
- README: a "Keep the panel running after a restart" guide and an "Uninstall" section.
- This changelog. `npm run check` now fails if the version in `package.json` has no entry here, and the GitHub Release uses that entry as its notes.

### Changed

- With start at login turned on, `a2a-panel server start | stop | restart` control the login service, so a second server is never started next to it.
- `a2a-panel status` shows whether the server starts at login, plus the dashboard URL.

## [0.1.0] - 2026-10-26

First release on npm.

### Added

- Twelve Antigravity specialist roles, which Claude Code calls through the MCP server and other clients through the A2A HTTP / JSON-RPC server.
- Web task panel (React, Vite, Ant Design): live logs, dispatch, cancel and re-run, light and dark themes, mobile layout.
- Presets: your coding style, frontend and API libraries and default technology choices, kept as markdown files. Each file can be limited to certain specialists, and a repository can override them in `.agy/preferences/`. Presets start empty. Three starter templates: `nestjs-react`, `nextjs-fullstack`, `flutter-mobile`.
- Verification gate: the bridge runs `verification_command` itself and fails the task when it fails.
- Token usage per task and per role, conversation resume, a workspace change summary, timeouts, a concurrency cap and process-group cancel.
- `doctor` and `init` commands.

### Changed

- Renamed from `agy-bridge` to `a2a-panel`, for both the package and the command. `init` replaces an old `agy-bridge` MCP registration, and npm installs keep using an existing `~/.agy-bridge` data folder.

### Fixed

- Task logs show each tool call with its argument, failed tool steps, and actions `agy` denied.
- `GET /tasks/:id` and JSON-RPC `tasks/get` return usage, verification, conversation id and changes for async tasks.

[Unreleased]: https://github.com/CHANDARA-code/a2a-panel/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/CHANDARA-code/a2a-panel/releases/tag/v0.3.0
[0.2.0]: https://github.com/CHANDARA-code/a2a-panel/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/a2a-panel/v/0.1.0
