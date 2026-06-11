export function writeLine(message = ""): void {
	process.stdout.write(`${message}\n`);
}

export function writeError(message = ""): void {
	process.stderr.write(`${message}\n`);
}
