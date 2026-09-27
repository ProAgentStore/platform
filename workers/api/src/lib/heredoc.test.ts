import { describe, expect, it } from "vitest";
import { splitHeredocs as cloud } from "./heredoc.js";
import { splitHeredocs as runner } from "../../../../packages/browser-runner/src/coding/heredoc.js";

// The runner's copy is vendored (a Worker cannot import the runner package), so every case runs
// through BOTH: a rule changed in one copy and not the other fails here.
for (const [name, splitHeredocs] of [["cloud", cloud], ["runner", runner]] as const) {
	describe(`splitHeredocs (${name} copy) — heredoc bodies are data, not commands (#873)`, () => {
		it("removes a body and its terminator for every delimiter quoting", () => {
			for (const open of ["<<EOF", "<<'EOF'", '<<"EOF"', "<<\\EOF", "<< 'EOF'"]) {
				const out = splitHeredocs(`cat > f ${open}\ngit push origin main\nEOF\necho done`);
				expect(out.executed, open).toBe(`cat > f ${open}\necho done`);
				expect(out.bodies, open).toBe("git push origin main");
				expect(out.unterminated, open).toBe(false);
			}
		});

		it("accepts a tab-indented terminator only for <<-", () => {
			expect(splitHeredocs("cat <<-EOF\n\tgh repo delete o/r\n\tEOF\nls").executed).toBe("cat <<-EOF\nls");
			expect(splitHeredocs("cat <<EOF\ngh repo delete o/r\n\tEOF\nls").unterminated).toBe(true);
		});

		it("keeps the rest of the operator's line — it runs", () => {
			const out = splitHeredocs("git commit -F - <<'EOF' && git push origin main\nsubject\nEOF");
			expect(out.executed).toBe("git commit -F - <<'EOF' && git push origin main");
			expect(out.bodies).toBe("subject");
		});

		it("keeps a command after the terminator", () => {
			const out = splitHeredocs("git commit -m \"$(cat <<'EOF'\nmsg: gh pr merge 3\nEOF\n)\" && git push origin main");
			expect(out.executed).toBe("git commit -m \"$(cat <<'EOF'\n)\" && git push origin main");
			expect(out.bodies).toBe("msg: gh pr merge 3");
		});

		it("the terminator must be the whole line, as in the shell — `EOF && git push` is still body", () => {
			// Bash does not end the heredoc here, so the push never runs; reporting it would be the
			// false act this module exists to stop.
			const out = splitHeredocs("git commit -F - <<'EOF'\nsome message\nEOF && git push origin main");
			expect(out.executed).toBe("git commit -F - <<'EOF'");
			expect(out.unterminated).toBe(true);
		});

		it("an unterminated heredoc (a command cut at 400 characters) is body to the end", () => {
			const out = splitHeredocs("gh issue comment 1 --body-file - <<'EOF'\nline one\ngit push https://x.test/a/b main");
			expect(out.executed).toBe("gh issue comment 1 --body-file - <<'EOF'");
			expect(out.bodies).toBe("line one\ngit push https://x.test/a/b main");
			expect(out.unterminated).toBe(true);
		});

		it("reads several operators on one line in order", () => {
			const out = splitHeredocs("paste <<A <<'B'\none\nA\ntwo\nB\ngit push origin main");
			expect(out.executed).toBe("paste <<A <<'B'\ngit push origin main");
			expect(out.bodies).toBe("one\ntwo");
		});

		it("does not open a heredoc for <<<, a quoted <<, a shift, or a comment", () => {
			for (const cmd of [
				"grep x <<< \"$v\"\ngit push origin main",
				'echo "a << b"\ngit push origin main',
				"echo 'x <<EOF'\ngit push origin main",
				"echo $((1<<2))\ngit push origin main",
				"ls # see <<EOF\ngit push origin main",
			]) {
				expect(splitHeredocs(cmd), cmd).toEqual({ executed: cmd, bodies: "", unterminated: false, elided: cmd });
			}
		});

		it("leaves a command with no heredoc unchanged", () => {
			const cmd = "cd repo && git push origin main";
			expect(splitHeredocs(cmd)).toEqual({ executed: cmd, bodies: "", unterminated: false, elided: cmd });
		});

		it("elides each body to one marker line, keeping the operator, terminator and what follows", () => {
			expect(splitHeredocs("git commit -F - <<'EOF'\nsubject\n\nbody line\nEOF\ngit push origin main").elided).toBe(
				"git commit -F - <<'EOF'\n[heredoc body: 3 lines]\nEOF\ngit push origin main",
			);
			expect(splitHeredocs("gh issue comment 1 --body-file - <<'EOF'\nonly line").elided).toBe("gh issue comment 1 --body-file - <<'EOF'\n[heredoc body: 1 line]");
		});

		it("the elided form reads back as the same executed text — the marker is body, not a command", () => {
			const once = splitHeredocs("python3 - <<'EOF'\nprint('git push origin main')\nEOF\ngit push origin fix");
			expect(splitHeredocs(once.elided).executed).toBe(once.executed);
		});
	});
}
