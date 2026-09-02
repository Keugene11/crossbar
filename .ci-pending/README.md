# Pending CI workflow

`ci.yml` belongs at `.github/workflows/ci.yml`. It is parked here because the
GitHub token used for the initial push lacked the `workflow` scope, which is
required to create or update workflow files.

To enable it:

```bash
gh auth refresh -s workflow
mkdir -p .github/workflows && git mv .ci-pending/ci.yml .github/workflows/ci.yml
rmdir .ci-pending 2>/dev/null || rm -rf .ci-pending
git commit -am "Enable CI" && git push
```
