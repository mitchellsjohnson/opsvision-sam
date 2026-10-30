# Contributing to OpsVision

Thanks for helping out. Please follow the basics below.

## Running tests

Use the root Makefile:

```sh
make test       # run all tests
make lint       # run linters
make denylist   # run the name guard (see below)
```

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), for example
`feat: add monthly close endpoint` or `fix: correct rollup rounding`.

## Data and names

Never commit real company data, customer names, or confidential figures. Use
synthetic fixtures with fictional names (for example, "Contoso Widgets").

`make denylist` scans tracked files for terms listed in `$OPSVISION_DENYLIST`
or an untracked `.denylist` file. Run it before opening a pull request.

## Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
