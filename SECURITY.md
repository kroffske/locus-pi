# Security Policy

## Supported releases

Published `0.2.x` versions are the supported line. Unreleased source snapshots
and historical commits are unsupported.

## Report a vulnerability

Use GitHub's private vulnerability-reporting form from the repository's
**Security** tab and choose **Report a vulnerability**. Include:

- the affected version, commit, extension, command, or tool;
- a minimal reproduction and realistic impact;
- whether credentials, filesystem writes, subprocesses, network access, or
  workflow execution are involved;
- suggested mitigations, if known;
- only redacted logs and artifacts.

Do not open a public issue, pull request, discussion, or workflow transcript for
a suspected vulnerability.

The repository keeps GitHub private vulnerability reporting enabled so npm
users have a non-public reporting route.

## Security boundaries

- Workflow scripts are trusted JavaScript with full Node.js host access. They
  are not sandboxed.
- Pi approval settings remain the enforcement owner for approved tool actions.
- The `security-gate` extension records audit information; it is not a complete
  blocker, sandbox, malware scanner, or vulnerability-reporting channel.
- Secret scanning and dependency auditing reduce risk but do not prove that a
  release is safe.

No response or remediation SLA is promised.
