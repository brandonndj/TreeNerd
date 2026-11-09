# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and its impact. You'll get an acknowledgement as soon as possible, and fixes are prioritised by severity.

## Scope

In scope: the site at `treenerd.fyi`, its API (`/api/*`, `/data/*`) and the code in this repository.

Out of scope: third-party services TreeNerd links to or reads from, volumetric denial of service, and reports from automated scanners without a demonstrated impact.

## Design

- The site is read-only and has no user accounts, cookies or user-submitted content.
- No personal data is collected from visitors or ingested from upstream sources.
- All responses carry a strict Content Security Policy and standard hardening headers. Scripts load only from the site itself; no third-party CDNs are used.
- The API accepts only `GET`/`HEAD`, validates every parameter, uses parameterised database queries, and is rate-limited per client.
- CI pins actions to commit SHAs, Python dependencies are hash-locked, and dependencies are monitored for updates.
