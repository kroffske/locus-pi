# devext-doctor

`devext-doctor` provides read-only operator diagnostics.

## Commands

```text
/devext doctor
/devext task-lifecycle <task-id> <target-status>
```

`/devext doctor` summarizes the declared extension inventory. It proves that entrypoints and metadata are present, not that every runtime capability has executed successfully.

`/devext task-lifecycle` previews a local task transition and missing preconditions without mutating `.tasks`.

Reload behavior belongs to Pi. Use the host `/reload` command or restart the session; this extension does not register a second reload mechanism.

## Implementation

- Entrypoint: `extensions/devext-doctor/index.ts`
- Inventory: `extensions/devext-doctor/extension-inventory.ts`
- Manifest: `extensions/devext-doctor/manifest.json`
