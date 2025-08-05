## Contributing

1. Please create a new issue [here](https://github.com/forcedotcom/cli/issues) before starting any work so that we can also offer suggestions or let you know if there is already an effort in progress.
1. Sign the Salesforce [CLA](#cla).
1. Follow the [Environment Setup](DEVELOPING.md#environment-setup) docs for instructions on configuring your machine.
1. Follow the [Development Cycle](DEVELOPING.md#development-cycle) docs for details on the development process.
1. The CLI team will review your pull request and provide feedback.
1. Once merged, a new release of the `NPM_PACKAGE_NAME` plugin will be published to [npm](https://www.npmjs.com/package/NPM_PACKAGE_NAME).

### CLA

External contributors are required to sign a Contributor License
Agreement. You can do so by going to https://cla.salesforce.com/sign-cla.

## Branches

- We work in branches off of `main`.
- Our release (aka. _production_) branch is `main`.
- Our work happens in _topic_ branches (feature and/or bug-fix).
  - Feature as well as bug-fix branches are based on `main`
  - Branches _should_ be kept up-to-date using `rebase`
  - Commit messages follow Conventional commits format ([see Quick Start](DEVELOPING.md#Quick-start))

## Pull Requests

- Develop features and bug fixes in _topic_ branches off main, or forks.
- _Topic_ branches can live in forks (external contributors) or within this repository (internal contributors).  
  - When creating _topic_ branches in this repository please prefix with `<initials>/`. For example: `mb/refactor-tests`.
- PRs will be reviewed and merged by the CLI team.

## Releasing

- A new version of this plugin (`NPM_PACKAGE_NAME`) will be published upon merging PRs to `main`, with the version number increment based on commitizen rules.
