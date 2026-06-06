/**
 * Envelope encryption for user API keys.
 * Each key gets its own DEK (data encryption key), wrapped under the master KEK.
 * Vendored from FAGS platform/workers/host/src/api.ts.
 */

async function importKek(kekHex: string): Promise<CryptoKey> {
	const matches = kekHex.match(/.{2}/g);
	if (!matches) throw new Error("Invalid KEK hex string");
	const raw = new Uint8Array(matches.map((b) => parseInt(b, 16)));
	return crypto.subtle.importKey("raw", raw, "AES-KW", false, [
		"wrapKey",
		"unwrapKey",
	]);
}

async function generateDek(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
		"encrypt",
		"decrypt",
	]) as Promise<CryptoKey>;
}

export async function encryptKey(
	plaintext: string,
	kekHex: string,
): Promise<{
	ciphertext: Uint8Array;
	dekWrapped: Uint8Array;
	iv: Uint8Array;
}> {
	const kek = await importKek(kekHex);
	const dek = await generateDek();
	const iv = crypto.getRandomValues(new Uint8Array(12));

	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			dek,
			new TextEncoder().encode(plaintext),
		),
	);

	const dekWrapped = new Uint8Array(
		await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW"),
	);

	return { ciphertext, dekWrapped, iv };
}

export async function decryptKey(
	ciphertext: Uint8Array,
	dekWrapped: Uint8Array,
	iv: Uint8Array,
	kekHex: string,
): Promise<string> {
	const kek = await importKek(kekHex);
	const dek = await crypto.subtle.unwrapKey(
		"raw",
		dekWrapped,
		kek,
		"AES-KW",
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const plainBuf = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		dek,
		ciphertext,
	);
	return new TextDecoder().decode(plainBuf);
}
