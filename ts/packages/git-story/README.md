# git-story

Attaches the agent sessions that led to a commit to that commit. This package is
the scaffold: a CLI with no story logic yet.

Git runs any `git-<name>` binary on `PATH` as `git <name>`, so the
`git-story` binary is also `git story`.

```text
$ cd ts/packages/git-story
$ pnpm build
$ npm link            # puts git-story on PATH
$ git story init   # registers Copilot CLI and git hooks for this repo
$ git story hooks copilot user-prompt-submitted
Hello World
$ echo input | git story hooks git pre-commit a b
git-story pre-commit: args=["a","b"] stdin="input\n"
```

`init` writes the hooks to `.github/copilot/settings.local.json` and adds that
file to `.git/info/exclude`, so it stays local to the clone.

`init` also writes a `pre-commit` script to the git hooks directory (honors
`core.hooksPath`). The script runs `exec git-story hooks git pre-commit "$@"`,
so git's hook arguments and stdin reach the command unchanged. `init` does not
overwrite a hook that it did not write.

## Daemon

`git story daemon start|stop|restart|status` manages one HTTP API server per
user, shared by all projects. It binds `127.0.0.1:51703` and keeps
its pid and port in `~/.typeagent/git-story/daemon.json`, log in
`~/.typeagent/git-story/daemon.log` (`~` is the user home directory on macOS and
Windows).

Each request names its project by absolute path in the `project` query
parameter:

```text
$ git story daemon start
Started (pid 70006) at http://127.0.0.1:51703
$ curl -G http://127.0.0.1:51703/api/story/commits/79f77a3 --data-urlencode project=/Users/me/repo
{"hash":"79f77a337c682a14ec7df45d309c4856cf3bf236","subject":"hello story"}
```

Routes are in `src/server/router.ts`; handlers are in `src/server/routes/`.

## Privacy filtering

The daemon exposes a local filter for story code to call before its first storage or sharing boundary. Private text uses a per-daemon Unix socket recorded in `daemon.json`; it never crosses the daemon's loopback TCP API. GLiNER2 finds semantic PII first. The filter replaces those spans with `[REDACTED:PII]`, then runs Tirith's `public-paste` policy for secrets, internal hosts, home paths, and private IP addresses. Either tool failing rejects the request without returning partial output.

Install Python 3.11 and Tirith 0.4.2, then run:

```text
$ git story privacy setup --tirith /absolute/path/to/tirith
$ git story privacy status
$ git story daemon start
$ printf '%s' 'Contact Ada at ada@example.invalid' | git story privacy redact
Contact [REDACTED:PII] at [REDACTED:PII]
```

`privacy redact` reads stdin so private text does not appear in the process list. The IPC endpoint accepts `POST /api/privacy/redact` with a JSON body containing one `text` string. It is private implementation detail rather than part of the loopback HTTP API.

Setup downloads the pinned [`fastino/gliner2-privacy-filter-PII-multi`](https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi/tree/1cb4166094dc58fa8d836429f060d6c95f62b495) model, installs the hashed [GLiNER2 2.0.0](https://github.com/fastino-ai/GLiNER2/tree/3c913c7369301133d3b7699252074c4303ada50e) release with Transformers 4.45.2, verifies every artifact, and publishes the installation only after both tools pass smoke tests. GLiNER2 and the model are Apache-2.0. Runtime inference uses only local files with Hugging Face and Transformers offline modes enabled. The model needs about 3 GB of memory after loading and the installed model is about 1.2 GB. Setup currently supports macOS 14 or later on Apple silicon. The 42-label schema leaves room for about 160 simple words; longer inputs fail closed.

This is risk reduction, not a complete DLP boundary. Synthetic tests still missed Chinese and Japanese names. [Tirith 0.4.2](https://github.com/sheeki03/tirith/tree/v0.4.2) is [AGPL-3.0-only](https://github.com/sheeki03/tirith/blob/v0.4.2/LICENSE) unless separately commercially licensed. Review its license before distribution or service deployment; git-story does not install or bundle Tirith.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
