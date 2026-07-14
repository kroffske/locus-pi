# Security Policy

## Supported releases

Version `0.2.x` becomes the supported line when `0.2.0` is published to npm.
Pre-release source snapshots and internal history are unsupported.

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

GitHub exposes private vulnerability reporting only for public repositories.
While this clean repository remains private for owner review, the form is not
available to public npm users. Therefore npm publication remains blocked until
the repository is public with the form enabled, or the owner approves another
non-personal private reporting channel and records it here.

## Security boundaries

- Workflow scripts are trusted JavaScript with full Node.js host access. They
  are not sandboxed.
- Pi approval settings remain the enforcement owner for approved tool actions.
- The `security-gate` extension records audit information; it is not a complete
  blocker, sandbox, malware scanner, or vulnerability-reporting channel.
- Secret scanning and dependency auditing reduce risk but do not prove that a
  release is safe.

No response or remediation SLA is promised before the first public release.
