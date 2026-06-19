# Job Application Assistant

A ProAgentStore agent that accepts a job URL, extracts the posting, prepares a tailored application packet, and submits only when the target exposes a simple safe form and the caller gives explicit confirmation.

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
      "fullName": "Sam Candidate",
      "email": "sam@example.com",
      "phone": "+1 555 0100",
      "linkedin": "https://linkedin.com/in/sam",
      "portfolio": "https://sam.dev",
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

This agent does not silently send resume/contact data. It prepares the packet first, reports blockers, and requires the exact `submit <application-id>` confirmation before any external POST/GET submission attempt.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```
