# Application browser profiles (#1094)

An Application Runner fill run (`runtime: "local_apply"`) drives a browser on your machine. Since #1094
that browser **remembers its sign-ins between runs**, like your own browser does. Sign in to a site such
as SEEK once, through the run's sign-in handoff, and later runs on the same machine and profile reuse
that session.

## Where it lives

`<dataDir>` is `~/.config/proagentstore/browser-runner` unless you set `--data-dir` or
`PAGS_RUNNER_DATA_DIR`.

| Path | What it is |
|---|---|
| `<dataDir>/application-profiles/isolated/browser/` | The `isolated` profile's browser data (cookies, local storage). A dedicated Chrome profile: never seeded from, copied to or shared with your everyday browser. |
| `<dataDir>/application-profiles/<profile>/site-sessions.json` | Which sites this profile is signed in to. |
| `<dataDir>/chrome-profile/` (or `real-profile-copy/`) | The `default` profile's browser data. This is the runner's own browser, which already persisted before #1094. |

Before #1094, an `isolated` run used a throwaway `runs/<id>/profile` directory that was deleted with the
run, so every SEEK run started signed out and bounced to the sign-in page.

**To sign out everywhere,** delete `application-profiles/<profile>/` while no application run is going.
The next run asks you to sign in again.

## `site-sessions.json`

This is plain JSON you can read. For each site (a registrable domain such as `seek.com`) it holds:

- `state`: `sign_in_needed` or `signed_in`;
- `basis`: why the site is listed (`bounced_to_sign_in` or `owner_signed_in`; SEEK needs no entry to be asked about);
- `loginHost`: the hostname a press bounced to (no path, no query);
- `cookieNames`: the **names** of the cookies that appeared when you signed in;
- `verifiable`, `signedInAt` and `updatedAt`.

It **never** holds a cookie value, a password, a URL query or anything you typed. The session itself
lives only in the browser profile.

## How a run uses it

1. **Before an uncertain press.** This is the "Quick apply"-style control that may send the application
   in one click. If the profile has no session for the site, the run **pauses `login_required`
   before pressing anything**. Nothing has been submitted at that point. The pause happens when:
   - the site is SEEK (`seek.com`, `seek.com.au`, `seek.co.nz`) and you have never signed in here;
   - an earlier press bounced to the site's sign-in page; or
   - a session cookie recorded at sign-in is gone or expired.
2. **Sign in on the same browser.** The supported agent-driven flow below attempts sign-in first;
   if it needs the owner, use the bounded handoff and resume. The run records which cookies appeared,
   then reopens the job page and carries on.
3. **Later runs** check those cookies and press without asking.

## Authentication sequence required by the owner

The 6 November 2026 directive is: reuse an existing session for the intended account, try the existing
site credential, recover/reset an existing account through the site's flow and the connected pinned
Gmail when necessary, and create an account only when none exists. Complete the new account's email
verification through that Gmail connection and confirm its signed-in identity before continuing.
A missing vault credential or a rejected password does not establish that no account exists.

The acting model interprets the live controls and responses. Do not implement employer-specific
selectors, answer maps or registration playbooks. Keep site permissions, credential-origin and identity
checks, protected secret handling, Stop, consent and submission permission. Match recovery mail to the
intended identity, site and current request; do not reuse stale messages. CAPTCHA, required owner consent
or legal acceptance, unsupported security steps and missing personal facts require a bounded handoff.
Authentication never grants permission to submit the application.

## Current authentication capability (CLI 0.4.229)

Agent-driven sign-in (#1412) replaced the fixed password, emailed-code and account-creation macros;
the old macros and `account-creation-hosts.json` were removed in #1422. The current cloud broker is
`workers/api/src/lib/local-apply/agent-sign-in.ts`:

- On an eligible `login_required` pause, it first looks for an existing vault username/password
  matching the paused host. A match makes a sign-in attempt possible, not guaranteed successful.
- Without that credential, only the supported SEEK hosts can receive username-only provisioning
  from `signInEmail`, with email access permitted. This is not generic email-first sign-in for every ATS.
- The broker sends named secret placeholders to the runner for the paused origin. The model drives
  ordinary browser tools using those placeholders; secret values are substituted at execution.
  Passwords, codes and recovery links must not appear in chat, model output, traces or documents.
- When that sign-in requests an emailed code, the current Gmail path reads one matching message for
  a 4–8 digit sign-in code, with a five-minute wait. The Gmail connection must be permitted and pinned
  to the intended account. This is not a generic reset-link or verification-link broker.
- The broker records one sign-in attempt per run, its host, credential/message references and outcome.
  The runner's observed sign-in result is needed before the flow is treated as successful. Failed or
  unsupported sign-in reports a reason and offers the owner handoff when available.

**Account registration and password reset (#1619).** `accountCreation` is the owner's standing
authorization, default `false`, frozen into each run as `policy.accountOperations` (#1533). When it is
on and the run has no saved login, the broker answers `request_sign_in` at once with the Profile
address (the pinned Gmail, which must match the Profile email) and no password. The agent then decides
from the live page: `request_new_password` provisions `PAGS_NEW_PASSWORD`, a generated password held as
a provisional vault row before it is typed; `request_sign_in_link` opens the fresh, same-site reset or
verification link read from Gmail in the page without ever showing it to the model. `finish_sign_in`
with `signedIn: true` (the model's own observation, not independent proof) confirms the registration
or moves the password onto the replaced vault row. One new password and one link per run; CAPTCHA, MFA
and unaccepted terms still go to the owner. Without the authorization and a saved login, the owner
handoff remains.

See the [runtime user manual](../../platform-docs/browser-runtime.md#signing-in-recovering-access-and-creating-an-account)
and [browser-agent design contract](../../docs/browser-agent-design.md) for the target behavior and
evidence requirements. A persistent session or accepted Full Playwright mode does not fill these
broker gaps or prove that no other website action occurred.

**If the run ended before you signed in (#1100).** A sign-in pause lasts only as long as the run, and a
run that runs out of time ends `blocked` (`login_required`). Taking over its board card then opens
**this profile** at the job's page, with no run behind it. Sign in there and press Resume: the sign-in
is recorded the same way, and the application is filled again. This is refused while an application
run is using the profile, and only one such sign-in can be open per profile.
An ended attempt with uncertain submission effects still needs the exact-attempt reconciliation
required by the [browser-agent design contract](../../docs/browser-agent-design.md); signing in does
not establish that replay is safe or authorize another application.

## Limits

- **A session the site revoked while its cookie is still present cannot be seen** before pressing. That
  press lands on a sign-in page and ends `submit_unconfirmed`, as before: a redirect is never taken as
  proof that nothing was sent (#1013). The site is then marked `sign_in_needed`, so the **next** run asks
  you to sign in first.
- **A sign-in that adds no new cookie** (you were already signed in) is kept with `verifiable: false`.
  Later checks then rely on the bounce learning above.
- **If a site keeps its sign-in only in browser-session cookies**, those do not survive a browser
  restart. Each run would then ask you to sign in again. That is reported, not hidden.
- **One run at a time per profile.** A second run on a profile that is in use is refused with a plain
  message.
- **Traces store page URLs as origin and path only (#1069).** A sign-in page's OAuth state, nonce, PKCE
  values and session ids are never written to a run's trace. The same rule covers a confirmed submit's
  page and an unavailable posting's page in a fill result, and the Scout's research trace (whose
  findings keep their own links whole: a finding's URL is the lead). It applies on the runner before
  anything leaves the machine, again in the cloud when the event is parsed, and on every READ, so rows
  recorded before the fix are reduced when shown without being rewritten or purged.
