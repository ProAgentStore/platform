import { describe, expect, it } from "vitest";
import { decryptKey, encryptKey } from "./crypto.js";

// A valid 256-bit AES-KW key expressed as 64 hex characters.
const TEST_KEK =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ALT_KEK =
	"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("encrypt → decrypt roundtrip", () => {
	it("recovers the original plaintext", async () => {
		const plaintext = "sk-test-1234567890abcdef";
		const { ciphertext, dekWrapped, iv } = await encryptKey(
			plaintext,
			TEST_KEK,
		);
		const recovered = await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK);
		expect(recovered).toBe(plaintext);
	});

	it("works with Anthropic-style key", async () => {
		const plaintext = "sk-ant-api03-XXXXXXXXXXXXXXXXXXXX";
		const { ciphertext, dekWrapped, iv } = await encryptKey(
			plaintext,
			TEST_KEK,
		);
		const recovered = await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK);
		expect(recovered).toBe(plaintext);
	});

	it("works with a Google AI key", async () => {
		const plaintext = "AIzaSyD-XXXXXXXXXXXXXXXXXXXXXXXXXXXX";
		const { ciphertext, dekWrapped, iv } = await encryptKey(
			plaintext,
			TEST_KEK,
		);
		const recovered = await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK);
		expect(recovered).toBe(plaintext);
	});

	it("works with an empty string", async () => {
		const { ciphertext, dekWrapped, iv } = await encryptKey("", TEST_KEK);
		const recovered = await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK);
		expect(recovered).toBe("");
	});

	it("works with a long key", async () => {
		const plaintext = "a".repeat(256);
		const { ciphertext, dekWrapped, iv } = await encryptKey(
			plaintext,
			TEST_KEK,
		);
		const recovered = await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK);
		expect(recovered).toBe(plaintext);
	});
});

describe("different keys produce different ciphertext", () => {
	it("same plaintext with different KEKs produces different ciphertext", async () => {
		const plaintext = "sk-secret-key-value";
		const { ciphertext: ct1 } = await encryptKey(plaintext, TEST_KEK);
		const { ciphertext: ct2 } = await encryptKey(plaintext, ALT_KEK);
		// Ciphertexts are Uint8Arrays — compare their hex representations
		const hex1 = Buffer.from(ct1).toString("hex");
		const hex2 = Buffer.from(ct2).toString("hex");
		expect(hex1).not.toBe(hex2);
	});

	it("same plaintext + same KEK produces different ciphertext each call (random IV)", async () => {
		const plaintext = "sk-test-value";
		const { ciphertext: ct1, iv: iv1 } = await encryptKey(
			plaintext,
			TEST_KEK,
		);
		const { ciphertext: ct2, iv: iv2 } = await encryptKey(
			plaintext,
			TEST_KEK,
		);
		// IVs should differ (random each call)
		const ivHex1 = Buffer.from(iv1).toString("hex");
		const ivHex2 = Buffer.from(iv2).toString("hex");
		expect(ivHex1).not.toBe(ivHex2);
		// Ciphertexts should also differ because IV differs
		const hex1 = Buffer.from(ct1).toString("hex");
		const hex2 = Buffer.from(ct2).toString("hex");
		expect(hex1).not.toBe(hex2);
	});

	it("ciphertext length is greater than plaintext length (GCM tag overhead)", async () => {
		const plaintext = "sk-test";
		const { ciphertext } = await encryptKey(plaintext, TEST_KEK);
		// AES-GCM adds a 16-byte authentication tag
		expect(ciphertext.length).toBeGreaterThan(
			new TextEncoder().encode(plaintext).length,
		);
	});

	it("IV is 12 bytes (AES-GCM standard)", async () => {
		const { iv } = await encryptKey("test", TEST_KEK);
		expect(iv.length).toBe(12);
	});

	it("wrapped DEK is 40 bytes (256-bit key + 8-byte AES-KW overhead)", async () => {
		const { dekWrapped } = await encryptKey("test", TEST_KEK);
		expect(dekWrapped.length).toBe(40);
	});
});

describe("invalid KEK throws", () => {
	it("throws on non-hex KEK string", async () => {
		await expect(encryptKey("plaintext", "not-a-hex-string!!!!")).rejects.toThrow();
	});

	it("throws on empty KEK", async () => {
		await expect(encryptKey("plaintext", "")).rejects.toThrow();
	});

	it("throws on KEK that is too short (< 64 hex chars = < 32 bytes)", async () => {
		// 32 hex chars = 16 bytes — too short for AES-256-KW
		await expect(
			encryptKey("plaintext", "0123456789abcdef0123456789abcdef"),
		).rejects.toThrow();
	});

	it("decryptKey throws when wrong KEK is used", async () => {
		const { ciphertext, dekWrapped, iv } = await encryptKey(
			"secret",
			TEST_KEK,
		);
		await expect(
			decryptKey(ciphertext, dekWrapped, iv, ALT_KEK),
		).rejects.toThrow();
	});
});
