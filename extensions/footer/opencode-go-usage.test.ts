import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	openCodeGoUsageSegments,
	parseOpenCodeGoUsage,
} from "./opencode-go-usage.ts";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

describe("OpenCode Go usage API", () => {
	test("parses rolling, weekly and monthly windows", () => {
		const usage = parseOpenCodeGoUsage({
			usage: {
				rolling: { status: "ok", percent: 5, resetsAt: "2026-09-25T13:14:02.407Z" },
				weekly: { status: "ok", percent: 2, resetsAt: "2026-09-28T00:00:00.000Z" },
				monthly: { status: "ok", percent: 41, resetsAt: "2026-09-30T04:41:33.000Z" },
			},
		}, NOW);

		assert.deepEqual(usage, {
			rolling: { usagePercent: 5, resetInSec: 4442 },
			weekly: { usagePercent: 2, resetInSec: 216000 },
			monthly: { usagePercent: 41, resetInSec: 405693 },
		});
	});

	test("defaults missing windows and rejects unknown ones", () => {
		const usage = parseOpenCodeGoUsage({
			usage: {
				rolling: { status: "ok", percent: 5, resetsAt: "2026-09-25T13:14:02.407Z" },
				weekly: { status: "ok", percent: 120, resetsAt: "2026-09-28T00:00:00.000Z" },
				monthly: { status: "ok", percent: 10 },
			},
		}, NOW);

		assert.deepEqual(usage, {
			rolling: { usagePercent: 5, resetInSec: 4442 },
			weekly: { usagePercent: 0, resetInSec: 0 },
			monthly: { usagePercent: 0, resetInSec: 0 },
		});
	});

	test("returns null for malformed responses", () => {
		assert.equal(parseOpenCodeGoUsage(null, NOW), null);
		assert.equal(parseOpenCodeGoUsage("not-json", NOW), null);
		assert.equal(parseOpenCodeGoUsage({ usage: null }, NOW), null);
		assert.equal(parseOpenCodeGoUsage({ usage: { rolling: { percent: 1 } } }, NOW), null);
	});

	test("clamps elapsed windows already reset", () => {
		const usage = parseOpenCodeGoUsage({
			usage: {
				rolling: { status: "ok", percent: 5, resetsAt: "2026-09-25T11:00:00.000Z" },
			},
		}, NOW);

		assert.equal(usage!.rolling.resetInSec, 0);
	});

	test("builds segments with pace bars and over-budget flags", () => {
		const segments = openCodeGoUsageSegments({
			rolling: { usagePercent: 30, resetInSec: 13558 },
			weekly: { usagePercent: 2, resetInSec: 216000 },
			monthly: { usagePercent: 41, resetInSec: 405693 },
		}, Date.now());

		assert.equal(segments[0]!.paceBar, "━━━·┄┄┄┄┄┄┄┄");
		assert.equal(segments[0]!.overBudget, true);
		assert.equal(segments[0]!.exhausted, false);
		assert.equal(segments[1]!.overBudget, false);
	});
});
