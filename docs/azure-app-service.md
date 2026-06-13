# Azure App Service deployment

This Next.js app is configured for Azure App Service using Next.js standalone output.

## App Service settings

Use a Linux Node.js App Service with Node 20 LTS or newer.

Set the App Service startup command to:

```bash
npm run azure-start
```

If your App Service does not automatically run the build during deployment, set this app setting:

```text
SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

## Required app settings

Configure these in the Azure portal or with `az webapp config appsettings set` as needed by the enabled features:

- `PORT` is provided by Azure App Service.
- LLM provider credentials used by `src/server/routes/base-model/index.ts`.
- Azure Storage settings used by `src/server/routes/storage/index.ts`.
- Auth/database settings when those features are enabled.

## Local production check

```bash
npm install
npm run build
npm run azure-start
```
