# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and its impact. You'll get an acknowledgement as soon as possible, and fixes are prioritised by severity.

## Scope

In scope: the site at `treenerd.fyi`, its API (`/api/*`, `/data/*`) and the code in this repository.

Out of scope: third-party services TreeNerd links to or reads from, volumetric denial of service, and reports from automated scanners without a demonstrated impact.

## Design

- The site is read-only. It has no user accounts, sets no cookies of its own and stores no user-submitted content.
- No personal data is collected from visitors or ingested from upstream sources. A location shared for "Near me" is rounded to about 10 m in the browser, and per-request logging is off.
- Every response carries a strict Content Security Policy and standard hardening headers (HSTS, `nosniff`, framing denied, a restrictive permissions policy).
- Scripts are served from the site itself. The only exception is the Cloudflare Web Analytics beacon.
- The API accepts only `GET`/`HEAD`, validates every parameter, ignores unknown parameters, uses parameterised database queries, and is rate-limited per client.
- Links that come from data must be `https://`, and CSV exports are protected against spreadsheet formula injection.
- Credentials for upstream services are stored as encrypted platform secrets, never in the repository.
- Preview hosts answer with `X-Robots-Tag: noindex` and a disallow-all `robots.txt`.
- Automated tests cover input validation, the method and file allowlists, and the security headers.
- CI pins actions to commit SHAs, Python dependencies are hash-locked, npm dependencies are audited on every build, and Dependabot raises security updates.
