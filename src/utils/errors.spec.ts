import { describe, expect, it } from "bun:test";
import { toError, toErrorMessage } from "./errors.ts";

describe("toErrorMessage", () => {
	it("extracts message from a standard Error", () => {
		expect(toErrorMessage(new Error("boom"))).toBe("boom");
	});

	it("includes cause when present on an Error", () => {
		const cause = new Error("root cause");
		const err = new Error("outer", { cause });
		expect(toErrorMessage(err)).toBe("outer [cause: root cause]");
	});

	it("handles nested non-Error cause", () => {
		const err = new Error("outer", { cause: { code: 42, message: "deep" } });
		expect(toErrorMessage(err)).toBe("outer [cause: deep (code=42)]");
	});

	it("extracts message from a duck-typed error object (e.g. JSON-RPC)", () => {
		const rpcError = { code: -32600, message: "Invalid Request" };
		expect(toErrorMessage(rpcError)).toBe("Invalid Request (code=-32600)");
	});

	it("includes data field from duck-typed error object", () => {
		const rpcError = {
			code: -32602,
			message: "Invalid params",
			data: { field: "cwd" },
		};
		expect(toErrorMessage(rpcError)).toBe(
			'Invalid params (code=-32602, data={"field":"cwd"})',
		);
	});

	it("handles duck-typed error with message only", () => {
		const obj = { message: "simple error" };
		expect(toErrorMessage(obj)).toBe("simple error");
	});

	it("returns the string itself for non-empty strings", () => {
		expect(toErrorMessage("something went wrong")).toBe("something went wrong");
	});

	it("JSON-stringifies plain objects without a message property", () => {
		const obj = { status: 500, detail: "server error" };
		expect(toErrorMessage(obj)).toBe('{"status":500,"detail":"server error"}');
	});

	it("truncates long JSON output to maxLength", () => {
		const obj = { data: "x".repeat(1000) };
		const result = toErrorMessage(obj, 50);
		expect(result.length).toBeLessThanOrEqual(51); // 50 + "…"
		expect(result.endsWith("…")).toBe(true);
	});

	it("handles null", () => {
		expect(toErrorMessage(null)).toBe("null");
	});

	it("handles undefined", () => {
		expect(toErrorMessage(undefined)).toBe("undefined");
	});

	it("handles numbers", () => {
		expect(toErrorMessage(42)).toBe("42");
	});

	it("handles booleans", () => {
		expect(toErrorMessage(false)).toBe("false");
	});

	it("handles empty string by falling through to String()", () => {
		// Empty string is falsy so it should hit the fallback
		expect(toErrorMessage("")).toBe("");
	});

	it("handles arrays (plain objects without message)", () => {
		expect(toErrorMessage([1, 2, 3])).toBe("[1,2,3]");
	});

	it("handles objects with circular references gracefully", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		// JSON.stringify will throw, should fall back to toString
		const result = toErrorMessage(obj);
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("does NOT produce [object Object]", () => {
		const cases: unknown[] = [
			{},
			{ code: -1 },
			{ foo: "bar", baz: 42 },
			{ code: -32600, message: "Invalid Request" },
			Object.create(null),
		];
		for (const c of cases) {
			const result = toErrorMessage(c);
			expect(result).not.toBe("[object Object]");
		}
	});
});

describe("toError", () => {
	it("returns the same Error instance when given an Error", () => {
		const err = new Error("original");
		expect(toError(err)).toBe(err);
	});

	it("wraps a string into an Error", () => {
		const err = toError("bad thing");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("bad thing");
		expect(err.cause).toBe("bad thing");
	});

	it("wraps a plain object into an Error with a useful message", () => {
		const obj = { code: -32600, message: "Invalid Request" };
		const err = toError(obj);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("Invalid Request (code=-32600)");
		expect(err.cause).toBe(obj);
	});

	it("wraps a plain object without message property", () => {
		const obj = { status: 500 };
		const err = toError(obj);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe('{"status":500}');
		expect(err.cause).toBe(obj);
	});

	it("wraps null into an Error", () => {
		const err = toError(null);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("null");
	});

	it("wraps undefined into an Error", () => {
		const err = toError(undefined);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("undefined");
	});

	it("wraps a number into an Error", () => {
		const err = toError(404);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("404");
		expect(err.cause).toBe(404);
	});
});
