# Security Policy

## Supported releases

| Version | Supported |
| ------- | --------- |
| `0.3.x` | Yes       |
| `<0.3`  | No        |

Unreleased source snapshots and historical commits are not supported releases.

## Report a vulnerability

Use GitHub private vulnerability reporting from the repository's **Security** tab. Include:

- affected version, commit, extension, command, tool, or workflow;
- a minimal reproduction and realistic impact;
- whether filesystem writes, subprocesses, network access, browser access, models, or credentials are involved;
- suggested mitigations, when known;
- only redacted logs and artifacts.

Do not open a public issue, pull request, discussion, or workflow transcript for a suspected vulnerability.

## Security boundaries

- Extension and workflow code runs inside the trusted Pi/Node.js host.
- Project and user workflows are JavaScript and are not sandboxed.
- Pi approval settings remain the enforcement owner for approved tool actions.
- `security-gate` records audit observations; it is not a blocker, sandbox, malware scanner, or vulnerability-reporting channel.
- Secret scanning, dependency auditing, path checks, and evidence journals reduce risk but do not prove a release or workflow safe.

No response or remediation SLA is promised.
