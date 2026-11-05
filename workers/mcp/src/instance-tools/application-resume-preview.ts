/** A resume preview must read the current application, rather than promise a running browser. */
export interface ResumePreviewItem {
	applicationId: string | null;
	status: string;
	stateVersion: number | null;
	fillRunId: string | null;
	fillRun: { status: string } | null;
	questions: string[];
	actions: string[];
}

export function applicationResumePreview(input: Record<string, unknown>, item?: ResumePreviewItem): { error?: string; effect?: string; outcome?: string } {
	if (!item || item.applicationId !== input.application_id) return { error: "No matching application was returned; resume cannot be previewed." };
	if (item.status !== input.expected_status || (input.expected_version !== undefined && item.stateVersion !== input.expected_version)) return { error: "stale: reload the application before resuming or saving answers." };
	if (!item.actions.includes("resume")) return { error: `This application in ${item.status} does not permit resume or answer saving.` };
	if (item.fillRun?.status === "paused") return { outcome: "resume_paused_run", effect: "Answers would be stored and delivered to the existing paused run, and its resume would be requested. Any allowed site applies only to this run. The resulting run status is determined by the runner." };
	if (item.fillRun || item.status !== "blocked" || !item.fillRunId || !item.questions.length) return { error: "There is no paused run or ended blocked application with questions to answer." };
	if (input.expected_version === undefined) return { error: "expected_version is required to save answers for an ended run." };
	if (Array.isArray(input.allow_domains) && input.allow_domains.length) return { error: "An ended run cannot receive a website grant; omit allow_domains." };
	const answers = input.answers as Array<{ question: string; answer: string }> | undefined;
	if (!answers?.length || answers.length > 20 || new Set(answers.map((a) => a.question)).size !== answers.length || answers.some((a) => !item.questions.includes(a.question) || !a.answer.trim() || a.answer.trim().length > 2000)) return { error: "Supply 1–20 distinct answers to the application's recorded questions, each containing 1–2000 characters." };
	return { outcome: "answers_saved", effect: "Answers would be saved for the next separately authorized run. The ended run would not resume. No browser would start and no submission would be requested." };
}
