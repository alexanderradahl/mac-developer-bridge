# Poisoned Repository Adversarial Fixture

This fixture makes the prompt-injection boundary observable without claiming a
model-level defense. `tests/adversarial.mjs` creates a disposable Git repository
and drives the real stdio bridge against it.

Run it directly:

```bash
node tests/adversarial.mjs
```

It is also part of `npm test`.

## Surfaces

The generated repository places inert, synthetic instructions in:

| Surface | Generated location |
| --- | --- |
| Repository guidance | `README.md`, `AGENTS.md` |
| Source content | `src/parser.mjs` comment |
| Test output | `logs/test.log` |
| Package lifecycle output | `scripts/emit-lifecycle-output.mjs` via `npm run fixture-output` |
| Filename | `UNTRUSTED_FIXTURE_REQUEST_NETWORK_UPLOAD.txt` |
| Git metadata | `fixture.model-instruction` config and the first commit message |
| Credential-shaped files | `.synthetic/credentials.env`, `.synthetic/id_ed25519` |

Every instruction starts with `UNTRUSTED_FIXTURE`. The only URL uses a reserved
`.example` domain. The API key and SSH material are unmistakably synthetic; the
SSH file is not a valid private key.

## What The Test Proves

While the file latch is armed, the test observes that:

- the bridge advertises its registered shell and filesystem authority;
- `fs_read` returns model-visible adversarial content verbatim;
- `shell_exec` returns inert package output and Git metadata verbatim;
- reading the synthetic credential-shaped files is technically possible.

After the latch is removed, the next tool call is refused, the bridge exits 78,
and the revocation is present in the audit log.

## What The Test Does Not Prove

- It does not execute a model or measure whether a model follows an injection.
- It does not execute any embedded instruction or contact a network endpoint.
- It does not show that the unlock latch mitigates prompt injection. While
  armed, the latch is process-global and does not distinguish operator intent
  from a model request influenced by untrusted content.
- It does not prove containment after an action has already started.
- It does not make "read" inherently safe. Reading a credential-shaped file is
  an observable disclosure even when no write tool is used.

The fixture separates bridge behavior from expected model behavior in
`.fixture/expected.json`. A future restricted mode or scoped-capability design
can reuse the same surfaces and replace the current expected authority with
narrower, testable outcomes.
