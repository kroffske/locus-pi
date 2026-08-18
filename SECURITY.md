# Security Policy

The latest published `@kroffske/locus-pi` release is the supported version.
No response or remediation SLA is promised.

## Report a vulnerability

Use GitHub's private vulnerability-reporting form: repository **Security**
tab → **Report a vulnerability**. Include the affected version or commit, a
minimal reproduction, the realistic impact, and only redacted logs. Do not
open a public issue, pull request, or discussion for a suspected
vulnerability.

## Security boundaries

- Workflow scripts are trusted JavaScript with full Node.js host access.
  They are not sandboxed.
- Pi approval settings remain the enforcement owner for approved tool
  actions.
- The `security-gate` extension records audit information only; it is not a
  blocker, sandbox, or malware scanner.
