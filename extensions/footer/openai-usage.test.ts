import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	formatOpenAIUsage,
	parseOpenAIUsage,
} from "./openai-usage.ts";

describe("OpenAI Codex usage", () => {
	test("parses five-hour and seven-day windows", () => {
		const usage = parseOpenAIUsage({
			rate_limit: {
				primary_window: {
					used_percent: 3,
					limit_window_seconds: 18000,
					reset_after_seconds: 13440,
				},
				secondary_window: {
					used_percent: 10,
					limit_window_seconds: 604800,
					reset_after_seconds: 180000,
				},
			},
		});

		assert.deepEqual(formatOpenAIUsage(usage!), "3% 3:44h | 10% 2d2h");
	});

	test("finds seven-day usage even when it is primary window", () => {
		const usage = parseOpenAIUsage({
			rate_limit: {
				primary_window: {
					used_percent: 25,
					limit_window_seconds: 604800,
					reset_after_seconds: 597314,
				},
				secondary_window: null,
			},
		});

		assert.equal(formatOpenAIUsage(usage!), "25% 6d21h");
	});

	test("ignores windows with unknown durations", () => {
		assert.equal(parseOpenAIUsage({
			rate_limit: {
				primary_window: { used_percent: 3, limit_window_seconds: 3600 },
			},
		}), null);
	});

	test("returns null for malformed responses", () => {
		assert.equal(parseOpenAIUsage({ rate_limit: null }), null);
		assert.equal(parseOpenAIUsage("not-json"), null);
	});
});
