/**
 * BoxEditor — Custom editor with triangle prefix and box-like bottom frame.
 *
 * Follows the Archimedes pattern: separates content from autocomplete
 * lines, inserts a spacer between them, and draws a └─┘ bottom frame.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getIcons, strWidth } from "../shared/icons.ts";
const TRIANGLE = "\u276F"; // ❯

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function leadingAnsi(s: string): string {
	const m = s.match(/^(\x1b\[[0-9;]*m)+/);
	return m?.[0] ?? "";
}

function ansiWrap(line: string): (t: string) => string {
	const ansi = leadingAnsi(line);
	if (!ansi) return (t: string) => t;
	return (t: string) => `${ansi}${t}\x1b[0m`;
}

function trunc(s: string, maxW: number): string {
	// pi's editor adds APC cursor markers (\x1b_pi:c\x07). Its truncator
	// handles those zero-width sequences; a color-only parser counts them as 2 chars.
	return truncateToWidth(s, Math.max(0, maxW), "", true);
}

export class BorderlessTopEditor extends CustomEditor {
	render(width: number): string[] {
		const innerW = Math.max(1, width - 2);
		const lines = super.render(innerW);
		if (lines.length < 2) return lines;

		// Find the LAST border line (bottom border or autocomplete separator)
		let bottomIdx = lines.length - 1;
		for (let i = lines.length - 1; i >= 1; i--) {
			const p = lines[i]!.replace(ANSI_RE, "").trim();
			if (p.startsWith("─")) {
				bottomIdx = i;
			}
		}

		const wrap = ansiWrap(lines[bottomIdx]!);

		// Content lines (between top border and found separator)
		const contentRaw = lines.slice(1, bottomIdx);

		// Autocomplete lines (after separator)
		const autoRaw = lines.slice(bottomIdx + 1);

		// Build content lines with ❯ prefix
		const contentLines: string[] = contentRaw.map((line, i) => {
			const pre = leadingAnsi(line);
			const body = line.slice(pre.length);
			if (i === 0) {
				return trunc(`${pre}${wrap(TRIANGLE)} ${body}`, width);
			}
			return trunc(`${pre}  ${body}`, width);
		});

		// Spacer before autocomplete (Archimedes pattern)
		if (autoRaw.length > 0) {
			contentLines.push("");
		}

		// Autocomplete lines indented by 2
		for (const line of autoRaw) {
			const pre = leadingAnsi(line);
			const body = line.slice(pre.length);
			contentLines.push(trunc(`${pre}  ${body}`, width));
		}

		// ── Bottom border with clock ──
		const plain = lines[bottomIdx]!.replace(ANSI_RE, "");
		if (/─── ↓/.test(plain)) {
			contentLines.push(trunc(lines[bottomIdx]!, width));
		} else {
			const ss = (globalThis as any)[Symbol.for("beautiful-pi:wgtSessionStart")];
			let timeStr = "";
			if (typeof ss === "number") {
				const e = Math.floor((Date.now() - ss) / 1000);
				const h = Math.floor(e / 3600);
				const m = Math.floor((e % 3600) / 60);
				timeStr = h > 0 ? `${h}:${String(m).padStart(2, "0")}h` : `${m}m`;
			}
			const ci = getIcons().time ? getIcons().time + " " : "";
			const clockPart = ` ${ci}${timeStr} `;
			const cW = strWidth(clockPart);
			const fill = Math.max(0, width - 3 - cW);
			contentLines.push(
				`${wrap("└")}${wrap("─".repeat(fill))}${clockPart}${wrap("─")}${wrap("┘")}`,
			);
		}
		// Final guard: custom borders and wide glyphs must never exceed TUI width.
		return contentLines.map((line) => trunc(line, Math.max(0, Math.floor(width))));
	}
}
