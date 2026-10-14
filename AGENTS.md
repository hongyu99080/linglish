# Contributor instructions

- Keep changes focused and preserve existing application behavior unless the task requests a change.
- Use Node.js 22 or newer. Backend modules use CommonJS; frontend files are served directly.
- Run `npm test` from `app/backend` after changing behavior.
- Use only disposable local databases for integration tests.
- Do not commit credentials, personal information, absolute workstation paths, or runtime user content.
- Preserve third-party license files and attribution.
