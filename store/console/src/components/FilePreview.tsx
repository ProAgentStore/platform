/**
 * Console wiring for the shared preview block (#187): the bearer-token fetch, the console Button,
 * and a native alert for a failed download — everything the block leaves to its caller.
 */
import { FilePreview as FilePreviewBlock, type PreviewFile } from "@proagentstore/blocks";
import { API, getToken } from "@proagentstore/sdk/client";
import Button from "./Button";

export type { PreviewFile };

export default function FilePreview({ instanceId, file, onClose }: {
	instanceId: string;
	file: PreviewFile;
	onClose: () => void;
}) {
	return (
		<FilePreviewBlock
			file={file}
			onClose={onClose}
			Button={Button}
			onDownloadError={(message) => alert(message)}
			fetchBlob={async (f, purpose) => {
				const res = await fetch(`${API}/v1/instances/${instanceId}/files/${encodeURIComponent(f.id)}`, {
					headers: { Authorization: `Bearer ${getToken() ?? ""}` },
				});
				if (!res.ok) throw new Error(`${purpose === "download" ? "Download" : "Preview"} failed (HTTP ${res.status})`);
				return res.blob();
			}}
		/>
	);
}
