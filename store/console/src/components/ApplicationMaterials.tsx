import { useState } from "react";
import type { ApplicationArtifactHandle, ApplicationQueueItem } from "../lib/types";
import Button from "./Button";
import FilePreview from "./FilePreview";

/** A persisted receipt must describe this exact reviewed artifact, not just some uploaded file. */
export function storedApplicationMaterial(artifact: ApplicationArtifactHandle) {
	const cloud = artifact.cloud;
	return cloud && cloud.sha256 === artifact.sha256 && cloud.bytes === artifact.bytes
		&& cloud.instanceId && cloud.fileId && cloud.name && cloud.version ? cloud : null;
}

export default function ApplicationMaterials({ artifacts, profileVersion }: {
	artifacts: NonNullable<ApplicationQueueItem["artifacts"]>;
	profileVersion: string | null;
}) {
	const [preview, setPreview] = useState<ApplicationArtifactHandle | null>(null);
	const previewFile = preview ? storedApplicationMaterial(preview) : null;
	return (
		<div className="text-xs mb-2">
			<ul aria-label="Tailored materials" className="space-y-2">
				{[artifacts.resume, artifacts.coverLetter].filter((a): a is ApplicationArtifactHandle => !!a).map((artifact) => {
					const cloud = storedApplicationMaterial(artifact);
					return <li key={artifact.kind}>
						<p className="break-words"><span className="font-semibold">{artifact.kind === "resume" ? "Résumé" : "Cover letter"}:</span> {cloud ? cloud.name : <code>{artifact.path}</code>}</p>
						<p className="text-muted-soft">SHA-256 {artifact.sha256.slice(0, 12)}…</p>
						{cloud ? <div className="flex flex-wrap items-center gap-2 mt-1">
							<span>Stored in PAGS</span>
							<Button size="sm" onClick={() => setPreview(artifact)}>Preview / download</Button>
							<span className="text-muted-soft">Availability is checked again before each run.</span>
						</div> : <p className="text-warning mt-1">{artifact.cloud ? "The stored document receipt does not match this material. Generate materials again before using it." : "Local document from an earlier run. Upload your source documents to Application Tailor and generate materials again to save them in PAGS."}</p>}
					</li>;
				})}
			</ul>
			{profileVersion && <p className="text-muted-soft mt-2">From profile version {profileVersion}</p>}
			{previewFile && <FilePreview instanceId={previewFile.instanceId} file={{ id: previewFile.fileId, name: previewFile.name, size: previewFile.bytes }} onClose={() => setPreview(null)} />}
		</div>
	);
}
