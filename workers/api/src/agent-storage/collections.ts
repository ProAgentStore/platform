/**
 * Collections (structured storage) — schema-defined "tables" with indexes,
 * unique constraints, a dedup guard, and CRUD/query over records.
 */
import type { ActivityEvent, CollectionField, CollectionRecord, CollectionSchema, VectorMeta } from "../agent-storage-types.js";
import { encodeIndexValue, inferCollectionFields, validateRecord } from "../agent-storage-utils.js";
import { type AgentStorageBaseCtor, MAX_COLLECTION_RECORDS, MAX_COLLECTIONS } from "./base.js";

/** Sibling methods this group relies on (provided by earlier layers). */
interface CollectionDeps {
	logEvent(type: ActivityEvent["type"], userId?: string, data?: Record<string, unknown>, channel?: string): Promise<ActivityEvent>;
	vectorDelete(sourceType: VectorMeta["sourceType"], sourceId: string): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
type GConstructorWith<T> = new (...args: any[]) => T;

/** The only shape a collection name may take. Anchored, and `:`/`%` are the dangerous ones —
 *  the key scheme is `col:{name}:{id}`, so a colon lets one collection's prefix swallow another's. */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]{0,49}$/;

export function assertCollectionName(name: string): void {
	if (!COLLECTION_NAME_RE.test(name)) {
		throw new Error(
			`Invalid collection name "${name}". Use lowercase letters, digits and underscores, starting with a letter (max 50).`,
		);
	}
}

export function withCollections<TBase extends AgentStorageBaseCtor & GConstructorWith<CollectionDeps>>(Base: TBase) {
	return class extends Base {
		// ── Collections (Structured Storage) ──────────────────────────────────────

		/**
		 * Define a new collection (like creating a table).
		 * Schemas are stored at `schema:{name}` for fast listing without scanning records.
		 */
		async collectionCreate(name: string, fields: CollectionField[]): Promise<CollectionSchema> {
			// Validated HERE, the one choke point every path goes through — the regex previously
			// lived only in the `create_collection` agent tool, so `AgentDO.handleCreateCollection`,
			// `POST /v1/instances/:id/collections`, the MCP tool (plain `z.string()`) and
			// `recordInsert`'s auto-create-on-first-insert all accepted any string.
			//
			// A name containing `:` collides with another collection's KEY PREFIX. Records live at
			// `col:{name}:{id}` and indexes at `idx:{name}:{field}:…`, so with `leads` and
			// `leads:2026` both present: querying `leads` full-scans `col:leads:` and returns the
			// other collection's records, and deleting `leads` deletes `col:leads:` — destroying
			// every record and index of `leads:2026` while its schema survives with a now-false
			// recordCount. Silent, irreversible cross-collection data loss, reachable by an LLM
			// simply calling insert_record with a colon in the name.
			assertCollectionName(name);
			const existing = await this.doStorage.get<CollectionSchema>(`schema:${name}`);
			if (existing) throw new Error(`Collection "${name}" already exists`);

			const allSchemas = await this.doStorage.list({ prefix: "schema:" });
			if (allSchemas.size >= MAX_COLLECTIONS) {
				throw new Error(`Maximum ${MAX_COLLECTIONS} collections reached`);
			}

			const schema: CollectionSchema = {
				name,
				fields,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				recordCount: 0,
			};
			await this.doStorage.put(`schema:${name}`, schema);
			await this.logEvent("collection.created", undefined, { collection: name, fields: fields.length });
			return schema;
		}

		/**
		 * Get collection schema.
		 */
		async collectionGet(name: string): Promise<CollectionSchema | null> {
			return (await this.doStorage.get<CollectionSchema>(`schema:${name}`)) || null;
		}

		/**
		 * List all collections (fast — only scans schema keys, not records).
		 */
		async collectionList(): Promise<CollectionSchema[]> {
			const all = await this.doStorage.list<CollectionSchema>({ prefix: "schema:" });
			return [...all.values()];
		}

		/**
		 * Delete a collection and all its records.
		 */
		async collectionDelete(name: string): Promise<boolean> {
			const schema = await this.collectionGet(name);
			if (!schema) return false;

			// Delete schema
			await this.doStorage.delete(`schema:${name}`);

			// Delete all records and indexes
			const records = await this.doStorage.list({ prefix: `col:${name}:` });
			const indexes = await this.doStorage.list({ prefix: `idx:${name}:` });
			const allKeys = [...records.keys(), ...indexes.keys()];
			for (let i = 0; i < allKeys.length; i += 128) {
				await this.doStorage.delete(allKeys.slice(i, i + 128));
			}

			// Delete vectors for collection records
			await this.vectorDelete("collection", name);
			return true;
		}

		/**
		 * Insert a record into a collection.
		 */
		async recordInsert(
			collection: string,
			data: Record<string, unknown>,
			userId?: string,
		): Promise<CollectionRecord> {
			// Auto-create the collection on first insert (schema inferred from the data)
			// instead of failing — a common agent flow inserts before ever calling
			// create_collection (issue #140).
			const schema =
				(await this.collectionGet(collection)) ??
				(await this.collectionCreate(collection, inferCollectionFields(data)));
			if (schema.recordCount >= MAX_COLLECTION_RECORDS) {
				throw new Error(`Collection "${collection}" is full (max ${MAX_COLLECTION_RECORDS} records)`);
			}

			const validated = validateRecord(schema, data);

			// Enforce unique constraints
			for (const field of schema.fields) {
				if (field.unique && validated[field.name] !== undefined) {
					const encoded = encodeIndexValue(String(validated[field.name]));
					const existing = await this.doStorage.list({
						prefix: `idx:${collection}:${field.name}:${encoded}:`,
						limit: 1,
					});
					if (existing.size > 0) {
						throw new Error(`Duplicate value for unique field "${field.name}": ${String(validated[field.name])}`);
					}
				}
			}

			// Dedup guard: reject if a record with the same indexed field values
			// was inserted in the last 60 seconds (prevents model calling insert_record multiple times)
			const indexedFields = schema.fields.filter((f) => f.indexed);
			if (indexedFields.length > 0) {
				const all = await this.doStorage.list<CollectionRecord>({ prefix: `col:${collection}:` });
				const cutoff = new Date(Date.now() - 60_000).toISOString();
				for (const [, existing] of all) {
					if (existing.createdAt < cutoff) continue;
					const match = indexedFields.every((f) =>
						validated[f.name] !== undefined &&
						existing.data[f.name] !== undefined &&
						String(validated[f.name]) === String(existing.data[f.name]),
					);
					if (match) {
						throw new Error(`Duplicate: a record with the same values was just created (${existing.id.slice(0, 8)})`);
					}
				}
			}

			const id = crypto.randomUUID();
			const now = new Date().toISOString();

			const record: CollectionRecord = {
				id,
				collection,
				data: validated,
				createdAt: now,
				updatedAt: now,
			};

			await this.doStorage.put(`col:${collection}:${id}`, record);

			// Build indexes for indexed + unique fields
			for (const field of schema.fields) {
				if ((field.indexed || field.unique) && validated[field.name] !== undefined) {
					const value = encodeIndexValue(String(validated[field.name]));
					await this.doStorage.put(`idx:${collection}:${field.name}:${value}:${id}`, id);
				}
			}

			// Update record count
			schema.recordCount++;
			await this.doStorage.put(`schema:${collection}`, schema);

			await this.logEvent("collection.record.created", userId, {
				collection,
				recordId: id,
			});

			return record;
		}

		/**
		 * Get a record by ID.
		 */
		async recordGet(collection: string, id: string): Promise<CollectionRecord | null> {
			return (await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`)) || null;
		}

		/**
		 * Update a record.
		 */
		async recordUpdate(
			collection: string,
			id: string,
			data: Record<string, unknown>,
			userId?: string,
		): Promise<CollectionRecord | null> {
			const existing = await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`);
			if (!existing) return null;

			const schema = await this.collectionGet(collection);
			if (!schema) return null;

			const merged = { ...existing.data, ...data };
			const validated = validateRecord(schema, merged);

			// Enforce unique constraints on the NEW values — recordInsert does this, but the
			// update path skipped it entirely, so a PUT could set a duplicate value on a
			// `unique` field. Exclude THIS record's own index entry (key ends in `:${id}`).
			for (const field of schema.fields) {
				if (field.unique && validated[field.name] !== undefined) {
					const encoded = encodeIndexValue(String(validated[field.name]));
					const matches = await this.doStorage.list({ prefix: `idx:${collection}:${field.name}:${encoded}:` });
					for (const key of matches.keys()) {
						if (!key.endsWith(`:${id}`)) {
							throw new Error(`Duplicate value for unique field "${field.name}": ${String(validated[field.name])}`);
						}
					}
				}
			}

			// Remove old indexes for indexed OR unique fields. Must match recordInsert's
			// predicate (`indexed || unique`): a `unique`-only field's index was created on
			// insert but never cleaned up here, orphaning it (blocking re-insert forever).
			for (const field of schema.fields) {
				if ((field.indexed || field.unique) && existing.data[field.name] !== undefined) {
					const oldValue = encodeIndexValue(String(existing.data[field.name]));
					await this.doStorage.delete(`idx:${collection}:${field.name}:${oldValue}:${id}`);
				}
			}

			existing.data = validated;
			existing.updatedAt = new Date().toISOString();
			await this.doStorage.put(`col:${collection}:${id}`, existing);

			// Rebuild indexes for indexed OR unique fields.
			for (const field of schema.fields) {
				if ((field.indexed || field.unique) && validated[field.name] !== undefined) {
					const value = encodeIndexValue(String(validated[field.name]));
					await this.doStorage.put(`idx:${collection}:${field.name}:${value}:${id}`, id);
				}
			}

			await this.logEvent("collection.record.updated", userId, {
				collection,
				recordId: id,
			});

			return existing;
		}

		/**
		 * Delete a record.
		 */
		async recordDelete(collection: string, id: string, userId?: string): Promise<boolean> {
			const existing = await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`);
			if (!existing) return false;

			const schema = await this.collectionGet(collection);

			// Remove indexes for indexed OR unique fields (match recordInsert's predicate —
			// a `unique`-only field's index was orphaned on delete, permanently blocking
			// re-insert of that value with a phantom "Duplicate value" error).
			if (schema) {
				for (const field of schema.fields) {
					if ((field.indexed || field.unique) && existing.data[field.name] !== undefined) {
						const value = encodeIndexValue(String(existing.data[field.name]));
						await this.doStorage.delete(`idx:${collection}:${field.name}:${value}:${id}`);
					}
				}
				schema.recordCount = Math.max(0, schema.recordCount - 1);
				await this.doStorage.put(`schema:${collection}`, schema);
			}

			await this.doStorage.delete(`col:${collection}:${id}`);
			await this.logEvent("collection.record.deleted", userId, { collection, recordId: id });
			return true;
		}

		/**
		 * Query records in a collection with filtering.
		 */
		async recordQuery(
			collection: string,
			opts?: {
				where?: Record<string, unknown>;
				limit?: number;
				offset?: number;
				orderBy?: string;
				orderDir?: "asc" | "desc";
			},
		): Promise<{ records: CollectionRecord[]; total: number }> {
			const schema = await this.collectionGet(collection);
			if (!schema) throw new Error(`Collection "${collection}" not found`);

			const limit = Math.min(opts?.limit || 50, 200);
			const offset = opts?.offset || 0;

			// If filtering on an indexed field, use the index — but ONLY when no explicit
			// ordering is asked for. The index returns ids in UUID order; honouring `orderBy`
			// needs the full result set sorted before the page slice, so fall through to the
			// scanning path (which sorts) rather than silently returning UUID order.
			if (opts?.where && Object.keys(opts.where).length === 1 && !opts?.orderBy) {
				const [field, value] = Object.entries(opts.where)[0];
				const fieldDef = schema.fields.find((f) => f.name === field);
				if (fieldDef?.indexed) {
					const encodedValue = encodeIndexValue(String(value));
					const indexPrefix = `idx:${collection}:${field}:${encodedValue}:`;
					const indexed = await this.doStorage.list<string>({ prefix: indexPrefix });
					const ids = [...indexed.values()];
					const records: CollectionRecord[] = [];
					for (const id of ids.slice(offset, offset + limit)) {
						const rec = await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`);
						if (rec) records.push(rec);
					}
					return { records, total: ids.length };
				}
			}

			// Full scan with filtering (schemas are stored at `schema:` prefix, not here)
			const all = await this.doStorage.list<CollectionRecord>({ prefix: `col:${collection}:` });
			let records = [...all.values()];

			// Apply where filter
			if (opts?.where) {
				records = records.filter((r) =>
					Object.entries(opts.where!).every(([k, v]) => r.data[k] === v),
				);
			}

			const total = records.length;

			// Sort
			if (opts?.orderBy) {
				const dir = opts.orderDir === "desc" ? -1 : 1;
				records.sort((a, b) => {
					const av = String(a.data[opts.orderBy!] ?? a[opts.orderBy as keyof CollectionRecord] ?? "");
					const bv = String(b.data[opts.orderBy!] ?? b[opts.orderBy as keyof CollectionRecord] ?? "");
					return av.localeCompare(bv) * dir;
				});
			}

			return { records: records.slice(offset, offset + limit), total };
		}
	};
}
