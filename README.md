# Floppy file share

[![test](https://github.com/l23c/floppy-action/actions/workflows/test.yml/badge.svg)](https://github.com/l23c/floppy-action/actions/workflows/test.yml)
[![Shared with Floppy](https://img.shields.io/badge/shared_with-Floppy-2323ff)](https://fpy.sh/agents)

Upload files from a workflow to [Floppy](https://fpy.sh) and comment the share links on the pull request. Send a link to a reviewer, a client or a teammate, then see who opened it: which pages they read and for how long, with bots filtered out.

Good for anything a build makes that someone should look at: PDF reports, design exports, screenshots, test recordings, release notes, decks.

```text
2 files on Floppy for 3f9c2e1

- report.pdf → https://fpy.sh/k3x9
- screenshot.png → https://fpy.sh/m2p8

Shared with Floppy · run
```

## Usage

```yaml
name: Share the report
on: pull_request

permissions:
  contents: read
  pull-requests: write # to comment the links

jobs:
  share:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: make report.pdf
      - uses: l23c/floppy-action@v1
        with:
          path: report.pdf
          api-key: ${{ secrets.FLOPPY_API_KEY }}
```

That's it. The action uploads `report.pdf`, comments the link on the pull request and keeps that comment up to date on every push.

### Get an API key

1. Sign in at https://fpy.sh/app/keys and create a key with write access.
2. In your repository, open **Settings → Secrets and variables → Actions** and add it as `FLOPPY_API_KEY`.

No key? Leave `api-key` out to try it. Files then go to a new unclaimed account that stops working after 72 hours (see [Without an account](#without-an-account)).

## Inputs

| Input | Default | What it does |
|---|---|---|
| `path` | (required) | File, directory or glob to upload. One per line for several. A line starting with `!` excludes matches. Hidden files only match when you name them. |
| `api-key` | | A Floppy API key (`fpy_live_…`), from a secret. Files land in your account. |
| `label` | | Make a per-recipient link with this label, for example `Design review`, so its views are counted apart. |
| `expiry` | | How long the links work: `1D`, `2D`, `3D`, `5D`, `1W`, `2W`, `1M`, `3M` or `NEVER`. Without a key, `3D` at most. |
| `comment` | `auto` | Comment the links on the pull request. `auto` comments on `pull_request` and `pull_request_target` events. `true` also works on `issue_comment` events for pull requests. |
| `github-token` | `${{ github.token }}` | Token used to comment. Needs `pull-requests: write`. |
| `if-no-files-found` | `error` | `error`, `warn` or `ignore` when `path` matches nothing. |

## Outputs

| Output | What it is |
|---|---|
| `url` | The share link of the first file. |
| `urls` | Every share link, as a JSON array. |
| `links` | Every upload as a JSON array of `{ name, url, id, scan, expires_at }`. |
| `claim-url` | Set when the files went to an unclaimed account. Treat it as a secret: whoever opens it first gets the files. |

```yaml
      - uses: l23c/floppy-action@v1
        id: floppy
        with:
          path: dist/*.pdf
          api-key: ${{ secrets.FLOPPY_API_KEY }}
          comment: false
      - run: echo "Report is at ${{ steps.floppy.outputs.url }}"
```

## Examples

Several files, one link each:

```yaml
      - uses: l23c/floppy-action@v1
        with:
          path: |
            exports/**/*.{png,pdf}
            !exports/drafts
          api-key: ${{ secrets.FLOPPY_API_KEY }}
```

A link for one recipient that works for a week:

```yaml
      - uses: l23c/floppy-action@v1
        with:
          path: deck.pdf
          label: Sequoia – Jane
          expiry: 1W
          api-key: ${{ secrets.FLOPPY_API_KEY }}
```

On a release, without a comment:

```yaml
on:
  release:
    types: [published]
jobs:
  share:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: l23c/floppy-action@v1
        with:
          path: CHANGELOG.md
          api-key: ${{ secrets.FLOPPY_API_KEY }}
```

## How it works

- Each file gets its own Floppy link. Files up to 100 MB go up in one request; bigger files use Floppy's multipart upload (32 MiB parts, retried on errors). Free accounts take files up to 500 MB, Pro up to 50 GB.
- Every file is scanned for malware before anyone else can open it. Links work at once; visitors see "Checking file…" for the few seconds that takes.
- The pull request gets one comment per workflow job. Later runs edit it instead of posting again.
- The job summary lists every link, with its scan state and expiry.
- Your key and any claim link are masked in the logs.

## Without an account

Leave out `api-key` and the action still works: the first upload creates an unclaimed Floppy account, and every other file of the run joins it.

- The links stop working, and the files are deleted, after 72 hours. Expiry is 3 days at most.
- Only safe file types: PDF, Markdown and text, images, audio, video, CSV and JSON.
- Up to 20 links and 1 GB, and a few new accounts per network per day.
- The `claim-url` output moves everything into a Floppy account. It's never put in the comment, and it's only shown in the job summary of private repositories, because whoever opens it first gets the files.

Pull requests from forks can't read your secrets, so they upload this way.

## Forks

On `pull_request` from a fork, GitHub gives the job a read-only token, so the action can upload but can't comment; it warns instead of failing. To comment on fork pull requests, use `pull_request_target`, and don't build or run the fork's code in that job.

## Badge

Share files from your project with Floppy? Add the badge:

```markdown
[![Shared with Floppy](https://img.shields.io/badge/shared_with-Floppy-2323ff)](https://fpy.sh/agents)
```

## More

- Floppy for agents and APIs: https://fpy.sh/docs/agents
- OpenAPI: https://fpy.sh/openapi.json
- MCP server: `https://fpy.sh/mcp`

## License

MIT
