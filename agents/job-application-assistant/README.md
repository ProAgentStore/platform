# Job Application Assistant

A rentable ProAgentStore agent that helps a user turn a job URL into an application packet and, for basic resume-upload forms, submit through the user's approved FAGS browser runtime.

The marketplace/runtime path is FAGS-browser-runtime-first:

```text
subscribe_agent -> register_instance_runtime -> run_instance_task(type: job.apply_basic) -> approve_instance_task -> instance_task_events
```

The task runs on the user's FAGS runtime, not in the platform account. The user provides the resume file path and candidate details, and submission is approval-gated by the FAGS runtime.

## Rent And Use Through MCP

After subscribing to the published agent, connect or register the FAGS runtime and create an approved job application task:

```bash
pags runner connect "$PAGS_INSTANCE_ID" --pags-token "$PAGS_TOKEN" --headless
pags runner run "$PAGS_INSTANCE_ID" \
  --type job.apply_basic \
  --input '{"url":"https://example.com/jobs/senior-engineer","resumePath":"/path/to/resume.pdf","candidate":{"fullName":"Test Candidate","email":"candidate@example.com","phone":"+1 555 0100","location":"Remote"},"coverNote":"I am interested in this role."}' \
  --pags-token "$PAGS_TOKEN"
pags runner approve-task "$PAGS_INSTANCE_ID" "$TASK_ID" --pags-token "$PAGS_TOKEN"
```

The same flow is available through MCP tools:

```text
subscribe_agent
register_instance_runtime
run_instance_task with type=job.apply_basic
approve_instance_task
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

This agent does not silently send resume/contact data. The rentable FAGS runtime path creates `job.apply_basic` tasks in `needs_approval` state and submits only after the user approves the task. The direct Worker API prepares the packet first, reports blockers, and requires the exact `submit <application-id>` confirmation before any external POST/GET submission attempt.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```
