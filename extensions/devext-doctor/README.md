# devext-doctor

`devext-doctor` provides read-only operator diagnostics.

## Commands

```text
/devext doctor
/devext task-lifecycle <task-id> <target-status>
```

`/devext doctor` reports the installed package surface: the entrypoints `package.json#pi.extensions` declares, whether each entrypoint and its manifest is present, and the risk and ownership those manifests declare. It proves that entrypoints and metadata are present, not that every runtime capability has executed successfully. Manifest contents are reported, not validated — `npm run check:manifests` owns the manifest contract.

`/devext task-lifecycle` previews a local task transition and missing preconditions without mutating `.tasks`.

Reload behavior belongs to Pi. Use the host `/reload` command or restart the session; this extension does not register a second reload mechanism.

## Implementation

- Entrypoint: `extensions/devext-doctor/index.ts`
- Inventory: `extensions/devext-doctor/package-inventory.mjs`, read by this command and by `npx @kroffske/locus-pi doctor` so the two diagnostics cannot disagree
- Manifest: `extensions/devext-doctor/manifest.json`
