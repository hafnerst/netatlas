# Security policy

## Supported versions

NetAtlas is before its first production release. Security fixes go into
`dev` and ship with the next release. Only the
[latest release](https://github.com/hafnerst/netatlas/releases/latest) is
supported, and an older one gets no separate fix.

## Reporting a vulnerability

Please report it privately. Do not open a public issue or pull request.

Use GitHub's private vulnerability reporting: the repository's **Security**
tab → **Report a vulnerability**. The report and the conversation about it
stay visible only to you and the maintainer until an advisory is published.

Please include:

* the version (next to the name at the top left of the page) and the
  browser;
* the steps or a model file that shows the problem, as small as you can make
  it;
* what an attacker gains.

You will get an answer as soon as the maintainer can look at it. The fix is
then agreed with you. You are credited in the advisory unless you prefer not
to be.

## What counts

NetAtlas is a single offline HTML file. A model file you open is untrusted
input (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). Report these:

* a model file, pasted YAML or anything typed in the editor that runs script,
  creates elements or attributes it should not, or gets past the page's
  Content Security Policy;
* the page making a network request, or reading a file the user did not
  choose;
* a model that makes the page hang or exhaust memory despite the documented
  input limits;
* a release asset that does not match its source, its `SHA256SUMS` or its
  provenance attestation;
* a workflow in `.github/workflows` that exposes a token, runs untrusted code
  with write access, or can push, tag or publish without the maintainer.

Not vulnerabilities: inaccurate simulation or analysis results, and the
simplifications listed in [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Report
those as ordinary issues.
