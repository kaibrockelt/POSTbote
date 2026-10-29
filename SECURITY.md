# Security Policy

## Supported versions

Security fixes go into the latest release. Please update before reporting an issue.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via
[GitHub's private vulnerability reporting](https://github.com/kaibrockelt/POSTbote/security/advisories/new)
(repository → Security → Report a vulnerability).

Include what you found, how to reproduce it and what an attacker could do with it. You will get an
answer within a week. Once a fix is released, the advisory is published and you are credited, unless
you prefer not to be.

## Scope

Especially interesting:

- **Team server:** authentication and sessions, access to other users' data, the users file.
- **Script sandbox:** scripts reading or writing outside their collection, network access other than
  `postbote.sendRequest`, escaping the run limits.
- **Variables:** values from responses, data rows or workflow inputs that get interpolated again and
  pull in secrets (e.g. `{{token}}`), or workflow inputs that change environment values.
- **Local app:** other websites or local processes driving the API without the token.
- **Imports:** crafted Postman, OpenAPI, Bruno, HAR or `.http` files that execute code or write files.
- **SSRF** in the team server with `POSTBOTE_DENY_PRIVATE_NETWORKS=true`.

Not in scope: requests a user deliberately sends to their own targets, and the team server with
`POSTBOTE_AUTH=none` or `header` exposed without a proxy (documented as unsafe).
