FROM node:22-bookworm-slim AS build

WORKDIR /build

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM public.ecr.aws/lambda/nodejs:22

COPY --from=build /build/package.json ${LAMBDA_TASK_ROOT}/package.json
COPY --from=build /build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /build/dist/src ${LAMBDA_TASK_ROOT}/dist/src

CMD ["dist/src/runtimes/aws/runtime.httpHandler"]
