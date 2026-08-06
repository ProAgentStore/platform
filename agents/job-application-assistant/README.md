# Job Application Assistant

A rentable ProAgentStore agent that helps a user turn a job URL into an application packet and, when allowed, submit through the user's local ProAgentStore browser runtime.

The marketplace/runtime path is LLM-driven and browser-runtime-backed:

```text
subscribe_agent -> upload_resume -> apply_to_job -> instance_board / instance_task_events
```

The workflow brain runs in the ProAgentStore control plane and drives the user's local browser runtime through `/browser/snapshot` and `/browser/act`. Candidate details come from the user's Profile and the instance's stored resume. By default `apply_to_job` does a safe fill-only run and stops before the final submit click; `submit: true` requires destructive MCP scope.

## Rent And Use Through MCP

After subscribing to the published agent, start the local runner and launch the apply workflow:

```bash
pags up
```

Then use the MCP tools:

```text
subscribe_agent
upload_resume
apply_to_job with submit=false   # safe fill-only test run
apply_to_job with submit=true    # real submission; destructive scope required
instance_board
instance_task_events
```

## Direct Worker API

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check and endpoint list |
| `GET` | `/profile` | Read saved candidate profile |
| `PUT` | `/profile` | Save candidate profile fields |
| `POST` | `/applications` | Analyze a job URL and create an application packet |
| `POST` | `/run` | Alias for `/applications` for generic tool callers |
| `GET` | `/applications` | List recent application packets |
| `GET` | `/applications/:id` | Read one application packet |
| `POST` | `/applications/:id/submit` | Submit a safe basic HTML form after explicit confirmation |

## Create an application packet

```bash
curl -X POST https://job-application-assistant.proagentstore.online/applications \
  -H "Content-Type: application/json" \
  -d '{
    "jobUrl": "https://example.com/jobs/senior-product-engineer",
    "profile": {
      "fullName": "Test Candidate",
      "email": "candidate@example.com",
      "phone": "+1 555 0100",
      "linkedin": "https://linkedin.example/test-candidate",
      "portfolio": "https://portfolio.example",
      "resumeText": "Senior full-stack engineer...",
      "location": "Remote"
    },
    "answers": {
      "work authorization": "I am authorized to work in the United States.",
      "salary": "$180k target total compensation"
    }
  }'
```

The response includes `draft.coverLetter`, `draft.shortPitch`, `draft.answers`, detected form fields, and `submission.ready`.

## Submit with confirmation

For simple job boards with a direct HTML form:

```bash
curl -X POST https://job-application-assistant.proagentstore.online/applications/app_123/submit \
  -H "Content-Type: application/json" \
  -d '{"confirmation":"submit app_123"}'
```

Submission is blocked when the page needs login, captcha, file upload, password fields, JavaScript-only flow, or multi-step browser work.

## Safety model

This agent does not silently send resume/contact data. The MCP path defaults to fill-only (`submit=false`) and requires destructive scope for real submission. The direct Worker API prepares the packet first, reports blockers, and requires the exact `submit <application-id>` confirmation before any external POST/GET submission attempt.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```
