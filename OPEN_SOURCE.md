# Open-source policy

- Status: Approved
- Approved: 2026-09-04
- Approver: Louis Morgner (`@louismorgner`), repository owner
- Decision record: [PRO-212](https://linear.app/actaso/issue/PRO-212/decide-and-formally-approve-final-oss-license-before-going-public)

## License decision

opencompany is licensed under the [MIT License](./LICENSE). This is the final project-license
decision for the initial public release, not a placeholder inherited from repository setup.

MIT keeps the source usable for personal, commercial, hosted, and modified distributions with one
simple condition: copies or substantial portions must retain the copyright and permission notice
in `LICENSE`. It matches the project's goal of broad adoption without imposing a reciprocal source
release obligation.

This decision applies only to material that opencompany has the right to license. It does not
replace the repository's separate provenance and redistribution audit. Material identified in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), package-manager dependencies, and any file with
its own license remains subject to those terms.

## Notices

MIT does not require a project-level `NOTICE` file, so the repository does not use one.
`THIRD_PARTY_NOTICES.md` records known material copied into the tree and the notices that must be
preserved. Dependencies installed through a package manager keep the license information shipped
in their packages.

## Trademarks

The MIT license covers copyright permissions, not branding. Use of the opencompany name, logos,
and other brand identifiers is governed by [TRADEMARKS.md](./TRADEMARKS.md). Third-party names and
logos remain the property of their respective owners.

## Contributions

Contributions use an inbound-equals-outbound model: unless a separate written agreement says
otherwise, a contribution intentionally submitted to this repository is licensed under MIT on the
same terms as the project. Contributors retain ownership of their work and must have the right to
submit it. The project does not require a contributor license agreement or Developer Certificate of
Origin sign-off at this time; the full terms are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Change control

A future license change requires a separate repository-owner decision plus legal and provenance
review. It must not be bundled into routine engineering cleanup.
