// ─── Render Context ───────────────────────────────────────────────────────────
// Composites multiple workflow trees into a single logUpdate frame.
// In --all mode, groups jobs by workflow and renders a unified tree.

import logUpdate from "log-update";
import { renderTree, type TreeNode } from "./tree-renderer.js";

export class RenderContext {
  /** Ordered map of slot → { workflowBasename, jobTreeNode } */
  private slots = new Map<string, { workflow: string; node: TreeNode }>();

  /** Update the tree node for a job slot, grouped under its workflow. */
  updateJob(workflow: string, slot: string, node: TreeNode): void {
    this.slots.set(slot, { workflow, node });
  }

  /** Render all workflows as a single composite tree via logUpdate. */
  flush(): void {
    // Group slots by workflow (preserve insertion order)
    const wfMap = new Map<string, TreeNode[]>();
    for (const { workflow, node } of this.slots.values()) {
      if (!wfMap.has(workflow)) {
        wfMap.set(workflow, []);
      }
      wfMap.get(workflow)!.push(node);
    }

    const roots: TreeNode[] = [];
    for (const [wf, children] of wfMap) {
      roots.push({ label: wf, children });
    }
    logUpdate(renderTree(roots));
  }

  /** Persist the current output (stop overwriting). */
  done(): void {
    logUpdate.done();
  }
}

/** Create a render context for --all mode. */
export function createRenderContext(): RenderContext {
  return new RenderContext();
}
