# Getting started

## Install the published package

```bash
pi install npm:@kroffske/locus-pi
pi list
npx @kroffske/locus-pi doctor
```

`pi list` is the authority for registration scope. `doctor` verifies that the installed package contains all eleven declared extension entrypoints; it does not execute child agents or workflows.

Start a new Pi session in a trusted project:

```text
/devext doctor
/workflows list
/workflows run live-smoke
```

`live-smoke` is the smallest runtime check: it starts two child-agent jobs that list the current project directory.

## Avoid duplicate registrations

Pi can load the same package from user and project scope at the same time. Duplicate registrations usually surface as duplicate tool or command names.

Inspect and remove the unwanted source identity:

```bash
pi list
pi remove npm:@kroffske/locus-pi
pi remove npm:@kroffske/locus-pi -l
```

For a source checkout, run `pi remove .` or `pi remove . -l` from the registered checkout root. Remove the registration before moving or deleting the directory.

## Install from a Git checkout

Use a checkout only for development or pre-release validation. Review it before registration because Pi loads the extension source directly.

```bash
git clone https://github.com/kroffske/locus-pi.git
cd locus-pi
npm ci --ignore-scripts
pi install .
pi list
npm run check
./bin/locus-pi doctor
```

Use either user scope (`pi install .`) or project scope (`pi install . -l`), not both for the same checkout.

Updating the checkout does not require re-registration:

```bash
git pull --ff-only
npm ci --ignore-scripts
./bin/locus-pi doctor
```

Start a fresh Pi session after updating so the host reloads the source.

## Uninstall

Published package:

```bash
pi remove npm:@kroffske/locus-pi
pi list
```

Source checkout:

```bash
cd /absolute/path/to/locus-pi
pi remove .
pi list
```

Removing a registration does not delete Pi runtime history.

## Common failures

### `doctor` reports a missing entrypoint

Reinstall dependencies for a checkout and verify that the package or checkout is complete. For npm installs, remove and reinstall the same package identity.

### Pi works outside the repository but fails inside it

The checkout is probably registered in both user and project scope. Use `pi list`, then remove one registration.

### `/workflows run` is rejected before a run starts

Check the target name, required `--output-dir`, safe project-relative path rules, and whether the workflow needs structured fields available only through the `workflow` tool. Use `/workflows info <name>` for the live contract.

### A workflow is awaiting operator input

Inspect it with `/workflows status <runId>`, then continue it explicitly with `/workflows continue <runId>`. Do not invent an answer in automation.

### A local workflow is untrusted

Do not run it. Project and user workflows are JavaScript with host access; path validation and approval prompts are not a sandbox.
