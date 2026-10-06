FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
RUN addgroup -g 1001 -S app && adduser -S app -u 1001
WORKDIR /app
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/src/database/migrations ./src/database/migrations
USER app
EXPOSE 3000
# `--import ./dist/src/register-instrumentation.js` enables OTel auto-
# instrumentation for the Claude Agent SDK via IITM. See that file's header
# for why this is needed instead of in-code `manuallyInstrument()`.
CMD ["sh", "-c", "npx dbmate --migrations-dir src/database/migrations --no-dump-schema up && node --import @opentelemetry/instrumentation/hook.mjs --import ./dist/src/register-instrumentation.js dist/src/main.js"]
