# Public release setup

The public source repository is `VectorMethods/n8n-nodes-videovector`. The npm
package is `@vectormethods/n8n-nodes-videovector`; the initial version is `1.0.0`
and its release tag is `videovector-n8n-v1.0.0`. Repository setup and publication
use the company's Public Repo Bot controls. Personal-account public pushes and
manual npm publication are outside this release path.

## Company repository and source

1. Merge the reviewed private integration and its publication controls into the
   private control repository's protected `main`. Its exact push revision must
   pass **Required CI** before the owner can approve a public operation.
2. In the private control repository's protected `public-repo-bot` environment,
   configure `PUBLIC_SOURCE_REPO_N8N=VectorMethods/Playground_backend` and
   `PUBLIC_SOURCE_SUBDIR_N8N=n8n`. The same-repository source uses the workflow's
   read token. A source in another private repository needs `PUBLIC_SOURCE_READ_TOKEN`.
3. Dispatch Public Repo Bot with `repo=n8n-nodes-videovector`, `mode=bootstrap`,
   `source_location=configured`, the reviewed source revision, `target_ref=main`,
   an empty operation payload, and `force=false`. This mode requires the target
   repository to be absent and binds that precondition, company identity,
   exact scanned source, and canonical governance to the owner approval digest.
4. Retain the existing App client ID, App ID, private key, and private identity
   admission pattern in the protected environment. After approval, the App creates
   a private company repository with no generated commit. GitHub automatically
   grants the creating installation access. A new token scoped to that repository
   installs the sanitized initial `main`, applies required **Node checks** and
   **Secret scan**, protected `main`, create-only `videovector-n8n-v*` tag rules,
   enabled Actions/release workflow, and immutable Releases, then makes it public.
   Every token is revoked after use. The receipt records the new repository ID.
5. Record that repository ID in the control plane's pinned repository identities
   before routine `pr`/`merge` updates. Bootstrap refuses existing targets,
   including a partially completed bootstrap: preserve its receipt and reconcile
   its exact repository ID and candidate before approving recovery. The existing
   reset operation is not a bootstrap or recovery shortcut. Routine updates use
   the reviewed `pr` and `merge` operations; never push the private monorepo to the
   public repository.

Every mutating bot operation first prepares and scans its concrete candidate.
The owner then approves the exact operation digest in the private control
revision's commit comment after Required CI succeeds. The approval command comes
from the bot's preparation receipt. Changing source, target, inputs, policy,
or protected-main revision invalidates that approval. Use the private bot
runbook for the full authorization procedure.

## npm publication

The company npm account must control the `@vectormethods` scope and have
permission to publish this public package. Configure these exact trusted
publisher values in the package settings:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization | `VectorMethods` |
| Repository | `n8n-nodes-videovector` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed actions | Direct `npm publish` and `npm dist-tag` management |

Create the public repository's protected **npm** environment, restricted to
`videovector-n8n-v*` tags, before the first publication. The workflow uses
GitHub-hosted runners and `id-token: write`. Its reviewed publisher is npm
11.15.0 on Node.js 24.21.0. The dist-tag permission is necessary because the
release helper advances `latest` or `next` and removes its temporary tag.
New trusted publisher configurations must complete a successful first publish
within two days. [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)

If a first package cannot yet receive a trusted publisher configuration, place
a short-lived company npm token with access to the scope/package in the **npm**
environment as `NPM_TOKEN`. Use the same approved release workflow for that
first publish, then configure trusted publishing and remove the bootstrap token.
The workflow builds and stages an immutable bundle before npm credentials are
available; publishers and retries consume only that staged artifact.

Request the release through the private Public Repo Bot with `repo` set to
`n8n-nodes-videovector`, `mode` set to `release`, `target_ref` set to `main`, and
the reviewed tag, release name, and release notes in `operation_payload`. The
controller verifies source/tag identity, provenance, live npm artifact bytes,
and dist-tags before finalizing the GitHub Release.

## n8n catalog

After the public npm package and repository exist, submit the package for n8n
community verification through the company’s n8n creator account. Include the
public source URL, documentation, credential setup, and working workflow
examples. Catalog approval is separate from npm publication and enables native
installation on n8n Cloud. Self-hosted users can install the published npm
package, and Cloud users can run the built-in HTTP and standalone MCP templates
with their VideoVector API credential while catalog review is pending.
