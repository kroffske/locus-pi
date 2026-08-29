/**
 * extensions/todo-context/operator/operator-surface.ts — the one ctx-bound write to the
 * `todo` widget key, plus the compact projection non-TUI hosts get so a block
 * stays under the host line cap instead of being silently clipped.
 *
 * Pure block construction stays in `operator-ui.ts`; nothing here decides
 * wording.
 */
import type { OperatorBlock } from "../../_shared/operator/operator-ui.js";
import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";

export function setTodoBlock(ctx: ExtensionContext, block: OperatorBlock): void {
  setOperatorWidget(ctx, "todo", ctx.mode === "tui" ? block : compactTodoBlock(block));
}

function compactTodoBlock(block: OperatorBlock): OperatorBlock {
  const body = [...(block.body ?? [])];
  const visibleBody = body.slice(0, 2);
  const hidden = body.length - visibleBody.length;
  const metadata = prioritizeCompactLines(
    block.metadata ?? [],
    /^(?:artifact|path|target|storageBackend|activeTask):/u,
    3,
  );
  const controls = prioritizeCompactLines(block.controls ?? [], /(?:export|body|retry|recovery|usage)/iu, 1);
  return {
    ...block,
    body: [...visibleBody, ...(hidden > 0 ? [`(+${hidden} hidden)`] : [])],
    metadata,
    hint: (block.hint ?? []).slice(0, 1),
    controls,
  };
}

function prioritizeCompactLines(lines: readonly string[], priority: RegExp, limit: number): string[] {
  const preferred = lines.filter((line) => priority.test(line));
  const rest = lines.filter((line) => !priority.test(line));
  return [...preferred, ...rest].slice(0, limit);
}
