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
2. **You sign in once** in that same browser through the existing sign-in handoff, then resume. The run
   records which cookies appeared, then reopens the job page and carries on.
3. **Later runs** check those cookies and press without asking.

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
  values and session ids are never written to a run's trace.
