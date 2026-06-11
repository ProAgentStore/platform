import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "../types.js";

// Active Workers AI model IDs as of mid-2026
// Source: https://developers.cloudflare.com/workers-ai/models/
const VALID_MODELS = new Set([
	// Text generation / LLMs
	"@cf/meta/llama-3.2-1b-instruct",
	"@cf/meta/llama-3.2-3b-instruct",
	"@cf/meta/llama-3.2-11b-vision-instruct",
	"@cf/meta/llama-3.2-90b-vision-instruct",
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/meta/llama-3.1-8b-instruct",
	"@cf/meta/llama-3.1-70b-instruct",
	"@cf/meta/llama-2-7b-chat-int8",
	"@cf/meta/llama-2-7b-chat-fp16",
	"@cf/mistral/mistral-7b-instruct-v0.1",
	"@cf/mistral/mistral-7b-instruct-v0.2",
	"@cf/google/gemma-2b-it-lora",
	"@cf/google/gemma-7b-it-lora",
	"@cf/microsoft/phi-2",
	"@cf/qwen/qwen1.5-0.5b-chat",
	"@cf/qwen/qwen1.5-1.8b-chat",
	"@cf/qwen/qwen1.5-7b-chat-awq",
	"@cf/qwen/qwen1.5-14b-chat-awq",
	"@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
	"@cf/defog/sqlcoder-7b-2",
	"@cf/thebloke/discolm-german-7b-v1-awq",
	"@cf/tiiuae/falcon-7b-instruct",
	// Embeddings
	"@cf/baai/bge-small-en-v1.5",
	"@cf/baai/bge-base-en-v1.5",
	"@cf/baai/bge-large-en-v1.5",
	"@cf/baai/bge-m3",
	// Image classification
	"@cf/microsoft/resnet-50",
	// Object detection
	"@cf/facebook/detr-resnet-50",
	// Image generation
	"@cf/stabilityai/stable-diffusion-xl-base-1.0",
	"@cf/lykon/dreamshaper-8-lcm",
	"@cf/bytedance/stable-diffusion-xl-lightning",
	// Translation
	"@cf/meta/m2m100-1.2b",
	// Speech recognition (Whisper)
	"@cf/openai/whisper",
	"@cf/openai/whisper-tiny-en",
	"@cf/openai/whisper-sherpa",
	// Text-to-speech
	"@cf/myshell-ai/melotts",
	"@cf/aispeech/cosyvoice-zh",
	// Reranking
	"@cf/baai/bge-reranker-base",
	// Code generation
	"@hf/thebloke/deepseek-coder-6.7b-base-awq",
	"@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
	// Summarization
	"@cf/facebook/bart-large-cnn",
]);

// Deprecated model IDs that were once valid but should no longer be used
const DEPRECATED_MODELS = new Set([
	"@cf/meta/llama-2-13b-chat-fp16",
	"@cf/meta/llama-2-13b-chat-int8",
	"@cf/mistral/mistral-7b-instruct-v0.1-vllm",
]);

export async function checkModel(dir: string): Promise<CheckResult[]> {
	const manifestPath = path.join(dir, "agent.json");
	if (!fs.existsSync(manifestPath)) return [];

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch {
		return [];
	}

	if (!("model" in manifest)) {
		return [
			{
				name: "model-specified",
				pass: false,
				message: "No model field in agent.json",
				severity: "warning",
			},
		];
	}

	const model = String(manifest.model);
	const results: CheckResult[] = [];

	// Check deprecated first
	if (DEPRECATED_MODELS.has(model)) {
		results.push({
			name: "model-not-deprecated",
			pass: false,
			message: `Model "${model}" is deprecated — use a current llama-3.x or mistral model`,
			severity: "error",
		});
	} else {
		results.push({
			name: "model-not-deprecated",
			pass: true,
			message: `Model "${model}" is not deprecated`,
			severity: "info",
		});
	}

	// Check valid Workers AI model ID
	const isValid = VALID_MODELS.has(model);
	results.push({
		name: "model-valid-workers-ai",
		pass: isValid,
		message: isValid
			? `"${model}" is a valid Workers AI model`
			: `"${model}" is not a recognised Workers AI model ID`,
		severity: "warning",
	});

	return results;
}
