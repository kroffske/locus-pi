# model

`model` provides persisted routing roles and thinking-effort controls without replacing Pi's built-in `/model` or `/models` commands.

## Commands

```text
/model-roles
/effort [off|minimal|low|medium|high|xhigh]
```

`/model-roles` opens an interactive selector for the current model and saved roles such as `DEFAULT`, `AGENT`, and `TASK`. Non-default assignments affect matching child-agent and workflow role resolution; they do not silently change the current Pi session model.

`/effort` changes only the current session model's supported thinking level. The extension checks model capability before applying and verifies the host result instead of reporting a clamped value as success.

## Persistence

Project configuration: `.pi/model-roles/config.json`.

User fallback: `~/.pi/agent/model-roles/config.json` or `$PI_MODEL_ROLES_HOME/model-roles/config.json`.

Effective precedence is session, settings compatibility state, project, then user. Missing or unavailable role routes degrade or fail according to the manifest contract and are recorded in run evidence.

## Implementation

- Entrypoint: `extensions/model/index.ts`
- Selector: `extensions/model/model-role-selector.ts`
- Persistence and resolution: `extensions/_shared/model/model-settings.ts`
- Effort command: `extensions/model/effort-command.ts`
- Manifest: `extensions/model/manifest.json`
