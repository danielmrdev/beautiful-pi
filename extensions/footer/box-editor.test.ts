import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BoxEditor } from "./box-editor.ts";

const theme = {
	borderColor: (text: string) => text,
};

const tui = {
	terminal: { rows: 24 },
	requestRender() {},
};

describe("BoxEditor", () => {
	test("renders full box without an empty row", () => {
		const editor = new BoxEditor(tui as any, theme as any, {} as any);
		const lines = editor.render(40);
		const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

		assert.equal(plainLines.length, 3);
		assert.match(plainLines[0]!, /^┌─+┐$/);
		assert.match(plainLines[1]!, /^❯ .*│$/);
		assert.match(plainLines[2]!, /^└.*┘$/);
		assert.ok(plainLines.every((line) => line.length > 0));
	});
});
