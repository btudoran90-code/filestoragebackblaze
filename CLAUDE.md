# filestoragebackblaze

Durable file storage for Claude Code sessions. The session container is
ephemeral; this bucket is not. Anything the user downloads or asks to keep goes
here.

`store.mjs` is a dependency-free S3 client (plain `node`, no `npm install`,
SigV4 over `fetch`). Provider: Backblaze B2. The same script works with
Cloudflare R2, AWS, or MinIO — only `S3_ENDPOINT` changes.

## Using it

Credentials come from the claude.ai environment settings: `S3_ENDPOINT`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`. They are NOT in this
repo and must never be committed, echoed into a command line, or written to a
file. If they are missing, ask the user to add them rather than guessing.

```bash
node store.mjs ls [prefix]              # list objects (recursive) with size and date
node store.mjs put <file> [key]         # upload; key ending in "/" keeps the file name
node store.mjs get <key> [file]         # download to the scratchpad, not into a repo
node store.mjs cat <key>                # print a text object
node store.mjs head <key>               # size, content-type, last-modified
node store.mjs rm <key> [key...]        # delete
node store.mjs url <key> [seconds]      # presigned download link (default 1h, max 7d)
```

## Conventions

Group keys by purpose with a `/` prefix (`downloads/`, `reports/`,
`screenshots/`, `kodinoo/`) and keep the original file name. Never overwrite an
existing key unless the user asks. `rm` is permanent — there is no versioning —
so confirm first unless the user asked for the deletion.

When the user wants a file, upload it and hand them a `url` link rather than
pasting the contents into chat. When they ask what is stored, run `ls` rather
than guessing from memory.

A key restricted to a single bucket cannot list the account's buckets; that is
the intended setup, and `buckets` reports it rather than failing.

## Development

No build, no dependencies, no test framework. To change the client, run it
against a local MinIO:

```bash
S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
S3_BUCKET=test node store.mjs ls
```

Exercise every command against MinIO before pushing, including keys with
spaces and non-ASCII characters and a file large enough to stream (25 MB+).
