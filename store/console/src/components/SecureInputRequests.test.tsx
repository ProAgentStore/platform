import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SecureInputRequests from "./SecureInputRequests";
import * as sdk from "@proagentstore/sdk/client";

vi.mock("@proagentstore/sdk/client", () => ({
	api: vi.fn(),
}));

describe("SecureInputRequests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders nothing when no requests", async () => {
		const mockApi = vi.mocked(sdk.api);
		mockApi.mockResolvedValueOnce({ requests: [] });

		const { container } = render(<SecureInputRequests instanceId="inst-1" />);

		await waitFor(() => {
			expect(container.firstChild).toBeEmptyDOMElement();
		});
	});

	it("renders pending requests with password input", async () => {
		const mockApi = vi.mocked(sdk.api);
		mockApi.mockResolvedValueOnce({
			requests: [
				{
					id: "req-1",
					status: "pending",
					label: "Firebase Code",
					purpose: "Deploy verification",
					destinationScope: "env",
					oneShot: true,
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					createdAt: new Date().toISOString(),
				},
			],
		});

		render(<SecureInputRequests instanceId="inst-1" />);

		await waitFor(() => {
			expect(screen.getByText("Firebase Code")).toBeInTheDocument();
			expect(screen.getByText("Deploy verification")).toBeInTheDocument();
		});
	});

	it("disables submit when value is empty", async () => {
		const mockApi = vi.mocked(sdk.api);
		mockApi.mockResolvedValueOnce({
			requests: [
				{
					id: "req-1",
					status: "pending",
					label: "Auth Code",
					destinationScope: "env",
					oneShot: true,
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					createdAt: new Date().toISOString(),
				},
			],
		});

		render(<SecureInputRequests instanceId="inst-1" />);

		await waitFor(() => {
			const button = screen.getByRole("button", { name: /Submit value/ });
			expect(button).toBeDisabled();
		});
	});

	it("submits value and reloads requests", async () => {
		const mockApi = vi.mocked(sdk.api);
		mockApi.mockResolvedValueOnce({
			requests: [
				{
					id: "req-1",
					status: "pending",
					label: "Auth Code",
					destinationScope: "env",
					oneShot: true,
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					createdAt: new Date().toISOString(),
				},
			],
		});
		mockApi.mockResolvedValueOnce({ ok: true });
		mockApi.mockResolvedValueOnce({ requests: [] });

		const user = userEvent.setup();
		render(<SecureInputRequests instanceId="inst-1" />);

		await waitFor(() => {
			const input = screen.getByDisplayValue("");
			expect(input).toBeInTheDocument();
		});

		const input = screen.getByDisplayValue("");
		await user.type(input, "my-secret-value");

		const button = screen.getByRole("button", { name: /Submit value/ });
		await user.click(button);

		await waitFor(() => {
			expect(mockApi).toHaveBeenCalledWith(
				"/v1/instances/inst-1/secure-inputs/req-1/submit",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ value: "my-secret-value" }),
				}),
			);
		});
	});

	it("shows ready status when status is ready", async () => {
		const mockApi = vi.mocked(sdk.api);
		mockApi.mockResolvedValueOnce({
			requests: [
				{
					id: "req-1",
					status: "ready",
					label: "Auth Code",
					destinationScope: "env",
					oneShot: true,
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					createdAt: new Date().toISOString(),
				},
			],
		});

		render(<SecureInputRequests instanceId="inst-1" />);

		await waitFor(() => {
			expect(screen.getByText(/Ready for injection/)).toBeInTheDocument();
		});
	});
});
