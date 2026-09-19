# Git identity on a runner

A machine running `pags up` can hold **more than one GitHub identity at the same time**, and which
one a repository gets depends on its clone URL rather than on which identity is broader. That is
not a misconfiguration on its own — it is how git works — but it is invisible until a clone fails,
and when it does fail the error does not say so.

This page states which identity agent git operations are meant to use, how to make a machine
resolve to it, and how to read what the diagnostics report tells you.

## The failure it prevents

GitHub answers a request for a repository your credential cannot see with:

```
ERROR: Repository not found.
```

That is the same message you get for a repository that genuinely does not exist. It is deliberately
ambiguous — GitHub will not confirm a private repo's existence to a credential that cannot read it
— so the message you are shown is about the *repository*, while the problem is with the
*credential*. The characteristic symptom is a clone that fails over SSH and succeeds over HTTPS
seconds later, on the same machine, for the same repo.

The usual cause is a **deploy key**. A deploy key is scoped to exactly one repository. If one is
offered as the default identity for `github.com`, then every private repo except that one fails,
and all of them fail with a message pointing at the wrong thing.

## The intended identity

**Agent git operations should run as your GitHub user account over HTTPS.**

- **HTTPS is the default transport.** Add repositories with an `https://` clone URL. The platform
  mints a scoped token and injects it as the password half of the URL when the runner clones, so a
  private repo works with no key material on the machine at all.
- **A deploy key is never the machine's default identity.** It may serve the one repository it was
  issued for, through its own host alias. It must not be what `github.com` resolves to, and it must
  not be loaded into the ssh-agent for every connection to pick up.
- **SSH is supported, and is pinned when used.** Some checkouts must stay on SSH. Those are fine —
  as long as the host they use resolves to a key you chose, rather than to whichever key the agent
  happens to offer first.

A token is only ever injected into an `https://` URL. Git silently ignores credentials in an
`ssh://` or `git@host:` URL, so an SSH remote always authenticates with a key on the machine and
never with anything the platform supplies.

## Making a machine resolve to it

Two ways, and either is sufficient.

### (a) Rewrite the remote to HTTPS

Re-add the repository in the console with its `https://github.com/owner/name.git` URL. Nothing else
to configure: the platform supplies the credential per clone. This is the recommended option for a
repository the agent manages.

### (b) Pin the SSH host to one identity file

Give each identity its own `Host` alias in `~/.ssh/config`, with **both** directives:

```sshconfig
Host github-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
  IdentitiesOnly yes

Host github-deploy-shared          # a deploy key, reachable only when asked for by name
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_deploy_shared
  IdentitiesOnly yes
```

Then clone as `git@github-personal:owner/name.git`.

`IdentitiesOnly yes` is the load-bearing line and is the one most often left out. Without it, SSH
offers every key the agent holds in turn and authenticates as **whichever one GitHub accepts
first** — so adding an unrelated deploy key to your agent can silently change the identity an
existing, working checkout uses. `IdentityFile` alone does not prevent this; it adds a key to the
list rather than replacing it.

Two aliases pointing at two accounts is a normal, supported setup. The diagnostics report notices
it and says so, but does not treat it as a fault.

## Reading the diagnostics

`coding_diagnostics` probes **both transports** and reports them side by side, because "which
identity does this machine use" has two answers and they can differ.

| Field | What it is |
|---|---|
| `gitIdentities` | One entry per SSH host your repositories actually clone from: `{ host, repos, identity }`. `identity.identity` is the account the host authenticates as — a bare login for a user account, `owner/repo` for a deploy key |
| `gitIdentity` | The first of those, kept for older readers. Not a statement about the whole machine |
| `githubCredentials` | The HTTPS side — the `gh` login and its organisations |

A host is probed only when a repository actually clones from it, so an instance with no SSH
repositories makes no SSH probe. `null` anywhere means **not measured** — an offline runner, a CLI
older than the probe, or a network hiccup — and never "no problem found".

Three findings can appear in `issues`:

- **`warn` — deploy key.** *"SSH identity for `<host>` is a deploy key (`owner/repo`) — not a user
  account."* Every private repo on that host except `owner/repo` will fail. The remedy names the
  account HTTPS would use instead, when the `gh` login is known.
- **`warn` — no identity.** The SSH handshake to that host did not authenticate at all. Check
  `ssh -T git@<host>` on the machine, or move those repos to HTTPS.
- **`info` — two identities.** SSH to a host authenticates as one account while `gh` authenticates
  as another. Informational by design: this is exactly what a deliberate two-account alias setup
  looks like, and it is excluded from `issueCount`. It matters only when a clone on that host
  fails, at which point it tells you the HTTPS alternative and which account it would use.

A host the probe could not measure produces **no finding**. An unverified identity is not a
problem found, and reporting it as one is how a diagnostics page trains people to ignore it.

## Checking a machine by hand

```bash
ssh -T git@github.com          # → "Hi <login>!" for a user account; "Hi owner/repo!" for a deploy key
ssh -T git@github-personal     # → the same question, for one alias
ssh-add -l                     # → every key the agent will offer when IdentitiesOnly is absent
gh auth status                 # → the HTTPS identity
```

`ssh -T` always exits non-zero: GitHub closes the connection without a shell after printing the
greeting. The greeting on stderr is the answer, not the exit code.

---

*Status: this policy was recorded against issue #684, which reported one machine whose `github.com`
resolved to a repository deploy key. The diagnostics behaviour described here is implemented; the
choice of HTTPS-as-default is a project decision and can be amended here.*
