# syntax=docker/dockerfile:1
FROM node:22-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY . .

# Delt pnpm-lager mellom bygg og mellom images. Uten dette laster hvert image ned
# alle ~1578 pakkene på nytt fra npm, hver gang.
RUN --mount=type=cache,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

RUN pnpm turbo build

ENV PORT=80

EXPOSE $PORT
CMD [ "pnpm", "--filter", "bff", "run", "start" ]
