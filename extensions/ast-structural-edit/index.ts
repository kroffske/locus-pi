import type { ExtensionAPI } from "../_shared/pi-api.js";
import astEditTool from "./ast-edit.js";
import astGrepTool from "./ast-grep.js";
import astApplyTool from "./resolve.js";

export default function astStructuralEdit(pi: ExtensionAPI): void {
  astGrepTool(pi);
  astEditTool(pi);
  astApplyTool(pi);
}
