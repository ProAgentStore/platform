// Example custom surface (Phase 3) — a tiny "Notes" board.
//
// This is a plain ESM module a creator publishes; the console loads it via
// DynamicSurface and calls mount(ctx). It uses ONLY ctx.sdk (the platform's
// authenticated API client + escape helpers) — no bundled dependencies.
//
// Served by the console at /console/surfaces/notes.js, so its bundleUrl is
// https://<host>/console/surfaces/notes.js. See docs/custom-surfaces.md.

export function mount(ctx) {
  const { el, instanceId, sdk } = ctx;
  const COLLECTION = "notes";
  const base = `/v1/instances/${instanceId}/collections/${COLLECTION}/records`;

  el.innerHTML = `
    <div style="padding:1rem;max-width:42rem;margin:0 auto;font-family:inherit">
      <h3 style="font-weight:700;margin:0 0 .5rem">Notes</h3>
      <p style="color:var(--color-muted);font-size:.85rem;margin:0 0 1rem">
        A demo surface shipped as a published bundle — stores notes on this instance via the SDK.
      </p>
      <form data-add style="display:flex;gap:.5rem;margin-bottom:1rem">
        <input data-input placeholder="Write a note…" style="flex:1;background:var(--color-panel);border:1px solid var(--color-line);border-radius:.5rem;padding:.5rem .75rem;color:var(--color-ink)" />
        <button type="submit" style="background:var(--color-accent);color:#fff;border:0;border-radius:.5rem;padding:.5rem 1rem;font-weight:700">Add</button>
      </form>
      <div data-list style="display:flex;flex-direction:column;gap:.5rem"></div>
    </div>`;

  const listEl = el.querySelector("[data-list]");
  const inputEl = el.querySelector("[data-input]");
  const formEl = el.querySelector("[data-add]");
  let alive = true;

  function render(records) {
    if (!records.length) {
      listEl.innerHTML = `<div style="color:var(--color-muted-soft);font-size:.85rem">No notes yet.</div>`;
      return;
    }
    listEl.innerHTML = records
      .map((r) => {
        const text = sdk.esc(String(r.data?.text ?? ""));
        const when = r.createdAt ? sdk.formatTime(r.createdAt) : "";
        return `<div style="background:var(--color-paper);border:1px solid var(--color-line);border-radius:.5rem;padding:.6rem .75rem">
          <div style="font-size:.9rem;color:var(--color-ink)">${text}</div>
          <div style="font-size:.65rem;color:var(--color-muted-soft);margin-top:.25rem">${when}</div>
        </div>`;
      })
      .join("");
  }

  async function load() {
    try {
      const d = await sdk.api(base);
      if (alive) render((d.records || []).reverse());
    } catch (e) {
      if (alive) listEl.innerHTML = `<div style="color:var(--color-red);font-size:.85rem">Couldn't load notes: ${sdk.esc(String(e?.message || e))}</div>`;
    }
  }

  formEl.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    try {
      await sdk.api(base, { method: "POST", body: JSON.stringify({ data: { text } }) });
      await load();
    } catch (e) {
      alert("Couldn't save note: " + (e?.message || e));
    }
  });

  load();

  // Cleanup — the console calls this on unmount and clears `el`.
  return () => { alive = false; };
}
