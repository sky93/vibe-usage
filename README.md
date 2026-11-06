# vibe-usage

CLI and local web dashboard for inspecting Claude Code session usage, 5-hour billing windows, and KV-cache behavior from `~/.claude/projects`.

## Install

Homebrew:

```bash
brew install sky93/tap/vibe-usage
```

Run with `npx`:

```bash
npx github:sky93/vibe-usage
```

From source:

```bash
git clone https://github.com/sky93/vibe-usage.git
cd vibe-usage
npm link
```

## Usage

```bash
vibe-usage
# or
ccdash
```

Starts the local dashboard on `http://127.0.0.1:4455` and prints a summary table in the terminal.

### Flags

```text
--table        Print terminal table and exit
--no-open      Start server without opening the browser
--days <n>     Lookback window in days (default: 2, 0 for all)
--app <name>   Filter sessions by project name
--port <port>  Server port (default: 4455)
-v, --version  Print version
-h, --help     Show help
```

## License

MIT
