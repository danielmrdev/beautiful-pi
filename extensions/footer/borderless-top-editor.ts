import { CustomEditor } from "@mariozechner/pi-coding-agent";

/**
 * CustomEditor that removes the top border line so that the
 * "aboveEditor" stats-bar widget visually merges with it,
 * saving one line of height.
 *
 * render() from the base Editor returns:
 *   [0]  top border  ─────────────
 *   [1…n-1]  content lines
 *   [n]  bottom border  ──────────
 *
 * We drop line [0] here.
 */
export class BorderlessTopEditor extends CustomEditor {
  render(width: number): string[] {
    const lines = super.render(width);
    // Drop the first line (top border) when there are at least 2 lines
    return lines.length > 1 ? lines.slice(1) : lines;
  }
}
